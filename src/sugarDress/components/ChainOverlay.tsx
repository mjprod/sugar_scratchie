import type { CanvasItem } from '../types'
import {
  CHAIN_PORT_GAP_PX,
  portPoint,
  type ChainEdge,
  type Side,
} from '../lib/laneChain'

type Props = {
  items: CanvasItem[]
  edges: ChainEdge[]
  scale: number
  selectedEdgeFromId: string | null
  preview: {
    x1: number
    y1: number
    x2: number
    y2: number
    fromSide: Side
  } | null
  onSelectEdge: (fromId: string) => void
  onClothesOn: (fromId: string, toId: string) => void
  onMergeIn: (fromId: string, toId: string) => void
  clothesBusy?: boolean
}

function outward(side: Side, x: number, y: number, d: number) {
  switch (side) {
    case 'top':
      return { x, y: y - d }
    case 'right':
      return { x: x + d, y }
    case 'bottom':
      return { x, y: y + d }
    case 'left':
      return { x: x - d, y }
  }
}

function curveMid(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  fromSide: Side,
  toSide: Side,
) {
  const stretch = Math.max(Math.hypot(x2 - x1, y2 - y1) * 0.35, 40)
  const c1 = outward(fromSide, x1, y1, stretch)
  const c2 = outward(toSide, x2, y2, stretch)
  return {
    x: 0.125 * x1 + 0.375 * c1.x + 0.375 * c2.x + 0.125 * x2,
    y: 0.125 * y1 + 0.375 * c1.y + 0.375 * c2.y + 0.125 * y2,
  }
}

function curvePath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  fromSide: Side,
  toSide: Side,
): string {
  const stretch = Math.max(Math.hypot(x2 - x1, y2 - y1) * 0.35, 40)
  const c1 = outward(fromSide, x1, y1, stretch)
  const c2 = outward(toSide, x2, y2, stretch)
  return `M ${x1} ${y1} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${x2} ${y2}`
}

export function ChainOverlay({
  items,
  edges,
  scale,
  selectedEdgeFromId,
  preview,
  onSelectEdge,
  onClothesOn,
  onMergeIn,
  clothesBusy = false,
}: Props) {
  const byId = new Map(items.map((item) => [item.id, item]))
  const gap = CHAIN_PORT_GAP_PX / Math.max(scale, 0.001)

  const ui = 1 / Math.max(scale, 0.001)

  return (
    <>
      <svg className="chain-overlay" aria-hidden>
        <defs>
          <marker
            id="chain-arrow"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" className="chain-arrow-head" />
          </marker>
          <marker
            id="chain-arrow-selected"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" className="chain-arrow-head is-selected" />
          </marker>
        </defs>

        {edges.map(({ fromId, toId, fromSide, toSide }) => {
          const from = byId.get(fromId)
          const to = byId.get(toId)
          if (!from || !to) return null
          const a = portPoint(from, fromSide, gap)
          const b = portPoint(to, toSide, gap)
          const d = curvePath(a.x, a.y, b.x, b.y, fromSide, toSide)
          const selected = selectedEdgeFromId === fromId
          return (
            <g key={`${fromId}-${toId}`}>
              <path
                className="chain-edge-hit"
                d={d}
                onPointerDown={(e) => {
                  e.stopPropagation()
                  e.preventDefault()
                  onSelectEdge(fromId)
                }}
              />
              <path
                className={selected ? 'chain-edge is-selected' : 'chain-edge'}
                d={d}
                markerEnd={
                  selected ? 'url(#chain-arrow-selected)' : 'url(#chain-arrow)'
                }
              />
            </g>
          )
        })}

        {preview && (
          <path
            className="chain-edge is-preview"
            d={curvePath(
              preview.x1,
              preview.y1,
              preview.x2,
              preview.y2,
              preview.fromSide,
              preview.fromSide === 'left'
                ? 'right'
                : preview.fromSide === 'right'
                  ? 'left'
                  : preview.fromSide === 'top'
                    ? 'bottom'
                    : 'top',
            )}
            markerEnd="url(#chain-arrow)"
          />
        )}
      </svg>
      {edges.map(({ fromId, toId, fromSide, toSide, kind }) => {
        const from = byId.get(fromId)
        const to = byId.get(toId)
        if (!from || !to) return null
        const a = portPoint(from, fromSide, gap)
        const b = portPoint(to, toSide, gap)
        const mid = curveMid(a.x, a.y, b.x, b.y, fromSide, toSide)
        return (
          <div
            key={`actions-${fromId}-${toId}`}
            className="chain-actions"
            style={{
              left: mid.x,
              top: mid.y,
              transform: `translate(-50%, -50%) scale(${ui})`,
            }}
            onPointerDown={(e) => {
              e.stopPropagation()
            }}
          >
            {kind === 'made' && (
              <span className="chain-match chain-made" title="Generated from the previous image">
                Made
              </span>
            )}
            <button
              type="button"
              className="chain-match chain-merge"
              title="Shrink the first image to the second and stack it on top"
              onClick={(e) => {
                e.stopPropagation()
                onMergeIn(fromId, toId)
              }}
            >
              Merge In
            </button>
            <button
              type="button"
              className="chain-match"
              title="The first image is the clothes, the second is the person. Put the clothes on the person."
              disabled={clothesBusy}
              onClick={(e) => {
                e.stopPropagation()
                onClothesOn(fromId, toId)
              }}
            >
              Clothes On
            </button>
          </div>
        )
      })}
    </>
  )
}
