/**
 * The range a stored anchor position may take, as a fraction of its target element's box.
 * 0..1 is inside the box. A click on empty space attaches to the nearest element and may sit
 * up to one box size outside it, so it follows that element when the layout reflows.
 * The frame bridge inlines the same numbers (it can't import); a unit test keeps them equal.
 */
export const POS_MIN = -1;
export const POS_MAX = 2;

export const inPosRange = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= POS_MIN && v <= POS_MAX;
