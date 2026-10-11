# tools.edit

The `edit` tool: exact replacements in a file. Requires `Tools`. No config.
Paths resolve as `read`'s do.

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
- Writes and edits to one file run one at a time in-process, by real path.
