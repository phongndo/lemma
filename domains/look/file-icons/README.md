# look.file-icons

Shows each file as its type's icon (TypeScript, Rust, Nix, a Dockerfile, …),
in that type's color, wherever the app names a file. Adds to `FileIconPart`
([`@lemma/look`](../contract/src/parts.tsx)) just below `DEFAULT_PART_ORDER`,
over `look.kit`'s plain icons, which return when it is turned off; a folder
keeps the `folder` icon (`IconPart`). Requires `Slots`.

| Config  | Default | What it does                                                                                                                                                                                                       |
| ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rules` | unset   | Matches of your own, tried before the built-in ones: `.mdc = markdown` (or `*.mdc`) for an extension, `Justfile = bash` for a whole name. The type is a glyph's name in [`src/file-glyphs.ts`](src/file-glyphs.ts) |

## Behavior

- **Matching.** A file's name, in lower case, is matched whole first
  (`package.json`, `Dockerfile`), then by its extensions from the longest
  (`a.d.ts` tries `d.ts`, then `ts`), so a compound extension can have a type
  of its own. A path's last `/` or `\` starts its name. A file with no match
  is `default`.
- **Rules.** All of them come before the built-in tables, so `.md = text`
  covers `README.md` too, which the tables name whole. A line without `=`,
  or naming a type that has no glyph, is skipped.
- **Colors.** Each type draws in one of a few hues, tokens its stylesheet
  sets for each scheme (`--file-icon-blue`, `--file-icon-green`, …); a type
  without a hue is `--file-icon-muted`. A theme's `tokens` or a stylesheet of
  yours changes a hue, and `.file-type[data-type="rust"]` one type.

The glyphs and tables start from Pierre's (`@pierre/trees`, Apache-2.0); the
headers of `src/file-glyphs.ts` and `src/file-icons.ts` say what changed and
what comes from elsewhere.
