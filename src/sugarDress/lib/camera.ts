export type Camera = {
  x: number
  y: number
  scale: number
}

export type Point = {
  x: number
  y: number
}

export const MIN_SCALE = 0.1
export const MAX_SCALE = 8
export const DEFAULT_CAMERA: Camera = { x: 0, y: 0, scale: 1 }

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

/** Screen (viewport) → world (canvas space) */
export function screenToWorld(screen: Point, camera: Camera): Point {
  return {
    x: (screen.x - camera.x) / camera.scale,
    y: (screen.y - camera.y) / camera.scale,
  }
}

/** World → screen */
export function worldToScreen(world: Point, camera: Camera): Point {
  return {
    x: world.x * camera.scale + camera.x,
    y: world.y * camera.scale + camera.y,
  }
}

/**
 * Zoom around a fixed screen point (mouse cursor or pinch midpoint).
 * Keeps the world point under that screen point stationary.
 */
export function zoomAt(
  camera: Camera,
  screenAnchor: Point,
  nextScale: number,
): Camera {
  const scale = clampScale(nextScale)
  if (scale === camera.scale) return camera

  const world = screenToWorld(screenAnchor, camera)
  return {
    scale,
    x: screenAnchor.x - world.x * scale,
    y: screenAnchor.y - world.y * scale,
  }
}

/** Multiplicative zoom (e.g. wheel delta → factor) around a screen anchor */
export function zoomByFactor(
  camera: Camera,
  screenAnchor: Point,
  factor: number,
): Camera {
  return zoomAt(camera, screenAnchor, camera.scale * factor)
}

export function panBy(camera: Camera, delta: Point): Camera {
  return {
    ...camera,
    x: camera.x + delta.x,
    y: camera.y + delta.y,
  }
}

export function midpoint(a: Point, b: Point): Point {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  }
}

export function distance(a: Point, b: Point): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.hypot(dx, dy)
}

export function cameraTransform(camera: Camera): string {
  return `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`
}
