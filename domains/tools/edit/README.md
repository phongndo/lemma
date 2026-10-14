# tools.edit

The `edit` tool: exact replacements in a file. Adds it to `Tools`. No config.
Paths resolve as `read`'s do. Its web half (`./web`) shows a call as the file
changed, with its diff.

| Input                                   | Behavior                                                                                                                                                                                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`, `edits: [{ oldText, newText }]` | Every `oldText` must match exactly once in the original file; overlapping edits, no match, several matches, and no-op edits are errors that leave the file unchanged. `details.patch` is a unified diff, `details.firstChangedLine` the first changed line. |

`applyEdits` and `unifiedPatch` are exported for reuse.

## Rationale

- **Exact edits.** Matching is exact after normalizing line endings (CRLF files
  stay CRLF, a BOM is kept). Unlike pi there is no fuzzy fallback for trailing
  whitespace or typographic quotes; a failed match tells the model to copy the
  text exactly. It also accepts the shapes pi repairs: top-level
  `oldText`/`newText`, and `edits` as a JSON string or single object. The model
  sees only the canonical schema.
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
