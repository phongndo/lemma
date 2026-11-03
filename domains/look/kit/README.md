# look.kit

The shared parts' defaults that every view draws with: markdown, dialogs,
menus, switches, search fields and lists, copy buttons, setting rows, choices,
settings forms, icons, file icons, and provider logos. Adds a default in the
phase `default`, with the id `kit.<part>` (`kit.dialog`), to each part
[`@lemma/look`](../contract/src/parts.tsx) declares (`MarkdownPart`,
`DialogPart`, `PopoverPart`, `TogglePart`, `SearchFieldPart`, `SearchListPart`,
`CopyButtonPart`, `SettingRowPart`, `SegmentedPart`, `ConfigFormPart`,
`IconPart`, `FileIconPart`) and to `ProviderLogoPart`
([`@lemma/llm/web`](../../llm/contract/src/web/parts.tsx)). No config. Its
components are also `@lemma/look-kit/defaults`, which the web app hands web
halves as `api.defaults`, to wrap or fall back to.

## Behavior

- **Replacing it.** A plugin replaces one part everywhere by adding an item
  that names no phase. One with the id `look.kit` replaces all of them, and a
  part it leaves out draws as though `look.kit` were off.
- **With it off**, a part with a plain fallback
  ([`fallbacks.tsx`](../contract/src/fallbacks.tsx)) draws native markup:
  `IconPart` a text glyph, `TogglePart` a checkbox, `SegmentedPart` a select,
  `SearchFieldPart` a search input, and `ConfigFormPart` a text input per
  field. The other parts draw nothing, and file icons show only while
  `look.file-icons` runs.
- **The always-on plugins** (`frame.shell`, `frame.pages`, `settings.page`,
  `settings.plugins`) draw only parts with a fallback. So with `look.kit` off
  the Plugins page still searches, switches plugins, and edits their settings.
- **Its stylesheet leaves with it.** `kit.css` styles the defaults in the
  `plugins` layer's `parts` sublayer, under the views' own rules, so a view
  restyles a part where it draws it. A replacement that draws `api.defaults`
  with `look.kit` off brings its own styles. The stylesheet declares the parts'
  own tokens: `--shadow-popover`, `--switch-knob`, and `--switch-knob-shadow`.
- **Focus and menus.** The dialog and the popover focus the first
  `[data-autofocus]` element in what they show (the dialog an `[autofocus]`
  one too). The popover's keys move over its `menuitem`, `menuitemradio`, and
  `option` elements. A replacement keeps both, or plugins' dialogs and menus
  lose their focus and keys.
- **Markdown.** The default renders blocks from `createBlockLexer`
  (`@lemma/look`), already sanitized. It keeps the DOM of each block whose
  source is unchanged, so a streaming message redraws only its tail and a
  selection in earlier text survives. Fenced code goes to the first
  `CodeBlocks` renderer that takes its language. A replacement that skips
  `CodeBlocks` drops highlighting and diagrams.
