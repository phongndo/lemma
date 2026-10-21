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

| Shape     | What the contract offers                                                                                                                                                                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add       | `Themes`, `Accents`, `Fonts`, `CodeBlocks` (a renderer for a fenced block's language)                                                                                                                                                                                |
| Intercept | The shared parts: `IconPart`, `DialogPart`, `PopoverPart`, `TogglePart`, `SegmentedPart`, `SearchFieldPart`, `SettingRowPart`, `ConfigFormPart`, `MarkdownPart`, `CopyButtonPart`, `FileIconPart`, `AvatarPart` (an agent's picture: an identicon of its session id) |
| Observe   | `onLookChange` (`@lemma/web/paint`)                                                                                                                                                                                                                                  |
| Call      | `@lemma/web/paint`: the look's tokens and colors                                                                                                                                                                                                                     |
| Serve     | Nothing: the look is `look.appearance`'s config                                                                                                                                                                                                                      |
