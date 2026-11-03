# tools.codemode

The `codemode` tool: JavaScript in pi's QuickJS sandbox that calls the other
tools, and classifier and image models. Adds it to `Tools`, and the `models`
namespace to `ToolNamespaces`. Adds a system prompt section (`PromptSections`)
naming the namespaces of the tools only scripts call, settled once a request's
tools are chosen (`AgentRequestHook`). No config. Its web half (`./web`) shows a
call as its script's first line. Opened, it shows the script, each call the
script made as it settles, and the output. The pages its `display` calls drew
show outside the fold.

| Input  | Behavior                                                                                                                                                                                                                                                                                                                          |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code` | Raw JavaScript, run as an async function body. A `// @options:` first line sets `timeout_ms` (300 seconds by default); pi's `max_output_tokens` there is ignored. Output past the call's budget (`tools.registry`'s `maxResultChars`) keeps its start and end, the whole in a temp file (`boundOutput`, in `@lemma/tools/files`). |

What a script has:

| Global                                                                            | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tools.<name>(args)`                                                              | Calls a tool the request offered. Resolves to the tool's `output` (its result's `structured`: `bash`'s `{ output, exitCode, truncated, … }` with up to 1 MiB of output, `read`'s text or image block, an MCP tool's whole `CallToolResult`), on an error result too when the tool set one; else to its text (declared `Promise<string>`), or `{ text, images }` when it has images, and an error result rejects. Calls still running when the script ends (it returns, throws, exits, or times out) are cancelled. |
| `text()`, `image()`, `console.log()`, `return`, `exit()`                          | Output, in order. Each image is also saved to a temp file whose path the output names, so a later call can move it or put it in a page.                                                                                                                                                                                                                                                                                                                                                                            |
| `store(key, value)`, `load(key)`                                                  | Small JSON values kept across scripts on the branch: a script that succeeds logs what it changed in its result (`details.storeWrites`), and a later one on the same branch starts from them all, in order.                                                                                                                                                                                                                                                                                                         |
| `ALL_TOOLS`, `searchTools(query, { limit?, namespace? })`                         | The callable tools, each with its TypeScript declaration; searching ranks them with BM25 over their names, descriptions, and namespaces' descriptions.                                                                                                                                                                                                                                                                                                                                                             |
| `describeTool(name)`, `describeNamespace(name)`                                   | A tool's description and declaration; a namespace's description, instructions, and tools (`ToolNamespaces`, matched by name or alias, `-` and `_` alike).                                                                                                                                                                                                                                                                                                                                                          |
| `models.getModelsOfType(type, provider?)`, `getAvailableOfType`, `getModelOfType` | pi's names for the models `Llm` lists: `"classifier"`, `"image"`, and `"chat"` (listed, not run).                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `models.classify(model, { state, images?, questions })`                           | Asks a classifier (`Llm.classify`), named by an entry, a ref, or `{ provider, id }`. A context of the wrong shape or an unknown model fails the script; a provider's failure is the result's `stopReason: "error"`. `models.classifiers({ available })` lists classifiers as `Llm.classifiers` does.                                                                                                                                                                                                               |
| `models.generateImages(model, { input })`                                         | Makes images with an image model (`Llm.generateImages`).                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

The `models` namespace's instructions (`describeNamespace("models")`) say how
to run these models. The tool's description points to them, so a request that
runs none does not carry them. At most four `models` calls run at once per
script, and the result's `details.usage` holds what they used. Each call a
script makes streams as a line of the codemode call's own output
(`✓ bash 12ms {"command":"ls"}`). The result's `details.calls` keeps the first
500, in the order the script made them.

## Rationale

- **Calls through the registry.** A nested call is a `Tools.execute` with the
  session's id and cwd, in the outer call's fiber context. So hooks and guards
  (an approval, a sandboxed `bash`) apply as they do to the model's own calls,
  and an approval asks the client running the turn. Scripts see the tools the
  request offered (`ToolInvocation.offered`), minus `codemode` itself and the
  `direct` ones, whose results must be logged as their own.
- **Values, not text.** A script filters and combines what tools return. So a
  tool says what a call resolves to (`Tool.output`), and hands it over beside
  what the model reads (`ToolResult.structured`, never logged). That is a
  command's whole output where the model sees its start and end, or an image
  as a block a script shows or hands to a classifier. A tool that declares
  nothing resolves to its text, and is declared so.
- **Classifiers, not chat models.** A classifier such as TypeSafe's Jev answers
  typed questions about JSON with calibrated probabilities, fast and cheaply. A
  script can use one to sort or check many items, or to decide each step of a
  loop, without spending the agent's context or a chat model's turn. Only the
  summary comes back. Chat models stay the agent's own: a request to one
  belongs in the session log, rebuildable, which a call from a script is not.
- **Durable runs.** Each script runs deterministically: pi's `start()` fixes
  its clock, randomness, and tools at the start. It journals every call it
  makes, as it begins and as it settles, in `<home>/codemode/journals`, one
  file per call, readable only by the user. A journal is deleted once the
  session logs the call's result (`SessionAppended`), or a week after its last
  write when it never is.
- **Resuming.** A host restart that cuts a script off has the agent run the
  call again (`replay: "safe"`), and the script resumes. What had settled,
  model calls included, is answered from the journal, so nothing is done or
  billed twice. What it had shown is shown again, and the rest runs.
  - A call cut off while it ran runs again only when its tool is
    `replay: "safe"`. Otherwise the script hears that it was cut off, and
    decides.
  - A call that finished before its result was logged is answered with that
    result.
  - A journal is read only for a call whose result the branch has not logged.
    So one another call left under the same id (cancelled, or from a provider
    that reuses ids) is set aside, as is one of another script.
  - A sandbox of another version would not make the same calls, so it does not
    resume: the call fails, saying so.
- **Shutting down.** A call the core refuses as it shuts down, or whose tool
  went with its plugin first, never reached its tool. It is held unanswered
  until the turn stops, and runs when the script resumes. Another call that
  fails then may have failed for that alone, so it is held too. The plugin asks
  the core whether it is shutting down (`Hooks.closed`), as the agent does,
  and only once a call fails.
- **Tools only scripts call.** `codemode` `nests`, so a request offering it
  offers a `nested` tool (an MCP server's, a browser's, Lemma's own channels)
  without declaring it to the model. A script finds such a tool by searching,
  and reads its namespace's instructions on demand. The description stays the
  same as such tools come and go, which keeps the request's prefix cached. The
  system prompt names the namespaces (the MCP servers name their own), so the
  model knows they are there. Once a request's tools are chosen (a thread's
  mode keeps some), it names only those whose tools the request still offers,
  and none without codemode (`AgentRequestHook`'s `select` phase).
- **Pages from scripts.** A script that computes data can draw it with a
  `display` tool (`html_render`). The call's result keeps what each such call
  showed (`details.displays`): its result and its input's `title`, not the
  rest of its input, which would hold a page twice. The web half draws each as
  that tool's own view does, a failed call too when its result still holds
  something for its view (an agent that failed). Every client reading the
  thread loads the logged result, so a script shows at most 20 pages, 10 MiB
  together. A call past that shows nothing, but answers as its tool did, since
  it may have done more than show (an agent's work). The result names it as
  not shown.
