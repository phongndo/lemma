/**
 * A drag of an edge or a handle, from its `pointerdown`: the primary button only, the pointer captured by the element
 * pressed, `move` hearing each move until the drag ends, and `end` once, however it ends (released, cancelled, or the
 * capture lost, as when the element goes mid-drag). Other buttons are left alone. Returns whether a drag began.
 */
export const dragEdge = (event: PointerEvent, handlers: { readonly move: (moved: PointerEvent) => void; readonly end?: () => void }): boolean => {
  if (event.button !== 0) return false;
  event.preventDefault();
  const edge = event.currentTarget as HTMLElement;
  edge.setPointerCapture(event.pointerId);
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    edge.removeEventListener("pointermove", handlers.move);
    edge.removeEventListener("pointerup", finish);
    edge.removeEventListener("pointercancel", finish);
    edge.removeEventListener("lostpointercapture", finish);
    handlers.end?.();
  };
  edge.addEventListener("pointermove", handlers.move);
  edge.addEventListener("pointerup", finish);
  edge.addEventListener("pointercancel", finish);
  edge.addEventListener("lostpointercapture", finish);
  return true;
};
