import { For, createMemo } from "solid-js";
import { filled, identicon } from "@lemma/look";
import type { AvatarProps } from "@lemma/look";

/** Rows and columns of an identicon, and the margin around them, in cells. */
const CELLS = [0, 1, 2, 3, 4];
const GRID = 6;

/**
 * The default `avatar` part: the seed's identicon on a tile, its cells in the seed's hue (`--avatar-hue`), at the
 * lightness and saturation the stylesheet's `--avatar-ink` sets, so a theme tunes every avatar at once.
 */
export function IdenticonAvatar(props: AvatarProps) {
  const picture = createMemo(() => identicon(props.seed));
  const size = () => props.size ?? 16;
  return (
    <svg
      class={`avatar ${props.class ?? ""}`}
      width={size()}
      height={size()}
      viewBox={`0 0 ${GRID} ${GRID}`}
      style={{ "--avatar-hue": String(picture().hue) }}
      aria-hidden="true"
      shape-rendering="crispEdges"
    >
      <rect class="avatar-tile" width={GRID} height={GRID} />
      <For each={CELLS}>
        {(row) => (
          <For each={CELLS}>
            {(column) => (filled(picture(), row, column) ? <rect class="avatar-cell" x={0.5 + column} y={0.5 + row} width="1" height="1" /> : null)}
          </For>
        )}
      </For>
    </svg>
  );
}
