# look.appearance

Paints the look its config chooses on the page, through `@lemma/web/paint`,
from what the `Themes`, `Accents`, and `Fonts` slots offer
([`@lemma/look`](../contract/src/look.ts)). Adds Lemma's own choices to those
slots as any plugin adds its: the themes `lemma-light` and `lemma-dark` (the
stylesheet's own colors), the accents `blue`, `violet`, `pink`, `red`,
`orange`, and `green`, and the fonts `inter`, `geist`, and `ibm-plex-sans`
for the interface and `jetbrains-mono`, `geist-mono`, and `berkeley-mono` for
code. Requires `Slots`. It draws nothing: `look.appearance-page` edits its
config, as `lemma plugins config look.appearance …` or any plugin may
([The look](../../../apps/web/README.md#the-look)). Its config Schema is
`AppearanceConfig` in [the contract](../contract/src/appearance.ts).

| Config         | Default       | What it does                                                                                 |
| -------------- | ------------- | -------------------------------------------------------------------------------------------- |
| `scheme`       | `system`      | `light` or `dark`; `system` follows the browser's or OS's setting as it changes              |
| `lightTheme`   | `lemma-light` | The id of a `Themes` item for the light scheme                                               |
| `darkTheme`    | `lemma-dark`  | The id of a `Themes` item for the dark scheme                                                |
| `accent`       | the theme's   | The id of an `Accents` item, or any CSS color (`--accent`)                                   |
| `font`         | the system's  | The id of a `ui` font, or a CSS font-family list (`--font-ui`)                               |
| `monoFont`     | the system's  | The id of a `mono` font, or a CSS font-family list, for code and tool output (`--font-mono`) |
| `textSize`     | `default`     | `small`, `large`, or `larger` scale every font (`--text-scale` 0.93, 1.07, 1.15)             |
| `corners`      | `default`     | `square` or `round` scale every corner (`--radius-scale` 0, 1.5)                             |
| `contentWidth` | `default`     | How wide the transcript and composer run: `wide` (1040px) or `full` (`--content`)            |

## Behavior

- **A choice that is gone.** A theme or accent no plugin offers now (its
  plugin is off), or an accent that is no CSS color, is left out and the
  default shows; the config keeps it, so it shows again once its plugin runs.
- **Fonts by name.** It ships no font files, so a font that is not installed
  falls back to the system's. A family list of your own that does not end in
  a generic family (`sans-serif`, `monospace`) gets the system's appended.
- **Before plugins start.** The browser remembers the painted look, and the
  next load paints it before any plugin runs.
- **Turned off**, it unpaints: the page returns to the system scheme and the
  stylesheet's look. A look painted since by another owner stays, so a
  replacement, which starts before this plugin stops, paints with `paint` and
  keeps its look.
