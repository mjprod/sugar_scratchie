import { CANVAS_HEIGHT, CANVAS_WIDTH } from "../scratch/meshGeometry";

/** Corner radius of the stage progress border (SVG rect rx/ry). Was 8. */
export const FRAME_RX = 18;
export const FRAME_W = CANVAS_WIDTH;
export const FRAME_H = CANVAS_HEIGHT;

export type NormalizedPoint = { nx: number; ny: number };

export function roundedRectPerimeter(
  w: number,
  h: number,
  r: number,
): number {
  return 2 * (w - 2 * r) + 2 * (h - 2 * r) + 2 * Math.PI * r;
}

/**
 * Clockwise rounded-rect path that starts at the top-left of the top edge
 * (after the top-left corner radius). SVG `<rect>` path starts are browser-
 * dependent; an explicit path keeps frame progress anchored top-left.
 */
export function roundedRectPath(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): string {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  if (radius <= 0) {
    return `M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`;
  }
  const right = x + w;
  const bottom = y + h;
  return [
    `M ${x + radius} ${y}`,
    `H ${right - radius}`,
    `A ${radius} ${radius} 0 0 1 ${right} ${y + radius}`,
    `V ${bottom - radius}`,
    `A ${radius} ${radius} 0 0 1 ${right - radius} ${bottom}`,
    `H ${x + radius}`,
    `A ${radius} ${radius} 0 0 1 ${x} ${bottom - radius}`,
    `V ${y + radius}`,
    `A ${radius} ${radius} 0 0 1 ${x + radius} ${y}`,
    "Z",
  ].join(" ");
}

export function feedbackLabel(found: number, total: number): {
  primary: string;
  secondary: string;
} {
  if (found >= total) {
    return { primary: `${total} / ${total}`, secondary: "Found" };
  }
  if (found === total - 1) {
    return { primary: "Only one left!", secondary: "" };
  }
  if (found === 10) {
    return { primary: "Almost there…", secondary: "" };
  }
  return { primary: `${found} / ${total}`, secondary: "Found" };
}
