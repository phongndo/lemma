# tools.edit

The `edit` tool: targeted replacements in a file. Adds it to `Tools`. No config.
Paths resolve as `read`'s do. Its web half (`./web`) shows a call as the file
changed, with its diff.

| Input                                   | Behavior                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `path`, `edits: [{ oldText, newText }]` | Every `oldText` must match once in the original file, exactly or else as pi's fallback does (below); overlapping edits, no match, several matches, and no-op edits are errors that leave the file unchanged. `details.patch` is a unified diff (`@lemma/tools/diff`), `details.firstChangedLine` the first changed line. |

`applyEditsToNormalizedContent` is exported for reuse.

## Rationale

- **pi's edit.** The matching and applying are pi's code, copied
  ([`src/edit-diff.ts`](src/edit-diff.ts), from pi's
  [`edit-diff.ts`](https://github.com/earendil-works/pi/blob/2ec55d8/packages/coding-agent/src/core/tools/edit-diff.ts)),
  as are the tool's name, schema, and messages: pi is where Lemma's tools come
  from, and its edit is well used. So is its fallback: an `oldText` found
  nowhere exactly is looked for with trailing whitespace ignored and Unicode
  quotes, dashes, and spaces (and NFKC forms) as ASCII, and must be unique
  there. Then every edit of the call matches that way, and the lines the edits
  cover are written as normalized; the lines they do not cover keep their
  bytes. Occurrences are counted without overlaps, so `"}\n}\n"` is in
  `"}\n}\n}\n"` once. Models copy text imperfectly, and lenient matching pays:
  [Aider measured 9x more editing errors with its flexible patching turned
  off](https://aider.chat/docs/unified-diffs.html#be-flexible-when-applying-edits)
  (2023). It also accepts the shapes pi repairs: top-level `oldText`/`newText`,
  and `edits` as a JSON string or single object. The model sees only the
  canonical schema.
- **Lemma's writing.** Matching is on LF text, with the BOM aside, and the file
  is written back with its line ending and BOM, as pi does; what Lemma adds is
  how the file is written, below.
- **One at a time.** Writes and edits to one file run one at a time
  in-process, by real path, so each edit matches against what the last one
  left: two edits of the same text cannot both apply, and the second fails as
  any edit whose text is gone does. A change another process makes between an
  edit's read and its write is lost.
- **Whole or not at all.** The edited file replaces the old one in one rename
  (`replaceFile` in `@lemma/tools/files`), so a crash or a full disk leaves the
  old file, not a truncated one. It keeps the file's mode, and through a
  symlink it edits the target. A file another user owns, or in a directory
  the user cannot add to, is edited in place instead.
