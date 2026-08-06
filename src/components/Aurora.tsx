import { Color, Mesh, Program, Renderer, Triangle } from "ogl";
import { useEffect, useRef } from "react";

import "./Aurora.css";

const VERT = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FRAG = `#version 300 es
precision highp float;

uniform float uTime;
uniform float uAmplitude;
uniform vec3 uColorStops[3];
uniform vec2 uResolution;
uniform float uBlend;
uniform float uBandHeight;
uniform float uParticleCount;
uniform float uParticleSize;
uniform float uParticleSpeed;
uniform float uParticleOpacity;
uniform vec3 uParticleColor;
uniform float uParticleTwinkle;

out vec4 fragColor;

vec3 permute(vec3 x) {
  return mod(((x * 34.0) + 1.0) * x, 289.0);
}

float snoise(vec2 v){
  const vec4 C = vec4(
      0.211324865405187, 0.366025403784439,
      -0.577350269189626, 0.024390243902439
  );
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);

  vec3 p = permute(
      permute(i.y + vec3(0.0, i1.y, 1.0))
    + i.x + vec3(0.0, i1.x, 1.0)
  );

  vec3 m = max(
      0.5 - vec3(
          dot(x0, x0),
          dot(x12.xy, x12.xy),
          dot(x12.zw, x12.zw)
      ),
      0.0
  );
  m = m * m;
  m = m * m;

  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);

  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

// Stable pseudo-random helpers for particle seeds.
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

vec2 hash12(float p) {
  vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

struct ColorStop {
  vec3 color;
  float position;
};

#define COLOR_RAMP(colors, factor, finalColor) {              \\
  int index = 0;                                            \\
  for (int i = 0; i < 2; i++) {                               \\
     ColorStop currentColor = colors[i];                    \\
     bool isInBetween = currentColor.position <= factor;    \\
     index = int(mix(float(index), float(i), float(isInBetween))); \\
  }                                                         \\
  ColorStop currentColor = colors[index];                   \\
  ColorStop nextColor = colors[index + 1];                  \\
  float range = nextColor.position - currentColor.position; \\
  float lerpFactor = (factor - currentColor.position) / range; \\
  finalColor = mix(currentColor.color, nextColor.color, lerpFactor); \\
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;

  ColorStop colors[3];
  colors[0] = ColorStop(uColorStops[0], 0.0);
  colors[1] = ColorStop(uColorStops[1], 0.5);
  colors[2] = ColorStop(uColorStops[2], 1.0);

  vec3 rampColor;
  COLOR_RAMP(colors, uv.x, rampColor);

  // bandHeight > 1 stretches the curtain downward so the bands fill more of the button.
  float cover = max(uBandHeight, 0.05);
  float y = 1.0 - (1.0 - uv.y) / cover;
  y = clamp(y, 0.0, 2.5);

  float height = snoise(vec2(uv.x * 2.0 + uTime * 0.1, uTime * 0.25)) * 0.5 * uAmplitude;
  height = exp(height);
  height = (y * 2.0 - height + 0.2);
  float intensity = 0.6 * height;

  float midPoint = 0.20;
  float auroraAlpha = smoothstep(midPoint - uBlend * 0.5, midPoint + uBlend * 0.5, intensity);

  vec3 auroraColor = intensity * rampColor;
  vec4 color = vec4(auroraColor * auroraAlpha, auroraAlpha);

  // Soft circle particles in the same pass (fixed loop bound, gated by uParticleCount).
  // Aspect-correct UV so dots stay round on wide CTAs.
  float aspect = max(uResolution.x, 1.0) / max(uResolution.y, 1.0);
  vec2 puv = vec2(uv.x * aspect, uv.y);
  float count = clamp(uParticleCount, 0.0, 24.0);
  float baseR = max(uParticleSize, 0.0005);
  float spd = uParticleSpeed;
  float opac = clamp(uParticleOpacity, 0.0, 1.0);

  for (int i = 0; i < 24; i++) {
    if (float(i) >= count) break;

    float fi = float(i);
    vec2 seed = hash12(fi + 1.7);
    float phase = hash11(fi + 9.1) * 6.2831853;
    float speedMul = 0.55 + hash11(fi + 3.3) * 0.9;
    float sizeMul = 0.55 + hash11(fi + 5.7) * 1.1;

    // Drift mostly upward/sideways like glitter in the aurora field.
    vec2 drift = vec2(
      sin(uTime * 0.55 * spd * speedMul + phase) * 0.18
        + cos(uTime * 0.21 * spd + phase * 1.7) * 0.06,
      fract(seed.y + uTime * 0.08 * spd * speedMul) * 1.15 - 0.08
    );

    vec2 center = vec2(seed.x * aspect, 0.0) + drift;
    // Keep particles mostly over the colored band, with a little edge wander.
    center.x = clamp(center.x, 0.02 * aspect, aspect - 0.02 * aspect);

    float r = baseR * sizeMul * (0.85 + 0.15 * sin(uTime * 1.3 * spd + phase));
    float d = length(puv - center);
    float soft = smoothstep(r, r * 0.22, d);

    float twinkle = 1.0;
    if (uParticleTwinkle > 0.001) {
      float tw = 0.5 + 0.5 * sin(uTime * (2.0 + hash11(fi + 11.0) * 3.5) * spd + phase);
      twinkle = mix(1.0, tw, clamp(uParticleTwinkle, 0.0, 1.0));
    }

    float a = soft * opac * twinkle;
    // Premultiplied-style add so particles read on top of aurora without a second pass.
    color.rgb += uParticleColor * a;
    color.a = max(color.a, a);
  }

  fragColor = color;
}
`;

