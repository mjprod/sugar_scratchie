/**
 * Run with: node scripts/check-lane-chain.ts
 * Kept out of laneChain.ts so importing that module has no side effects.
 */
import {
  clearOutgoing,
  computeChainOrder,
  linkChain,
  listChainEdges,
  removeFromChain,
} from '../src/sugarDress/lib/laneChain.ts'

const story = (from: string, to: string) => linkChain({}, from, to, 'right', 'left')
let map = linkChain(story('a', 'b'), 'b', 'c', 'right', 'left')
map = linkChain(map, 'a', 'made1', 'right', 'left', 'made')
map = linkChain(map, 'a', 'made2', 'right', 'left', 'made')
const edges = listChainEdges(map, ['a', 'b', 'c', 'made1', 'made2'])
const pair = (from: string, to: string) =>
  edges.some((edge) => edge.fromId === from && edge.toId === to)
if (!pair('a', 'b') || !pair('b', 'c') || !pair('a', 'made1') || !pair('a', 'made2')) {
  throw new Error('made links replaced the lane or an earlier made edge')
}
const orders = computeChainOrder(map, ['a', 'b', 'c', 'made1', 'made2'])
if (orders.a !== 1 || orders.b !== 2 || orders.c !== 3) {
  throw new Error('story lane order changed')
}
if (new Set(Object.values(orders)).size !== 5) {
  throw new Error('export numbers collided')
}
const cleared = clearOutgoing(map, 'a', 'made1')
const clearedEdges = listChainEdges(cleared, ['a', 'b', 'c', 'made1', 'made2'])
if (
  clearedEdges.some((edge) => edge.toId === 'made1') ||
  !clearedEdges.some((edge) => edge.fromId === 'a' && edge.toId === 'b') ||
  !clearedEdges.some((edge) => edge.toId === 'made2')
) {
  throw new Error('clearing one made edge dropped another edge')
}
const spliced = removeFromChain(map, 'b')
if (
  !listChainEdges(spliced, ['a', 'c', 'made1', 'made2']).some(
    (edge) => edge.fromId === 'a' && edge.toId === 'c' && edge.kind !== 'made',
  )
) {
  throw new Error('deleting a lane node did not splice the story')
}
console.log('lane-chain ok')
