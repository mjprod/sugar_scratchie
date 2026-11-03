export type Box = { x: number; y: number; width: number; height: number }
export type Corner = 'nw' | 'ne' | 'se' | 'sw'

const MIN_SIDE = 48

/** Scale a box from one corner. Width and height share one factor.
 *  ponytail: opposite corner stays put. No free-form stretch. */
export function resizeLocked(
  start: Box,
  corner: Corner,
  worldDx: number,
  worldDy: number,
): Box {
  const right = start.x + start.width
  const bottom = start.y + start.height
  const anchor =
    corner === 'se'
      ? { x: start.x, y: start.y }
      : corner === 'nw'
        ? { x: right, y: bottom }
        : corner === 'ne'
          ? { x: start.x, y: bottom }
          : { x: right, y: start.y }
  const origin =
    corner === 'se'
      ? { x: right, y: bottom }
      : corner === 'nw'
        ? { x: start.x, y: start.y }
        : corner === 'ne'
          ? { x: right, y: start.y }
          : { x: start.x, y: bottom }
  const ox = origin.x - anchor.x
  const oy = origin.y - anchor.y
  const px = ox + worldDx
  const py = oy + worldDy
  const denom = ox * ox + oy * oy
  let scale = denom > 0 ? (px * ox + py * oy) / denom : 1
  const minScale = MIN_SIDE / Math.min(start.width, start.height)
  if (scale < minScale) scale = minScale
  const width = start.width * scale
  const height = start.height * scale
  return {
    x: corner === 'nw' || corner === 'sw' ? anchor.x - width : anchor.x,
    y: corner === 'nw' || corner === 'ne' ? anchor.y - height : anchor.y,
    width,
    height,
  }
}

const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv
const isDirectRun = argv?.[1]?.includes('resizeItem') ?? false

if (isDirectRun) {
  const start = { x: 10, y: 20, width: 100, height: 200 }
  const same = resizeLocked(start, 'se', 0, 0)
  if (same.x !== 10 || same.y !== 20 || same.width !== 100 || same.height !== 200) {
    throw new Error('zero drag moved the box')
  }
  const grown = resizeLocked(start, 'se', 100, 200)
  if (grown.width !== 200 || grown.height !== 400 || grown.x !== 10 || grown.y !== 20) {
    throw new Error('diagonal scale ' + JSON.stringify(grown))
  }
  const side = resizeLocked(start, 'se', 100, 0)
  if (Math.abs(side.width / side.height - 0.5) > 1e-9) {
    throw new Error('aspect drifted ' + JSON.stringify(side))
  }
  const tiny = resizeLocked(start, 'se', -1000, -1000)
  if (Math.min(tiny.width, tiny.height) < 48 - 1e-6) {
    throw new Error('below minimum ' + JSON.stringify(tiny))
  }
  const nw = resizeLocked(start, 'nw', 0, 0)
  if (nw.x !== 10 || nw.y !== 20 || nw.width !== 100 || nw.height !== 200) {
    throw new Error('nw anchor ' + JSON.stringify(nw))
  }
  console.log('resizeLocked ok')
}