export type AuroraProps = {
  colorStops?: [string, string, string];
  amplitude?: number;
  blend?: number;
  speed?: number;
  time?: number;
  /**
   * Vertical coverage of the aurora curtain.
   * 1 = stock look; higher values stretch the bands so they fill more of the button.
   */
  bandHeight?: number;
  /** Soft circle particles drawn in the same fragment pass. */
  particleCount?: number;
  /** Base particle radius in UV-ish units (~0.01–0.08 looks good on a CTA). */
  particleSize?: number;
  particleSpeed?: number;
  particleOpacity?: number;
  particleColor?: string;
  /** 0 = steady, 1 = strong twinkle. */
  particleTwinkle?: number;
  className?: string;
};

const DEFAULT_COLOR_STOPS: [string, string, string] = ["#5227FF", "#7cff67", "#5227FF"];

function hexToRgb(hex: string): [number, number, number] {
  const c = new Color(hex);
  return [c.r, c.g, c.b];
}

export default function Aurora(props: AuroraProps) {
  const {
    colorStops = DEFAULT_COLOR_STOPS,
    amplitude = 1.0,
    blend = 0.5,
    bandHeight = 1.0,
    particleCount = 0,
    particleSize = 0.03,
    particleSpeed = 1,
    particleOpacity = 0.85,
    particleColor = "#ffffff",
    particleTwinkle = 0.45,
    className,
  } = props;
  const propsRef = useRef(props);
  propsRef.current = props;

  const ctnDom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctn = ctnDom.current;
    if (!ctn) return;

    const renderer = new Renderer({
      alpha: true,
      premultipliedAlpha: true,
      antialias: true,
    });
    const gl = renderer.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.canvas.style.backgroundColor = "transparent";
    gl.canvas.style.display = "block";
    gl.canvas.style.width = "100%";
    gl.canvas.style.height = "100%";

    let program: Program | undefined;

    function resize() {
      if (!ctn) return;
      const width = ctn.offsetWidth;
      const height = ctn.offsetHeight;
      if (width <= 0 || height <= 0) return;
      renderer.setSize(width, height);
      if (program) {
        program.uniforms.uResolution.value = [width, height];
      }
    }
    window.addEventListener("resize", resize);

    const geometry = new Triangle(gl);
    if (geometry.attributes.uv) {
      delete geometry.attributes.uv;
    }

    const colorStopsArray = colorStops.map(hexToRgb);

    program = new Program(gl, {
      vertex: VERT,
      fragment: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uAmplitude: { value: amplitude },
        uColorStops: { value: colorStopsArray },
        uResolution: { value: [ctn.offsetWidth, ctn.offsetHeight] },
        uBlend: { value: blend },
        uBandHeight: { value: bandHeight },
        uParticleCount: { value: particleCount },
        uParticleSize: { value: particleSize },
        uParticleSpeed: { value: particleSpeed },
        uParticleOpacity: { value: particleOpacity },
        uParticleColor: { value: hexToRgb(particleColor) },
        uParticleTwinkle: { value: particleTwinkle },
      },
    });

    const mesh = new Mesh(gl, { geometry, program });
    ctn.appendChild(gl.canvas);

    let animateId = 0;
    const update = (t: number) => {
      animateId = requestAnimationFrame(update);
      if (!program) return;
      const current = propsRef.current;
      const { time = t * 0.01, speed = 1.0 } = current;
      program.uniforms.uTime.value = time * speed * 0.1;
      program.uniforms.uAmplitude.value = current.amplitude ?? 1.0;
      program.uniforms.uBlend.value = current.blend ?? blend;
      program.uniforms.uBandHeight.value = current.bandHeight ?? bandHeight;
      program.uniforms.uParticleCount.value = current.particleCount ?? particleCount;
      program.uniforms.uParticleSize.value = current.particleSize ?? particleSize;
      program.uniforms.uParticleSpeed.value = current.particleSpeed ?? particleSpeed;
      program.uniforms.uParticleOpacity.value = current.particleOpacity ?? particleOpacity;
      program.uniforms.uParticleColor.value = hexToRgb(current.particleColor ?? particleColor);
      program.uniforms.uParticleTwinkle.value = current.particleTwinkle ?? particleTwinkle;
      const stops = current.colorStops ?? colorStops;
      program.uniforms.uColorStops.value = stops.map(hexToRgb);
      renderer.render({ scene: mesh });
    };
    animateId = requestAnimationFrame(update);

    resize();

    return () => {
      cancelAnimationFrame(animateId);
      window.removeEventListener("resize", resize);
      if (ctn && gl.canvas.parentNode === ctn) {
        ctn.removeChild(gl.canvas);
      }
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amplitude]);

  return (
    <div
      ref={ctnDom}
      className={className ? `aurora-container ${className}` : "aurora-container"}
    />
  );
}
