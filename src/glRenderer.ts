// WebGL2 renderer for the scratch prototype.
//
// Compositing pipeline (per frame):
//   1. bottom video  -> screen, aspect-cover (fills canvas, crops overflow)
//   2. foreground video -> offscreen FBO, chroma-keyed in the fragment shader
//   3. tracked mesh triangles -> punch holes in that FBO wherever the UV-space
//      scratch texture is marked (multiplies dst alpha by 1 - scratch)
//   4. composite the FBO over the bottom video
//   5. optional mesh lattice overlay
//
// Scratches live in a persistent UV-space texture painted by `paintScratch`,
// so a hole rides the same patch of fabric the mesh tracks.

type Pt = { x: number; y: number };

export type GLMeshSample = {
  cols: number;
  rows: number;
  uv: Pt[];
  verts: Pt[];
  vis: number[];
};

const SCRATCH_TEX_BASE = 1024;
// Zoom applied to the presented layers (bottom video + final composite) for a
// tighter shot framed on the performer. It doubles as pan headroom: the
// chest-follow camera offset stays below PRESENT_ZOOM-1 so no canvas edge shows.
export const PRESENT_ZOOM = 1.15;
/** Cap devicePixelRatio so memory stays bounded on retina phones. */
export const MAX_PIXEL_RATIO = 2;

export type ImageLayerDepths = {
  back: number;
  mid: number;
  front: number;
};

export const PHOTO_LAYER_DEPTHS: ImageLayerDepths = {
  back: 1,
  mid: 0.6,
  front: 0.25,
};

export type ImageLayerCameras = {
  back: { x: number; y: number };
  mid: { x: number; y: number };
  front: { x: number; y: number };
};

function clamp(value: number, lo: number, hi: number) {
  return value < lo ? lo : value > hi ? hi : value;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error("shader compile failed: " + gl.getShaderInfoLog(shader) + "\n" + src);
  }
  return shader;
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string) {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error("program link failed: " + gl.getProgramInfoLog(p));
  }
  return p;
}

