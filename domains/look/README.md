# look

How everything looks: the scheme, themes, accents, fonts, and sizes, and the shared parts every view draws with. Its contract is [`@lemma/look`](contract/src/look.ts), with the parts in [`parts.tsx`](contract/src/parts.tsx).

| Plugin                                     | Halves | What it does                                                                          |
| ------------------------------------------ | ------ | ------------------------------------------------------------------------------------- |
| [`look.kit`](kit/)                         | web    | The shared parts' defaults                                                            |
| [`look.appearance`](appearance/)           | web    | Paints the look its config chooses, from the themes, accents, and fonts plugins offer |
| [`look.appearance-page`](appearance-page/) | web    | Settings › Appearance, with switches for the look's optional plugins (`LOOK_PLUGINS`) |
| [`look.highlight`](highlight/)             | web    | Syntax highlighting for fenced code                                                   |
| [`look.diagrams`](diagrams/)               | web    | Mermaid diagrams for ```mermaid blocks                                                |
| [`look.file-icons`](file-icons/)           | web    | Each file's type as its icon                                                          |

## Extending it

What the contract offers in each of the [five shapes](../../docs/plugins.md#the-five-shapes):

| Shape     | What the contract offers                                                                                                                                                                                                                                                                                                                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add       | `Themes`, `Accents`, `Fonts`, `CodeBlocks` (a renderer for a fenced block's language)                                                                                                                                                                                                                                                                                                                                |
| Intercept | The shared parts: `IconPart`, `DialogPart`, `PopoverPart`, `TogglePart`, `SegmentedPart`, `SearchFieldPart`, `SettingRowPart`, `ConfigFormPart`, `MarkdownPart`, `CopyButtonPart`, `FileIconPart`, `AvatarPart` (an agent's picture: an identicon of its session id), `PicturePart` (an image from an address given, light and dark, with a fallback), `SvgDropPart` (a button taking an SVG file picked or dropped) |
| Observe   | `onLookChange` (`@lemma/web/paint`)                                                                                                                                                                                                                                                                                                                                                                                  |
| Call      | `@lemma/web/paint`: the look's tokens and colors; an SVG file of a person's own, checked and drawn as an image (`readSvg`, `pickSvg`, `svgProblem`, `svgSource`); the [shared controls](#shared-controls)                                                                                                                                                                                                            |
| Serve     | Nothing: the look is `look.appearance`'s config                                                                                                                                                                                                                                                                                                                                                                      |

## Shared controls

Beside the parts, the contract holds plain components a view draws with, on the foundation's classes, so a theme restyles them but no plugin replaces them:

- `MenuItem` ([`menu.tsx`](contract/src/menu.tsx)): a row of a `Popover`'s menu, which closes the menu, then runs; `danger` draws it in the error color.
- `ConfirmDelete` (the same file): deletes one thing after asking in place. It is a trash button whose first click arms it, filled in the error color at the same size with `CONFIRM_DELETE` as its tooltip, and whose second deletes; moving off it or Escape takes the question back. Every place one thing is deleted in place asks so, a thread's menu too (`ActionMenu`'s `confirm` in `@lemma/frame`). Deleting many things at once, or one whose loss takes more with it (a profile and all its data), asks in a dialog instead, which says what goes and what stays, as `DeleteThreadsDialog` in `@lemma/threads` does.
