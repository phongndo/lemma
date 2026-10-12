# tools.codemode

The `codemode` tool: JavaScript in pi's QuickJS sandbox that calls the other
tools. Adds it to `Tools`; requires `ToolRunner`, which its scripts call the other tools through. No config.

| Input  | Behavior                                                                                                                                                                                                                                                                                                                                                                   |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code` | `await tools.<name>(args)` resolves to a tool's text, and an error result rejects. Output past 10,000 tokens, or past what `tools.registry`'s `maxResultChars` leaves room for, keeps its start and end, the rest in a temp file (`boundOutput`, in `@lemma/tools/files`). A `// @options:` first line sets `max_output_tokens` and `timeout_ms` (300 seconds by default). |

## Rationale

- **Calls through the registry.** A nested call is a `Tools.execute` with the
  session's id and cwd, in the outer call's fiber context, so hooks and guards
  (an approval, a sandboxed `bash`) apply as they do to the model's own calls,
  and an approval asks the client running the turn. Scripts see the tools the
  request offered (`ToolInvocation.offered`), minus `codemode` itself, and
  nested output streams as the codemode call's own. Unlike pi, a call always
  resolves to text (pi's `bash` returns an object), `store`/`load` keep nothing
  between scripts, `models` is absent, and `searchTools` matches words rather
  than ranking with BM25.
- **Tools only scripts call.** `codemode` `nests`, so a request offering it
  offers a `nested` tool (an MCP server's, by default) without declaring it to
  the model, which calls it only from a script: a script finds its declaration
  by searching, as the description says (`await searchTools(query)`), and the
  description stays the same as such tools come and go, keeping the request's
  prefix cached.
