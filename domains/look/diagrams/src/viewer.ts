/** How far a diagram that fits the window is enlarged to fill it; it is vector, so it stays sharp. */
const VIEWER_MAX_SCALE = 3;
/** How far a diagram taller than the window is enlarged; it scrolls, so this is for legibility, not fit. */
const VIEWER_TALL_SCALE = 2;

/**
 * How large the viewer shows a diagram: enlarged to fill the window when it
 * fits; else as wide as the window allows, enlarged a little for legibility
 * (a tall diagram scrolls rather than shrinking to fit the height).
 */
export const viewerScale = (width: number, height: number, roomWidth: number, roomHeight: number): number => {
  const fit = Math.min(roomWidth / width, roomHeight / height);
  return fit >= 1 ? Math.min(fit, VIEWER_MAX_SCALE) : Math.min(VIEWER_TALL_SCALE, roomWidth / width);
};
