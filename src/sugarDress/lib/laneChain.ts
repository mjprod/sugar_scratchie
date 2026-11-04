import type { CanvasItem } from '../types'
import type { Point } from './camera'

export type Side = 'top' | 'right' | 'bottom' | 'left'

export type ChainKind = 'made'

export type ChainLink = {
  toId: string
  fromSide: Side
  toSide: Side
  /** made = generated from the previous node */
  kind?: ChainKind
}

/**
 * Story lane plus Made edges. Each node has at most one story-lane next.
 * Made edges are extra outgoing links and do not replace that next.
 */
export type ChainMap = Record<string, ChainLink[]>

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

function cloneChain(map: ChainMap): ChainMap {
  const next: ChainMap = {}
  for (const [id, links] of Object.entries(map)) {
    if (links.length) next[id] = links.map((link) => ({ ...link }))
  }
  return next
}

/** Drop every edge that lands on `toId`. A node has one incoming edge. */
function dropIncoming(map: ChainMap, toId: string) {
  for (const [id, links] of Object.entries(map)) {
    const kept = links.filter((link) => link.toId !== toId)
    if (kept.length) map[id] = kept
    else delete map[id]
  }
}

function reaches(map: ChainMap, start: string, goal: string): boolean {
  const seen = new Set<string>()
  const stack = [start]
  while (stack.length) {
    const cur = stack.pop()
    if (!cur || seen.has(cur)) continue
    if (cur === goal) return true
    seen.add(cur)
    for (const link of map[cur] ?? []) stack.push(link.toId)
  }
  return false
}

export function linkChain(
  map: ChainMap,
  fromId: string,
  toId: string,
  fromSide: Side,
  toSide: Side,
  kind?: ChainKind,
): ChainMap {
  if (fromId === toId) return map

  const next = cloneChain(map)
  dropIncoming(next, toId)

  const link: ChainLink = {
    toId,
    fromSide,
    toSide,
    ...(kind ? { kind } : {}),
  }
  const existing = next[fromId] ?? []
  next[fromId] =
    kind === 'made'
      ? [...existing, link]
      : [...existing.filter((item) => item.kind === 'made'), link]

  if (reaches(next, toId, fromId)) dropIncoming(next, fromId)
  return next
}

export function removeFromChain(map: ChainMap, id: string): ChainMap {
  const storyNext = (map[id] ?? []).find((link) => link.kind !== 'made')
  const next = cloneChain(map)
  delete next[id]

  for (const [fromId, links] of Object.entries(next)) {
    const updated: ChainLink[] = []
    for (const link of links) {
      if (link.toId !== id) {
        updated.push(link)
        continue
      }
      if (link.kind !== 'made' && storyNext) {
        updated.push({
          toId: storyNext.toId,
          fromSide: link.fromSide,
          toSide: storyNext.toSide,
        })
      }
    }
    if (updated.length) next[fromId] = updated
    else delete next[fromId]
  }

  return next
}

/** Remove one outgoing edge. With no `toId`, remove every edge leaving `fromId`. */
export function clearOutgoing(map: ChainMap, fromId: string, toId?: string): ChainMap {
  const links = map[fromId]
  if (!links?.length) return map
  const kept = toId ? links.filter((link) => link.toId !== toId) : []
  const next = cloneChain(map)
  if (kept.length) next[fromId] = kept
  else delete next[fromId]
  return next
}

/** True when the node has an incoming or outgoing chain edge. */
export function isLinked(map: ChainMap, id: string): boolean {
  if (map[id]?.length) return true
  for (const links of Object.values(map)) {
    if (links.some((link) => link.toId === id)) return true
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
  for (const [fromId, links] of Object.entries(map)) {
    if (idSet.has(fromId)) continue
    const kept = links.filter((link) => !idSet.has(link.toId))
    if (kept.length) next[fromId] = kept
  }
  return next
}

export function computeChainOrder(
  map: ChainMap,
  itemIds: Iterable<string>,
): Record<string, number> {
  const idSet = new Set(itemIds)
  const involved = new Set<string>()
  for (const [fromId, links] of Object.entries(map)) {
    for (const link of links) {
      if (!idSet.has(fromId) || !idSet.has(link.toId)) continue
      involved.add(fromId)
      involved.add(link.toId)
    }
  }
  if (involved.size === 0) return {}

  const hasIncoming = new Set<string>()
  for (const [fromId, links] of Object.entries(map)) {
    if (!idSet.has(fromId)) continue
    for (const link of links) {
      if (idSet.has(link.toId)) hasIncoming.add(link.toId)
    }
  }

  const roots = [...involved].filter((id) => !hasIncoming.has(id))
  const orders: Record<string, number> = {}
  const seen = new Set<string>()
  let n = 1

  const visit = (id: string) => {
    if (!idSet.has(id) || seen.has(id)) return
    seen.add(id)
    orders[id] = n++
    const links = map[id] ?? []
    const story = links.filter((link) => link.kind !== 'made')
    const made = links.filter((link) => link.kind === 'made')
    for (const link of [...story, ...made]) visit(link.toId)
  }

  // Continue numbering across separate chains so export filenames stay unique.
  // The story lane is numbered before Made branches.
  for (const root of roots) visit(root)
  for (const id of involved) visit(id)

  return orders
}

export type ChainEdge = {
  fromId: string
  toId: string
  fromSide: Side
  toSide: Side
  kind?: ChainKind
}

export function listChainEdges(
  map: ChainMap,
  itemIds: Iterable<string>,
): ChainEdge[] {
  const idSet = new Set(itemIds)
  const edges: ChainEdge[] = []
  for (const [fromId, links] of Object.entries(map)) {
    for (const link of links) {
      if (!idSet.has(fromId) || !idSet.has(link.toId)) continue
      edges.push({
        fromId,
        toId: link.toId,
        fromSide: link.fromSide,
        toSide: link.toSide,
        kind: link.kind,
      })
    }
  }
  return edges
}