function makeTexture(gl: WebGL2RenderingContext, width: number, height: number) {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

function makeVideoTexture(gl: WebGL2RenderingContext) {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

type ImageSource = HTMLImageElement | HTMLVideoElement | HTMLCanvasElement;

function sourceDimensions(source: ImageSource): { w: number; h: number } {
  if (source instanceof HTMLVideoElement) {
    return { w: source.videoWidth, h: source.videoHeight };
  }
  if (source instanceof HTMLImageElement) {
    return { w: source.naturalWidth, h: source.naturalHeight };
  }
  return { w: source.width, h: source.height };
}

// Fullscreen-ish quad in [0,1]^2, drawn as a triangle strip.
const QUAD = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);

const BLIT_VS = `#version 300 es
in vec2 aPos;
uniform vec2 uScale;
uniform vec2 uOffset;
out vec2 vUV;
void main() {
  vUV = aPos;
  vec2 p = aPos * 2.0 - 1.0;
  gl_Position = vec4(p * uScale + uOffset, 0.0, 1.0);
}`;

const BLIT_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform bool uChroma;
out vec4 frag;
void main() {
  vec4 c = texture(uTex, vUV);
  if (uChroma) {
    float dominance = c.g - max(c.r, c.b);
    if (c.g > 0.51 && dominance > 0.149) {
      c.a = max(0.0, 1.0 - dominance * 6.0);
    }
  }
  frag = c;
}`;

// Composite an FBO color texture (already canvas-space) over the screen.
const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
out vec4 frag;
void main() { frag = texture(uTex, vUV); }`;

const PUNCH_VS = `#version 300 es
in vec2 aPos;   // canvas pixels
in vec2 aUV;    // garment uv
uniform vec2 uCanvas;
out vec2 vUV;
void main() {
  vUV = aUV;
  vec2 clip = vec2(aPos.x / uCanvas.x * 2.0 - 1.0, 1.0 - aPos.y / uCanvas.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
}`;

const PUNCH_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uScratch;
out vec4 frag;
void main() {
  float s = clamp(texture(uScratch, vUV).r, 0.0, 1.0);
  frag = vec4(0.0, 0.0, 0.0, s); // src alpha = scratch amount
}`;

// Paint a soft dot into the UV-space scratch texture.
const PAINT_VS = `#version 300 es
in vec2 aPos;        // unit quad 0..1
uniform vec2 uCenter; // uv center 0..1
uniform float uRadius; // uv radius
out vec2 vLocal;
void main() {
  vLocal = aPos * 2.0 - 1.0;
  vec2 uv = uCenter + vLocal * uRadius;
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}`;

const PAINT_FS = `#version 300 es
precision highp float;
in vec2 vLocal;
out vec4 frag;
void main() {
  float d = length(vLocal);
  float a = smoothstep(1.0, 0.55, d);
  frag = vec4(a, 0.0, 0.0, 1.0);
}`;

const LINE_VS = `#version 300 es
in vec2 aPos;
uniform vec2 uCanvas;
void main() {
  vec2 clip = vec2(aPos.x / uCanvas.x * 2.0 - 1.0, 1.0 - aPos.y / uCanvas.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
}`;

const LINE_FS = `#version 300 es
precision highp float;
out vec4 frag;
void main() { frag = vec4(1.0, 1.0, 1.0, 0.2); }`;

// Flying fabric flakes: peel off at scratch points, scale up toward the viewer,
// spin, drift, and fade. Fabric color is sampled from fgColorTex at spawn UV.
const FLAKE_VS = `#version 300 es
in vec2 aPos;
uniform vec2 uCanvas;
uniform vec2 uCenter;
uniform vec2 uSpawnUV;
uniform float uSize;
uniform float uRotation;
uniform vec2 uPresentScale;
uniform vec2 uPresentOffset;
out vec2 vLocal;
out vec2 vFabricUV;
void main() {
  vLocal = aPos * 2.0 - 1.0;
  vFabricUV = uSpawnUV;
  vec2 local = vLocal * uSize;
  float c = cos(uRotation);
  float s = sin(uRotation);
  vec2 rotated = vec2(local.x * c - local.y * s, local.x * s + local.y * c);
  vec2 refPx = uCenter + rotated;
  vec2 clip = vec2(refPx.x / uCanvas.x * 2.0 - 1.0, 1.0 - refPx.y / uCanvas.y * 2.0);
  gl_Position = vec4(clip * uPresentScale + uPresentOffset, 0.0, 1.0);
}`;

const FLAKE_FS = `#version 300 es
precision highp float;
in vec2 vLocal;
in vec2 vFabricUV;
uniform sampler2D uFabric;
uniform float uAlpha;
out vec4 frag;
void main() {
  vec4 fabric = texture(uFabric, vFabricUV);
  float d = length(vLocal);
  float round = smoothstep(1.0, 0.25, d);
  float tear = smoothstep(0.95, 0.55, abs(vLocal.x) + abs(vLocal.y) * 0.35);
  float mask = round * tear;
  frag = vec4(fabric.rgb, mask * uAlpha);
}`;

const FLAKE_COUNT_PER_SCRATCH = 2;
const FLAKE_MAX = 120;
const FLAKE_LIFE = 0.7;
const FLAKE_SCALE_MIN = 0.2;
const FLAKE_SCALE_MAX = 0.55;
const FLAKE_BASE_SIZE = 6;
const FLAKE_GRAVITY = 140;

type Flake = {
  x: number;
  y: number;
  spawnU: number;
  spawnV: number;
  baseSize: number;
  rotation: number;
  angularVel: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
};

export class GarmentGLRenderer {
  private gl: WebGL2RenderingContext;
  /** Logical game coordinates (mesh / pointers) — always 390×672 for photo path. */
  private width: number;
  private height: number;
  /** Drawing-buffer / FBO size in device pixels (= logical × DPR). */
  private bufferWidth: number;
  private bufferHeight: number;
  private pixelRatio: number;
  private scratchTexSize: number;

  private blit: WebGLProgram;
  private composite: WebGLProgram;
  private punch: WebGLProgram;
  private paint: WebGLProgram;
  private line: WebGLProgram;
  private flake: WebGLProgram;

  private quadBuf: WebGLBuffer;
  private meshPosBuf: WebGLBuffer;
  private meshUvBuf: WebGLBuffer;
  private meshIndexBuf: WebGLBuffer;
  private lineBuf: WebGLBuffer;
  /** Reused mesh uploads — avoid allocating ~7KB typed arrays every frame. */
  private meshPosScratch: Float32Array | null = null;
  private meshUvScratch: Float32Array | null = null;
  private meshIndexScratch: Uint16Array | null = null;
  private meshUvUploadedFor: Pt[] | null = null;
  private meshIndexCacheCount = 0;
  private meshPosBufBytes = 0;
  private meshIndexLayoutKey = "";
  private meshIndexAllVisible = false;
  private punchPosLoc = -1;
  private punchUvLoc = -1;
  private punchCanvasLoc: WebGLUniformLocation | null = null;
  private punchScratchLoc: WebGLUniformLocation | null = null;
  private compositeTexLoc: WebGLUniformLocation | null = null;
  private compositeScaleLoc: WebGLUniformLocation | null = null;
  private compositeOffsetLoc: WebGLUniformLocation | null = null;
  private paintCenterLoc: WebGLUniformLocation | null = null;
  private paintRadiusLoc: WebGLUniformLocation | null = null;
  private blitTexLoc: WebGLUniformLocation | null = null;
  private blitChromaLoc: WebGLUniformLocation | null = null;
  private blitScaleLoc: WebGLUniformLocation | null = null;
  private blitOffsetLoc: WebGLUniformLocation | null = null;
  private blitPosLoc = -1;
  private compositePosLoc = -1;
  private paintPosLoc = -1;
  private flakeFabricLoc: WebGLUniformLocation | null = null;
  private flakeCanvasLoc: WebGLUniformLocation | null = null;
  private flakePresentScaleLoc: WebGLUniformLocation | null = null;
  private flakePresentOffsetLoc: WebGLUniformLocation | null = null;
  private flakeCenterLoc: WebGLUniformLocation | null = null;
  private flakeSpawnLoc: WebGLUniformLocation | null = null;
  private flakeSizeLoc: WebGLUniformLocation | null = null;
  private flakeRotLoc: WebGLUniformLocation | null = null;
  private flakeAlphaLoc: WebGLUniformLocation | null = null;
  private flakePosLoc = -1;
  private lineCanvasLoc: WebGLUniformLocation | null = null;
  private linePosLoc = -1;
  private lineSegScratch: Float32Array | null = null;
  /** Skip mesh punch entirely until the player has scratched at least once. */
  private scratchHasContent = false;
  /** Force one redraw after paint/clear even if videos haven't advanced. */
  private scratchDirty = false;
  /** Skip a full GL pass when video/camera/scratch haven't changed. */
  private hasPresentedFrame = false;
  private lastPresentedCam = { x: Number.NaN, y: Number.NaN };
  private lastPresentedZoom = Number.NaN;
  private lastHideForeground: boolean | null = null;

  private bottomTex: WebGLTexture;
  private midTex: WebGLTexture;
  private fgTex: WebGLTexture;
  private scratchTex: WebGLTexture;
  private scratchFbo: WebGLFramebuffer;
  /** Reused by `scratchAmountAt` so reveal checks don't allocate per sample. */
  private scratchReadPixel = new Uint8Array(4);
  private fgColorTex: WebGLTexture;
  private fgFbo: WebGLFramebuffer;
  // Once a video has been drawn at least once we keep drawing its last good
  // frame even if it momentarily stalls (common on mobile during a loop wrap, or
  // when a second video element gets suspended). This stops the foreground from
  // blinking out to "just the bottom video", and stops scratched holes from
  // flashing black when the bottom video wraps.
  private fgEverReady = false;
  private bottomEverReady = false;
  private flakes: Flake[] = [];
  private lastRenderTime = 0;
  // Per-video-texture upload state: the dimensions we allocated storage at and
  // the last video time we uploaded. Lets us (a) update with texSubImage2D
  // instead of reallocating with texImage2D every frame, and (b) skip uploads
  // entirely when the video hasn't advanced to a new frame. Both are large wins
  // in Safari, where texImage2D-from-video is very expensive.
  private videoTexState = new WeakMap<WebGLTexture, { w: number; h: number; t: number }>();
  // requestVideoFrameCallback bookkeeping: which videos we've hooked, and whether
  // a genuinely new decoded frame is waiting to be uploaded. rVFC fires exactly
  // once per presented frame, so it's the precise way to avoid re-uploading the
  // same frame (better than the currentTime heuristic, which is the fallback for
  // browsers without rVFC).
  private videoFrameHooked = new WeakSet<HTMLVideoElement>();
  private videoFrameReady = new WeakMap<HTMLVideoElement, boolean>();
  private videoFrameHandles = new Map<HTMLVideoElement, number>();
  private imageTexState = new WeakMap<WebGLTexture, { w: number; h: number; src: ImageSource }>();
  private lastFrontPresentCamera = { x: 0, y: 0 };
  private disposed = false;

  constructor(
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
    options?: {
      alpha?: boolean;
      preserveDrawingBuffer?: boolean;
      /** Device pixels per logical canvas unit (capped at MAX_PIXEL_RATIO). */
      pixelRatio?: number;
    },
  ) {
    const gl = canvas.getContext("webgl2", {
      premultipliedAlpha: false,
      alpha: options?.alpha ?? false,
      preserveDrawingBuffer: options?.preserveDrawingBuffer ?? false,
    });
    if (!gl) throw new Error("WebGL2 not available");
    this.gl = gl;
    this.width = width;
    this.height = height;
    const dpr = Math.max(
      1,
      Math.min(MAX_PIXEL_RATIO, options?.pixelRatio ?? 1),
    );
    this.pixelRatio = dpr;
    this.bufferWidth = Math.max(1, Math.round(width * dpr));
    this.bufferHeight = Math.max(1, Math.round(height * dpr));
    // UV-space scratch map — bump with DPR so punched holes stay crisp.
    this.scratchTexSize = Math.max(
      SCRATCH_TEX_BASE,
      Math.round(SCRATCH_TEX_BASE * Math.min(dpr, 2)),
    );
    canvas.width = this.bufferWidth;
    canvas.height = this.bufferHeight;

    this.blit = program(gl, BLIT_VS, BLIT_FS);
    this.composite = program(gl, BLIT_VS, COMPOSITE_FS);
    this.punch = program(gl, PUNCH_VS, PUNCH_FS);
    this.paint = program(gl, PAINT_VS, PAINT_FS);
    this.line = program(gl, LINE_VS, LINE_FS);
    this.flake = program(gl, FLAKE_VS, FLAKE_FS);

    this.punchPosLoc = gl.getAttribLocation(this.punch, "aPos");
    this.punchUvLoc = gl.getAttribLocation(this.punch, "aUV");
    this.punchCanvasLoc = gl.getUniformLocation(this.punch, "uCanvas");
    this.punchScratchLoc = gl.getUniformLocation(this.punch, "uScratch");
    this.compositeTexLoc = gl.getUniformLocation(this.composite, "uTex");
    this.compositeScaleLoc = gl.getUniformLocation(this.composite, "uScale");
    this.compositeOffsetLoc = gl.getUniformLocation(this.composite, "uOffset");
    this.paintCenterLoc = gl.getUniformLocation(this.paint, "uCenter");
    this.paintRadiusLoc = gl.getUniformLocation(this.paint, "uRadius");
    this.blitTexLoc = gl.getUniformLocation(this.blit, "uTex");
    this.blitChromaLoc = gl.getUniformLocation(this.blit, "uChroma");
    this.blitScaleLoc = gl.getUniformLocation(this.blit, "uScale");
    this.blitOffsetLoc = gl.getUniformLocation(this.blit, "uOffset");
    this.blitPosLoc = gl.getAttribLocation(this.blit, "aPos");
    this.compositePosLoc = gl.getAttribLocation(this.composite, "aPos");
    this.paintPosLoc = gl.getAttribLocation(this.paint, "aPos");
    this.flakeFabricLoc = gl.getUniformLocation(this.flake, "uFabric");
    this.flakeCanvasLoc = gl.getUniformLocation(this.flake, "uCanvas");
    this.flakePresentScaleLoc = gl.getUniformLocation(this.flake, "uPresentScale");
    this.flakePresentOffsetLoc = gl.getUniformLocation(this.flake, "uPresentOffset");
    this.flakeCenterLoc = gl.getUniformLocation(this.flake, "uCenter");
    this.flakeSpawnLoc = gl.getUniformLocation(this.flake, "uSpawnUV");
    this.flakeSizeLoc = gl.getUniformLocation(this.flake, "uSize");
    this.flakeRotLoc = gl.getUniformLocation(this.flake, "uRotation");
    this.flakeAlphaLoc = gl.getUniformLocation(this.flake, "uAlpha");
    this.flakePosLoc = gl.getAttribLocation(this.flake, "aPos");
    this.lineCanvasLoc = gl.getUniformLocation(this.line, "uCanvas");
    this.linePosLoc = gl.getAttribLocation(this.line, "aPos");

    this.quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);

    this.meshPosBuf = gl.createBuffer()!;
    this.meshUvBuf = gl.createBuffer()!;
    this.meshIndexBuf = gl.createBuffer()!;
    this.lineBuf = gl.createBuffer()!;

    this.bottomTex = makeVideoTexture(gl);
    this.midTex = makeVideoTexture(gl);
    this.fgTex = makeVideoTexture(gl);

    this.scratchTex = makeTexture(gl, this.scratchTexSize, this.scratchTexSize);
    this.scratchFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratchFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.scratchTex, 0);
    this.clearScratch();

    this.fgColorTex = makeTexture(gl, this.bufferWidth, this.bufferHeight);
    this.fgFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fgFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fgColorTex, 0);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  }

  private setBufferViewport() {
    this.gl.viewport(0, 0, this.bufferWidth, this.bufferHeight);
  }

  // Drop the "last good frame" memory so a card switch doesn't briefly composite
  // the previous clip's performer over the new background while it decodes.
  resetForeground() {
    this.detachAllVideoFrames();
    this.fgEverReady = false;
    this.bottomEverReady = false;
    // Force the next frame of each video to re-upload (and reallocate if the new
    // clip differs in size) rather than being skipped as an unchanged frame.
    this.videoTexState.delete(this.bottomTex);
    this.videoTexState.delete(this.fgTex);
    this.imageTexState.delete(this.bottomTex);
    this.imageTexState.delete(this.midTex);
    this.imageTexState.delete(this.fgTex);
    this.meshUvUploadedFor = null;
    this.meshIndexCacheCount = 0;
    this.meshPosBufBytes = 0;
    this.meshIndexLayoutKey = "";
    this.meshIndexAllVisible = false;
    this.hasPresentedFrame = false;
    this.lastPresentedCam = { x: Number.NaN, y: Number.NaN };
    this.lastPresentedZoom = Number.NaN;
    this.lastHideForeground = null;
    this.clearFlakes();
  }

  /** Cancel rVFC chains so Safari can release decoder-backed video elements. */
  detachAllVideoFrames() {
    for (const video of [...this.videoFrameHandles.keys()]) {
      this.unhookVideoFrames(video);
    }
    this.videoFrameHandles.clear();
  }

  getFrontPresentCamera() {
    return { ...this.lastFrontPresentCamera };
  }

  clearFlakes() {
    this.flakes = [];
  }

  spawnFlakes(refX: number, refY: number, count = FLAKE_COUNT_PER_SCRATCH) {
    for (let i = 0; i < count; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 40 + Math.random() * 60;
      this.flakes.push({
        x: refX + (Math.random() - 0.5) * 8,
        y: refY + (Math.random() - 0.5) * 8,
        spawnU: refX / this.width,
        spawnV: refY / this.height,
        baseSize: FLAKE_BASE_SIZE * (0.75 + Math.random() * 0.5),
        rotation: Math.random() * Math.PI * 2,
        angularVel: (Math.random() - 0.5) * 10,
        vx: Math.cos(angle) * speed * 0.35,
        vy: Math.sin(angle) * speed * 0.35 - 30,
        age: 0,
        life: FLAKE_LIFE * (0.85 + Math.random() * 0.3),
      });
    }
    while (this.flakes.length > FLAKE_MAX) {
      this.flakes.shift();
    }
  }

  clearScratch() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratchFbo);
    gl.viewport(0, 0, this.scratchTexSize, this.scratchTexSize);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.scratchHasContent = false;
    this.scratchDirty = true;
  }

  // Paint a scratch dot at garment uv (0..1).
  paintScratch(u: number, v: number, radius: number) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratchFbo);
    gl.viewport(0, 0, this.scratchTexSize, this.scratchTexSize);
    gl.useProgram(this.paint);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.uniform2f(this.paintCenterLoc, u, v);
    gl.uniform1f(this.paintRadiusLoc, radius);
    this.bindQuad(this.paint);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.blendEquation(gl.FUNC_ADD);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.scratchHasContent = true;
    this.scratchDirty = true;
  }

  /** Scratch amount (0..1) at garment UV — R channel of the UV scratch map. */
  scratchAmountAt(u: number, v: number): number {
    if (this.disposed) return 0;
    const gl = this.gl;
    const size = this.scratchTexSize;
    const x = Math.min(size - 1, Math.max(0, Math.floor(u * size)));
    // Paint writes NDC with v=0 at the bottom of the FBO; readPixels matches.
    const y = Math.min(size - 1, Math.max(0, Math.floor(v * size)));
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratchFbo);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.scratchReadPixel);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this.scratchReadPixel[0] / 255;
  }

  private bindQuad(prog: WebGLProgram) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    const loc =
      prog === this.blit
        ? this.blitPosLoc
        : prog === this.composite
          ? this.compositePosLoc
          : prog === this.paint
            ? this.paintPosLoc
            : prog === this.flake
              ? this.flakePosLoc
              : gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }

  private coverUniforms(
    prog: WebGLProgram,
    videoW: number,
    videoH: number,
    camX = 0,
    camY = 0,
    overscan = 1,
  ) {
    const gl = this.gl;
    // Cover: scale so the video fills the whole canvas, cropping the overflowing
    // edge (Math.max). The offline mesh generator letterboxes/crops identically
    // (force_original_aspect_ratio=increase + center crop), so the tracked verts
    // stay aligned with the drawn pixels. `overscan` adds pan headroom; the
    // camera offset is clamped to that headroom so no canvas edge is revealed.
    const scale = Math.max(this.width / videoW, this.height / videoH) * overscan;
    const w = (videoW * scale) / this.width; // >=1: overflow is cropped at clip edges
    const h = (videoH * scale) / this.height;
    const scaleLoc =
      prog === this.blit
        ? this.blitScaleLoc
        : gl.getUniformLocation(prog, "uScale");
    const offsetLoc =
      prog === this.blit
        ? this.blitOffsetLoc
        : gl.getUniformLocation(prog, "uOffset");
    gl.uniform2f(scaleLoc, w, h);
    gl.uniform2f(offsetLoc, clamp(camX, -(w - 1), w - 1), clamp(camY, -(h - 1), h - 1));
  }

  /** True when the texture would upload a new video frame this pass. */
  private isVideoFramePending(tex: WebGLTexture, video: HTMLVideoElement) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh || video.readyState < 2) return false;
    const state = this.videoTexState.get(tex);
    const sizeChanged = !state || state.w !== vw || state.h !== vh;
    if (sizeChanged) return true;
    if (this.hookVideoFrames(video)) {
      return !!this.videoFrameReady.get(video);
    }
    return !state || state.t !== video.currentTime;
  }

  // Hook requestVideoFrameCallback (once per video) so we know precisely when a
  // new decoded frame is available. Returns false if rVFC is unsupported, so the
  // caller falls back to the currentTime heuristic.
  private hookVideoFrames(video: HTMLVideoElement): boolean {
    type RVFCVideo = HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, metadata: unknown) => void) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    };
    const rvfcVideo = video as RVFCVideo;
    if (typeof rvfcVideo.requestVideoFrameCallback !== "function") return false;
    if (this.videoFrameHooked.has(video)) return true;
    this.videoFrameHooked.add(video);
    this.videoFrameReady.set(video, true);
    let handle = 0;
    const onFrame = () => {
      if (this.disposed) return;
      this.videoFrameReady.set(video, true);
      handle = rvfcVideo.requestVideoFrameCallback?.(onFrame) ?? 0;
      this.videoFrameHandles.set(video, handle);
    };
    handle = rvfcVideo.requestVideoFrameCallback(onFrame);
    this.videoFrameHandles.set(video, handle);
    return true;
  }

  private unhookVideoFrames(video: HTMLVideoElement) {
    type RVFCVideo = HTMLVideoElement & {
      cancelVideoFrameCallback?: (handle: number) => void;
    };
    const handle = this.videoFrameHandles.get(video);
    if (handle != null) {
      (video as RVFCVideo).cancelVideoFrameCallback?.(handle);
      this.videoFrameHandles.delete(video);
    }
    this.videoFrameHooked.delete(video);
    this.videoFrameReady.delete(video);
  }

  /** Release GPU resources. Call only when the canvas is going away. */
  dispose(options?: { loseContext?: boolean }) {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    this.detachAllVideoFrames();
    this.clearFlakes();

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (this.scratchFbo) gl.deleteFramebuffer(this.scratchFbo);
    if (this.fgFbo) gl.deleteFramebuffer(this.fgFbo);
    gl.deleteTexture(this.bottomTex);
    gl.deleteTexture(this.midTex);
    gl.deleteTexture(this.fgTex);
    gl.deleteTexture(this.scratchTex);
    gl.deleteTexture(this.fgColorTex);
    gl.deleteBuffer(this.quadBuf);
    gl.deleteBuffer(this.meshPosBuf);
    gl.deleteBuffer(this.meshUvBuf);
    gl.deleteBuffer(this.meshIndexBuf);
    gl.deleteBuffer(this.lineBuf);
    gl.deleteProgram(this.blit);
    gl.deleteProgram(this.composite);
    gl.deleteProgram(this.punch);
    gl.deleteProgram(this.paint);
    gl.deleteProgram(this.line);
    gl.deleteProgram(this.flake);

    // Only lose the context when the canvas itself is going away. Recreating a
    // renderer on the same canvas must keep the WebGL2 context alive — Safari
    // returns the existing (lost) context from getContext otherwise.
    if (options?.loseContext !== false) {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  }

  private uploadVideo(tex: WebGLTexture, video: HTMLVideoElement) {
    if (this.disposed) return;
    const gl = this.gl;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;

    const state = this.videoTexState.get(tex);
    const sizeChanged = !state || state.w !== vw || state.h !== vh;

    // Re-uploading a frame the texture already holds is pure waste (the render
    // loop ticks faster than the clip's fps). Decide if there's anything new:
    // prefer rVFC ("a new frame was presented"); fall back to a currentTime
    // change. Either way this cuts uploads to roughly the clip's real fps.
    if (this.hookVideoFrames(video)) {
      if (!sizeChanged && !this.videoFrameReady.get(video)) return;
      this.videoFrameReady.set(video, false);
    } else if (!sizeChanged && state && state.t === video.currentTime) {
      return;
    }

    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (sizeChanged) {
      // First frame, or the source changed size (card switch): (re)allocate.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    } else {
      // Steady state: update the existing texture in place. Much cheaper than a
      // fresh texImage2D allocation each frame on Safari.
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video);
    }
    this.videoTexState.set(tex, { w: vw, h: vh, t: video.currentTime });
  }

  private uploadImage(tex: WebGLTexture, source: ImageSource) {
    const gl = this.gl;
    const { w, h } = sourceDimensions(source);
    if (!w || !h) return;

    const state = this.imageTexState.get(tex);
    const sizeChanged = !state || state.w !== w || state.h !== h || state.src !== source;
    if (!sizeChanged) return;

    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    this.imageTexState.set(tex, { w, h, src: source });
  }

  private drawSource(
    prog: WebGLProgram,
    tex: WebGLTexture,
    source: ImageSource,
    chroma: boolean,
    camX = 0,
    camY = 0,
    overscan = 1,
    upload = true,
  ) {
    const gl = this.gl;
    gl.useProgram(prog);
    if (upload) {
      if (source instanceof HTMLVideoElement) {
        this.uploadVideo(tex, source);
      } else {
        this.uploadImage(tex, source);
      }
    }
    const { w, h } = sourceDimensions(source);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (prog === this.blit) {
      gl.uniform1i(this.blitTexLoc, 0);
      if (this.blitChromaLoc) gl.uniform1i(this.blitChromaLoc, chroma ? 1 : 0);
    } else {
      gl.uniform1i(gl.getUniformLocation(prog, "uTex"), 0);
      const chromaLoc = gl.getUniformLocation(prog, "uChroma");
      if (chromaLoc) gl.uniform1i(chromaLoc, chroma ? 1 : 0);
    }
    this.coverUniforms(prog, w || this.width, h || this.height, camX, camY, overscan);
    this.bindQuad(prog);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private drawVideo(
    prog: WebGLProgram,
    tex: WebGLTexture,
    video: HTMLVideoElement,
    chroma: boolean,
    camX = 0,
    camY = 0,
    overscan = 1,
    upload = true,
  ) {
    this.drawSource(prog, tex, video, chroma, camX, camY, overscan, upload);
  }

  private drawImageLayer(
    image: HTMLImageElement | null,
    tex: WebGLTexture,
    camera: { x: number; y: number },
    chroma: boolean,
    blendOnTop: boolean,
    overscan = PRESENT_ZOOM,
  ) {
    if (!image || !image.complete || !image.naturalWidth) return false;
    const gl = this.gl;
    if (blendOnTop) {
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    } else {
      gl.disable(gl.BLEND);
    }
    this.drawSource(this.blit, tex, image, chroma, camera.x, camera.y, overscan);
    return true;
  }

  // Still-image variant: background can parallax independently; foreground +
  // scratch holes stay in the reference frame (presented without bg camera).
  renderImages(
    bottomImage: HTMLImageElement | null,
    foregroundImage: HTMLImageElement | null,
    sample: GLMeshSample | null,
    showMesh: boolean,
    backgroundCamera: { x: number; y: number } = { x: 0, y: 0 },
    foregroundChroma = false,
  ) {
    this.renderImageLayers(
      bottomImage,
      null,
      foregroundImage,
      sample,
      showMesh,
      {
        back: backgroundCamera,
        mid: { x: 0, y: 0 },
        front: { x: 0, y: 0 },
      },
      foregroundChroma,
    );
  }

  /**
   * Photo-scratch foreground pass: mid (bikini) + front (clothes) share one
   * camera so they stay locked together. Background is a separate CSS layer.
   * Canvas must be created with `{ alpha: true }` so the room shows through.
   */
  renderPhotoForeground(
    midImage: HTMLImageElement | null,
    frontImage: HTMLImageElement | null,
    sample: GLMeshSample | null,
    showMesh: boolean,
    camera: { x: number; y: number } = { x: 0, y: 0 },
    frontChroma = false,
  ) {
    const gl = this.gl;
    const cam = {
      x: clamp(camera.x, -(PRESENT_ZOOM - 1), PRESENT_ZOOM - 1),
      y: clamp(camera.y, -(PRESENT_ZOOM - 1), PRESENT_ZOOM - 1),
    };
    this.lastFrontPresentCamera = cam;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.setBufferViewport();
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Bikini / mid — same present camera + zoom as the clothes composite.
    if (midImage) {
      this.drawImageLayer(midImage, this.midTex, cam, false, true);
    }

    const frontReady =
      !!frontImage && frontImage.complete && frontImage.naturalWidth > 0;
    if (!frontReady) {
      if (showMesh && sample) {
        this.drawMeshLines(sample);
      }
      return;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fgFbo);
    this.setBufferViewport();
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.drawSource(this.blit, this.fgTex, frontImage!, frontChroma);

    if (sample) {
      this.drawMeshPunch(sample);
    }
    this.fgEverReady = true;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.setBufferViewport();
    gl.useProgram(this.composite);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFuncSeparate(
      gl.SRC_ALPHA,
      gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
    );
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fgColorTex);
    gl.uniform1i(this.compositeTexLoc, 0);
    gl.uniform2f(
      this.compositeScaleLoc,
      PRESENT_ZOOM,
      PRESENT_ZOOM,
    );
    gl.uniform2f(this.compositeOffsetLoc, cam.x, cam.y);
    this.bindQuad(this.composite);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    if (showMesh && sample) {
      this.drawMeshLines(sample);
    }
  }

  // Linked parallax layers: one shared tilt vector scaled by depth; scratch FBO
  // stays in the reference frame so holes remain glued to the front garment.
  renderImageLayers(
    backImage: HTMLImageElement | null,
    midImage: HTMLImageElement | null,
    frontImage: HTMLImageElement | null,
    sample: GLMeshSample | null,
    showMesh: boolean,
    cameras: ImageLayerCameras,
    frontChroma = true,
  ) {
    const gl = this.gl;
    const backCam = {
      x: clamp(cameras.back.x, -(PRESENT_ZOOM - 1), PRESENT_ZOOM - 1),
      y: clamp(cameras.back.y, -(PRESENT_ZOOM - 1), PRESENT_ZOOM - 1),
    };
    const midCam = {
      x: clamp(cameras.mid.x, -(PRESENT_ZOOM - 1), PRESENT_ZOOM - 1),
      y: clamp(cameras.mid.y, -(PRESENT_ZOOM - 1), PRESENT_ZOOM - 1),
    };
    const frontCam = {
      x: clamp(cameras.front.x, -(PRESENT_ZOOM - 1), PRESENT_ZOOM - 1),
      y: clamp(cameras.front.y, -(PRESENT_ZOOM - 1), PRESENT_ZOOM - 1),
    };
    this.lastFrontPresentCamera = frontCam;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.setBufferViewport();
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (this.drawImageLayer(backImage, this.bottomTex, backCam, false, false)) {
      this.bottomEverReady = true;
    } else if (backImage && this.bottomEverReady) {
      this.drawSource(this.blit, this.bottomTex, backImage, false, backCam.x, backCam.y, PRESENT_ZOOM, false);
    }

    this.drawImageLayer(midImage, this.midTex, midCam, false, true);

    const frontReady = !!frontImage && frontImage.complete && frontImage.naturalWidth > 0;
    if (!frontReady && !this.fgEverReady) return;

    if (frontReady) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fgFbo);
      this.setBufferViewport();
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.drawSource(this.blit, this.fgTex, frontImage!, frontChroma);

      if (sample) {
        this.drawMeshPunch(sample);
      }
      this.fgEverReady = true;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.setBufferViewport();
    gl.useProgram(this.composite);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fgColorTex);
    gl.uniform1i(this.compositeTexLoc, 0);
    gl.uniform2f(this.compositeScaleLoc, PRESENT_ZOOM, PRESENT_ZOOM);
    gl.uniform2f(this.compositeOffsetLoc, frontCam.x, frontCam.y);
    this.bindQuad(this.composite);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    if (showMesh && sample) {
      this.drawMeshLines(sample);
    }
  }

  render(
    bottomVideo: HTMLVideoElement | null,
    foregroundVideo: HTMLVideoElement | null,
    sample: GLMeshSample | null,
    showMesh: boolean,
    camera: { x: number; y: number } = { x: 0, y: 0 },
    hideForeground = false,
    foregroundChroma = true,
    overscan = PRESENT_ZOOM,
  ) {
    const gl = this.gl;

    // The chest-follow camera pans the PRESENTED layers (bottom video in step 1,
    // composite in step 4) by the same clip-space offset, with overscan headroom.
    // The foreground-into-FBO (step 2) and hole punching (step 3) stay in the
    // un-panned reference frame so scratch holes remain glued to the mesh.
    // `overscan` defaults to PRESENT_ZOOM; hunt-hint nudges may raise it briefly.
    const zoom = Math.max(1, overscan);
    const camMax = zoom - 1;
    const camX = clamp(camera.x, -camMax, camMax);
    const camY = clamp(camera.y, -camMax, camMax);

    const now = performance.now();
    const dt = this.lastRenderTime > 0 ? Math.min(0.05, (now - this.lastRenderTime) / 1000) : 0;
    this.lastRenderTime = now;
    this.updateFlakes(dt);

    // Display often runs faster than clip fps. When nothing moved — no new
    // decoded frame, no camera drift, no new scratch paint, no flakes — keep
    // the previous canvas contents and skip the whole GL pass. Mesh holes only
    // need re-punching when the fg video (mesh clock) advances.
    const bottomPending =
      !!bottomVideo && this.isVideoFramePending(this.bottomTex, bottomVideo);
    const fgPending =
      !hideForeground &&
      !!foregroundVideo &&
      this.isVideoFramePending(this.fgTex, foregroundVideo);
    const camMoved =
      Math.abs(camX - this.lastPresentedCam.x) > 1e-4 ||
      Math.abs(camY - this.lastPresentedCam.y) > 1e-4 ||
      Math.abs(zoom - this.lastPresentedZoom) > 1e-4;
    const needsDraw =
      !this.hasPresentedFrame ||
      this.scratchDirty ||
      this.flakes.length > 0 ||
      showMesh ||
      camMoved ||
      bottomPending ||
      fgPending ||
      hideForeground !== this.lastHideForeground;
    if (!needsDraw) return;

    const paintedScratch = this.scratchDirty;
    this.scratchDirty = false;

    // 1. bottom video to screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.setBufferViewport();
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (bottomVideo && bottomVideo.readyState >= 2) {
      this.drawVideo(this.blit, this.bottomTex, bottomVideo, false, camX, camY, zoom);
      this.bottomEverReady = true;
    } else if (bottomVideo && this.bottomEverReady) {
      // Bottom stalled (e.g. mid loop wrap): redraw its last frame so scratched
      // holes keep revealing video instead of flashing black.
      this.drawVideo(this.blit, this.bottomTex, bottomVideo, false, camX, camY, zoom, false);
    }

    const fgFresh = !!foregroundVideo && foregroundVideo.readyState >= 2;
    // Nothing to show yet: bail until the foreground has decoded its first frame.
    if (!hideForeground && !fgFresh && !this.fgEverReady) return;

    this.lastPresentedCam.x = camX;
    this.lastPresentedCam.y = camY;
    this.lastPresentedZoom = zoom;
    this.lastHideForeground = hideForeground;
    this.hasPresentedFrame = true;

    // Rebuild the keyed FG FBO only when the performer frame or scratch map
    // changed. Camera pans and bottom-only updates just re-composite.
    const rebuildFg =
      !hideForeground &&
      fgFresh &&
      (!this.fgEverReady || fgPending || paintedScratch);
    if (rebuildFg) {
      // 2. keyed foreground into fgFbo (reference frame — no camera/overscan)
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fgFbo);
      this.setBufferViewport();
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.drawVideo(this.blit, this.fgTex, foregroundVideo!, foregroundChroma);

      // 3. punch holes where scratched, within the tracked mesh
      if (sample) {
        this.drawMeshPunch(sample);
      }
      this.fgEverReady = true;
    }
    // If the foreground stalled we skip steps 2-3 and re-composite the last good
    // FBO contents below, so the performer freezes instead of disappearing.

    if (!hideForeground) {
    // 4. composite fg (with holes) over the bottom video on screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.setBufferViewport();
    gl.useProgram(this.composite);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fgColorTex);
    gl.uniform1i(this.compositeTexLoc, 0);
    // Present the FBO (foreground + holes) with the same overscan + camera pan
    // as the bottom video so the whole shot moves together.
    gl.uniform2f(this.compositeScaleLoc, zoom, zoom);
    gl.uniform2f(this.compositeOffsetLoc, camX, camY);
    this.bindQuad(this.composite);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // 4.5. flying fabric flakes over the composite
    this.drawFlakes(camX, camY, zoom);

    // 5. mesh overlay
    if (showMesh && sample) {
      this.drawMeshLines(sample);
    }
  }

  private buildVisibleIndices(sample: GLMeshSample) {
    const { cols, rows, vis } = sample;
    const layoutKey = `${cols}x${rows}`;
    const cellCount = cols * rows;
    let allVisible = true;
    for (let i = 0; i < cellCount; i += 1) {
      if (!vis[i]) {
        allVisible = false;
        break;
      }
    }
    // Full-screen fields keep every cell visible — reuse the GPU index buffer.
    if (
      allVisible &&
      this.meshIndexAllVisible &&
      this.meshIndexLayoutKey === layoutKey &&
      this.meshIndexCacheCount > 0
    ) {
      return this.meshIndexCacheCount;
    }

    const needed = (cols - 1) * (rows - 1) * 6;
    if (!this.meshIndexScratch || this.meshIndexScratch.length < needed) {
      this.meshIndexScratch = new Uint16Array(needed);
    }
    const idx = this.meshIndexScratch;
    let n = 0;
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const tl = r * cols + c;
        const tr = tl + 1;
        const bl = tl + cols;
        const br = bl + 1;
        if (vis[tl] && vis[tr] && vis[bl] && vis[br]) {
          idx[n++] = tl;
          idx[n++] = tr;
          idx[n++] = br;
          idx[n++] = tl;
          idx[n++] = br;
          idx[n++] = bl;
        }
      }
    }
    this.meshIndexCacheCount = n;
    this.meshIndexLayoutKey = layoutKey;
    this.meshIndexAllVisible = allVisible;
    const gl = this.gl;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.meshIndexBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx.subarray(0, n), gl.DYNAMIC_DRAW);
    return n;
  }

  private uploadMesh(sample: GLMeshSample) {
    const gl = this.gl;
    const n = sample.verts.length;
    if (!this.meshPosScratch || this.meshPosScratch.length < n * 2) {
      this.meshPosScratch = new Float32Array(n * 2);
    }
    const pos = this.meshPosScratch;
    for (let i = 0; i < n; i++) {
      pos[i * 2] = sample.verts[i].x;
      pos[i * 2 + 1] = sample.verts[i].y;
    }
    const bytes = n * 2 * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshPosBuf);
    if (bytes > this.meshPosBufBytes) {
      gl.bufferData(gl.ARRAY_BUFFER, pos.subarray(0, n * 2), gl.DYNAMIC_DRAW);
      this.meshPosBufBytes = bytes;
    } else {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos.subarray(0, n * 2));
    }

    // UVs are static for a given mesh — upload once.
    if (this.meshUvUploadedFor !== sample.uv) {
      if (!this.meshUvScratch || this.meshUvScratch.length < n * 2) {
        this.meshUvScratch = new Float32Array(n * 2);
      }
      const uv = this.meshUvScratch;
      for (let i = 0; i < n; i++) {
        uv[i * 2] = sample.uv[i].x;
        uv[i * 2 + 1] = sample.uv[i].y;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.meshUvBuf);
      gl.bufferData(gl.ARRAY_BUFFER, uv.subarray(0, n * 2), gl.STATIC_DRAW);
      this.meshUvUploadedFor = sample.uv;
    }
  }

  private drawMeshPunch(sample: GLMeshSample) {
    if (!this.scratchHasContent) return;
    const gl = this.gl;
    const indexCount = this.buildVisibleIndices(sample);
    if (indexCount === 0) return;
    this.uploadMesh(sample);

    gl.useProgram(this.punch);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    // dst.rgb unchanged, dst.a *= (1 - src.a)
    gl.blendFuncSeparate(gl.ZERO, gl.ONE, gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshPosBuf);
    gl.enableVertexAttribArray(this.punchPosLoc);
    gl.vertexAttribPointer(this.punchPosLoc, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshUvBuf);
    gl.enableVertexAttribArray(this.punchUvLoc);
    gl.vertexAttribPointer(this.punchUvLoc, 2, gl.FLOAT, false, 0, 0);

    gl.uniform2f(this.punchCanvasLoc, this.width, this.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.scratchTex);
    gl.uniform1i(this.punchScratchLoc, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.meshIndexBuf);
    gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, 0);
  }

  private updateFlakes(dt: number) {
    if (dt <= 0 || this.flakes.length === 0) return;
    const next: Flake[] = [];
    for (const flake of this.flakes) {
      flake.age += dt;
      if (flake.age >= flake.life) continue;
      flake.x += flake.vx * dt;
      flake.y += flake.vy * dt;
      flake.vy += FLAKE_GRAVITY * dt;
      flake.rotation += flake.angularVel * dt;
      next.push(flake);
    }
    this.flakes = next;
  }

  private drawFlakes(camX: number, camY: number, overscan = PRESENT_ZOOM) {
    if (this.flakes.length === 0 || !this.fgEverReady) return;
    const gl = this.gl;
    const zoom = Math.max(1, overscan);
    gl.useProgram(this.flake);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fgColorTex);
    gl.uniform1i(this.flakeFabricLoc, 0);
    gl.uniform2f(this.flakeCanvasLoc, this.width, this.height);
    gl.uniform2f(this.flakePresentScaleLoc, zoom, zoom);
    gl.uniform2f(this.flakePresentOffsetLoc, camX, camY);
    this.bindQuad(this.flake);

    for (const flake of this.flakes) {
      const t = flake.age / flake.life;
      const ease = 1 - (1 - t) * (1 - t);
      const scaleMult = FLAKE_SCALE_MIN + (FLAKE_SCALE_MAX - FLAKE_SCALE_MIN) * ease;
      const alpha = t < 0.65 ? 1 : 1 - (t - 0.65) / 0.35;
      gl.uniform2f(this.flakeCenterLoc, flake.x, flake.y);
      gl.uniform2f(this.flakeSpawnLoc, flake.spawnU, 1 - flake.spawnV);
      gl.uniform1f(this.flakeSizeLoc, flake.baseSize * scaleMult);
      gl.uniform1f(this.flakeRotLoc, flake.rotation);
      gl.uniform1f(this.flakeAlphaLoc, alpha);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  private drawMeshLines(sample: GLMeshSample) {
    const gl = this.gl;
    const { cols, rows, verts, vis } = sample;
    const maxFloats = cols * rows * 4 * 2;
    if (!this.lineSegScratch || this.lineSegScratch.length < maxFloats) {
      this.lineSegScratch = new Float32Array(maxFloats);
    }
    const segs = this.lineSegScratch;
    let n = 0;
    const push = (a: number, b: number) => {
      if (!vis[a] || !vis[b]) return;
      segs[n++] = verts[a].x;
      segs[n++] = verts[a].y;
      segs[n++] = verts[b].x;
      segs[n++] = verts[b].y;
    };
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (c + 1 < cols) push(i, i + 1);
        if (r + 1 < rows) push(i, i + cols);
      }
    }
    if (n === 0) return;
    gl.useProgram(this.line);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, segs.subarray(0, n), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.linePosLoc);
    gl.vertexAttribPointer(this.linePosLoc, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(this.lineCanvasLoc, this.width, this.height);
    gl.drawArrays(gl.LINES, 0, n / 2);
  }
}
