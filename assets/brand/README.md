# App icons

Shared source artwork for Lemma's web and desktop application icons. The mark
is an L and a separate square that together form a square, connecting the
name to the mathematical proof-ending square and the app's replaceable parts.

| Asset                            | Appearance                    |
| -------------------------------- | ----------------------------- |
| [icon-dark.png](icon-dark.png)   | White mark on a charcoal tile |
| [icon-light.png](icon-light.png) | Charcoal mark on a white tile |
| [icon-dev.png](icon-dev.png)     | White mark on an orange tile  |

All three are 1254 x 1254 PNGs with transparency outside the rounded tile. The
filenames describe the tile's appearance. Use these originals when deriving
platform-specific sizes and formats; keep shared artwork here rather than
duplicating it in each app.

The desktop app uses `icon-dark.png` as its window and Dock icon. The web app's
favicon, [`apps/web/public/favicon.svg`](../../apps/web/public/favicon.svg), is
the mark alone, redrawn as vector paths with no tile: charcoal on light browser
themes and white on dark ones. Redraw it if the mark changes.

Lemma run from a checkout (`pnpm dev`, `pnpm desktop`, a web build that is not
a release's) shows the orange dev icons instead, so it is told apart from an
installed Lemma at a glance: `icon-dev.png` in the desktop app, and
[`favicon-dev.svg`](../../apps/web/public/favicon-dev.svg), the favicon in
orange, in a browser's tab. `icon-dev.png` is `icon-dark.png` with its charcoal
recolored `#ea580c`, keeping its shading; derive it again if that icon changes.
