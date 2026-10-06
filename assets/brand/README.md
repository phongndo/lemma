# App icons

Shared source artwork for Lemma's web and desktop application icons. The mark
is an L and a separate square that together form a square, connecting the
name to the mathematical proof-ending square and the app's replaceable parts.

| Asset                            | Appearance                    |
| -------------------------------- | ----------------------------- |
| [icon-dark.png](icon-dark.png)   | White mark on a charcoal tile |
| [icon-light.png](icon-light.png) | Charcoal mark on a white tile |

Both are 1254 x 1254 PNGs with transparency outside the rounded tile. The
filenames describe the tile's appearance. Use these originals when deriving
platform-specific sizes and formats; keep shared artwork here rather than
duplicating it in each app.

The desktop app uses `icon-dark.png` as its window and Dock icon. The web app's
favicon, [`apps/web/public/favicon.svg`](../../apps/web/public/favicon.svg), is
the mark alone, redrawn as vector paths with no tile: charcoal on light browser
themes and white on dark ones. Redraw it if the mark changes.
