import type { CanvasItem } from '../types'
import type { Point } from './camera'

export type Side = 'top' | 'right' | 'bottom' | 'left'

export type ChainLink = {
  toId: string
  fromSide: Side
  toSide: Side
}

/** Directed story lane: each node points to at most one next image. */
export type ChainMap = Record<string, ChainLink>

export const SIDES: Side[] = ['top', 'right', 'bottom', 'left']

/** Screen-pixel gap between frame edge and port (converted via / scale). */
export const CHAIN_PORT_GAP_PX = 18

export function portPoint(
  item: CanvasItem,
  side: Side,
  gapWorld: number,
): Point {
  const cx = item.x + item.width / 2
  const cy = item.y + item.height / 2
  switch (side) {
    case 'top':
      return { x: cx, y: item.y - gapWorld }
    case 'right':
      return { x: item.x + item.width + gapWorld, y: cy }
    case 'bottom':
      return { x: cx, y: item.y + item.height + gapWorld }
    case 'left':
      return { x: item.x - gapWorld, y: cy }
  }
}

export function nearestSide(
  item: CanvasItem,
  point: Point,
  gapWorld: number,
): Side {
  let best: Side = 'left'
  let bestDist = Infinity
  for (const side of SIDES) {
    const p = portPoint(item, side, gapWorld)
    const d = Math.hypot(p.x - point.x, p.y - point.y)
    if (d < bestDist) {
      bestDist = d
      best = side
    }
  }
  return best
}

export function linkChain(
  map: ChainMap,
  fromId: string,
  toId: string,
  fromSide: Side,
  toSide: Side,
): ChainMap {
  if (fromId === toId) return map

  const next: ChainMap = { ...map }

  for (const [k, link] of Object.entries(next)) {
    if (link.toId === toId) delete next[k]
  }

  next[fromId] = { toId, fromSide, toSide }

  const seen = new Set<string>()
  let cur: string | undefined = toId
  while (cur) {
    if (cur === fromId) {
      for (const [k, link] of Object.entries(next)) {
        if (link.toId === fromId) delete next[k]
      }
      break
    }
    if (seen.has(cur)) break
    seen.add(cur)
    cur = next[cur]?.toId
  }

  return next
}

export function removeFromChain(map: ChainMap, id: string): ChainMap {
  const next: ChainMap = { ...map }
  const outgoing = next[id]
  delete next[id]

  for (const [k, link] of Object.entries(next)) {
    if (link.toId === id) {
      if (outgoing) {
        next[k] = {
          toId: outgoing.toId,
          fromSide: link.fromSide,
          toSide: outgoing.toSide,
        }
      } else {
        delete next[k]
      }
    }
  }

  return next
}

export function clearOutgoing(map: ChainMap, fromId: string): ChainMap {
  if (!(fromId in map)) return map
  const next = { ...map }
  delete next[fromId]
  return next
}

/** True when the node has an incoming or outgoing chain edge. */
export function isLinked(map: ChainMap, id: string): boolean {
  if (map[id]) return true
  for (const link of Object.values(map)) {
    if (link.toId === id) return true
  }
  return false
}

/**
 * Hard-disconnect nodes: drop every edge that touches any of the ids.
 * Unlike removeFromChain, does not splice neighbors back together.
 */
export function disconnectNodes(
  map: ChainMap,
  ids: Iterable<string>,
): ChainMap {
  const idSet = new Set(ids)
  if (idSet.size === 0) return map
  const next: ChainMap = {}
  for (const [fromId, link] of Object.entries(map)) {
    if (idSet.has(fromId) || idSet.has(link.toId)) continue
    next[fromId] = link
  }
  return next
}

export function computeChainOrder(
  map: ChainMap,
  itemIds: Iterable<string>,
): Record<string, number> {
  const idSet = new Set(itemIds)
  const involved = new Set<string>()
  for (const [a, link] of Object.entries(map)) {
    if (!idSet.has(a) || !idSet.has(link.toId)) continue
    involved.add(a)
    involved.add(link.toId)
  }
  if (involved.size === 0) return {}

  const hasIncoming = new Set<string>()
  for (const [a, link] of Object.entries(map)) {
    if (idSet.has(a) && idSet.has(link.toId)) hasIncoming.add(link.toId)
  }

  const roots = [...involved].filter((id) => !hasIncoming.has(id))
  const orders: Record<string, number> = {}

  // Continue numbering across separate chains so export filenames stay unique.
  let n = 1
  for (const root of roots) {
    let cur: string | undefined = root
    const seen = new Set<string>()
    while (cur && idSet.has(cur) && !seen.has(cur)) {
      orders[cur] = n++
      seen.add(cur)
      cur = map[cur]?.toId
    }
  }

  // Nodes in cycles / fragments without a clear root
  for (const id of involved) {
    if (orders[id] == null) orders[id] = n++
  }

  return orders
}

export type ChainEdge = {
  fromId: string
  toId: string
  fromSide: Side
  toSide: Side
}

export function listChainEdges(
  map: ChainMap,
  itemIds: Iterable<string>,
): ChainEdge[] {
  const idSet = new Set(itemIds)
  const edges: ChainEdge[] = []
  for (const [fromId, link] of Object.entries(map)) {
    if (idSet.has(fromId) && idSet.has(link.toId)) {
      edges.push({
        fromId,
        toId: link.toId,
        fromSide: link.fromSide,
        toSide: link.toSide,
      })
    }
  }
  return edges
}
