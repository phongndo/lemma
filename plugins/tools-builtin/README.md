# @lemma/plugin-tools-builtin

The five coding tools, each its own plugin whose id is the tool name: `read`,
`write`, `edit`, `bash`, and `codemode`. Each requires `Tools`. Behavior,
descriptions, and limits follow pi's tools.

```ts
import builtin, { bash, codemode, edit, read, write } from "@lemma/plugin-tools-builtin";

makeCore([tools, ...builtin]); // default export: all five, as an array
makeCore([tools, read, write, edit, myBash]); // replace one by leaving it out
```

The tools themselves (`readTool`, …) and helpers (`applyEdits`, `unifiedPatch`,
`truncateHead`/`truncateTail`) are exported for reuse. No config.

| Tool       | Input                                   | Behavior                                                                                                                                                                                                                                                                                                                                                                |
| ---------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`     | `path`, `offset?` (1-based), `limit?`   | Raw text, cut at 2000 lines or 50KB with a `Use offset=N to continue` notice. PNG/JPEG/GIF/WebP (by magic bytes) come back as an image part; images over 3.75MB are described instead.                                                                                                                                                                                  |
| `write`    | `path`, `content`                       | Creates parent directories; overwrites.                                                                                                                                                                                                                                                                                                                                 |
| `edit`     | `path`, `edits: [{ oldText, newText }]` | Every `oldText` must match exactly once in the original file; overlapping edits, no match, several matches, and no-op edits are errors that leave the file unchanged. `details.patch` is a unified diff, `details.firstChangedLine` the first changed line.                                                                                                             |
| `bash`     | `command`, `timeout?` (seconds)         | `bash -c` in the session cwd, stdout+stderr combined, tail-truncated to 2000 lines or 50KB; the full output goes to a temp file named in the result. Non-zero exit, timeout, and abort are error results; `details.exitCode` carries the code.                                                                                                                          |
| `codemode` | `code`                                  | JavaScript in pi's QuickJS sandbox; `await tools.<name>(args)` resolves to a tool's text, and an error result rejects. Output past 10,000 tokens, or past what the `tools` plugin's `maxResultChars` leaves room for, keeps its start and end, the rest in a temp file. A `// @options:` first line sets `max_output_tokens` and `timeout_ms` (300 seconds by default). |

Paths resolve against the session cwd; `~` expands and a leading `@` is dropped.

## Rationale

- **One plugin per tool** so a composition can drop or replace one (a sandboxed
  `bash`) by id. They are `exclusive`: the registry rejects duplicate names, so a
  reload must unregister before re-registering.
- **Exact edits.** Matching is exact after normalizing line endings (CRLF files
  stay CRLF, a BOM is kept). Unlike pi there is no fuzzy fallback for trailing
  whitespace or typographic quotes; a failed match tells the model to copy the
  text exactly. `edit` also accepts the shapes pi repairs: top-level
  `oldText`/`newText`, and `edits` as a JSON string or single object. The model
  sees only the canonical schema.
- **No image resizing** (pi resizes with a native dependency). The size cap keeps
  an oversized image from entering the history, where it would fail every later
  request.
- **Process groups.** `bash` spawns the shell as a group leader; abort and timeout
  kill the whole group. After the shell exits, output is read until the pipes go
  idle for 100ms, so a background child holding them cannot hang the call.
- Writes and edits to one file are serialized in-process (per real path).
- **Codemode calls through the registry.** A nested call is a `Tools.execute`
  with the session's id and cwd, in the outer call's fiber context, so hooks
  and guards (an approval, a sandboxed `bash`) apply as they do to the model's
  own calls, and an approval asks the client running the turn. Scripts see the tools the request
  offered (`ToolInvocation.offered`), minus `codemode` itself, and nested
  output streams as the codemode call's own. Unlike pi, a call always
  resolves to text (pi's `bash` returns an object), `store`/`load` keep nothing
  between scripts, `models` is absent, and `searchTools` matches words rather
  than ranking with BM25.
- **Only `read` repeats or runs alongside others.** It is `replay: "safe"` and
  `parallel: "safe"`: reads the model asks for together run together, and a
  read a host restart cut off runs again; a cut-off `write`, `edit`, `bash`, or `codemode` is reported to
  the model as interrupted instead, since running it twice could do harm (pi's
  tools repeat none).
