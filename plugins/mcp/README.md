# @lemma/plugin-mcp

Connects Lemma to [MCP](https://modelcontextprotocol.io) servers and gives the
model their tools (plugin id `mcp`). Requires `Tools`, `Credentials`,
`Interaction`, `HostControl`, and `Paths`; provides nothing. It contributes the
bundled `McpManagers` entry (`@lemma/contracts`), through which the transport's
`Mcp.*` calls, the web app's MCP servers page, and `lemma mcp` manage servers.
The transport reads that registry rather than requiring MCP, so this plugin can
be turned off (those calls then fail `Unavailable`) or replaced by one that
contributes its own manager.

```jsonc
{
  "plugins": {
    "mcp": {
      "config": {
        "servers": [
          // A command Lemma runs (stdio).
          { "id": "playwright", "command": "npx", "args": ["-y", "@playwright/mcp@0.0.41"] },
          // A URL (Streamable HTTP, falling back to the older HTTP+SSE). Signs in with OAuth when the server asks.
          { "id": "linear", "url": "https://mcp.linear.app/mcp" },
          // A key the server needs: `${NAME}` reads a secret stored for the server, else the host's environment.
          { "id": "github", "url": "https://api.githubcopilot.com/mcp/", "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" } },
        ],
      },
    },
  },
}
```

Settings → MCP servers and `lemma mcp add` write these rows from a URL, a
command line, or a config pasted from a server's README or another client
(`parseMcpInput` in the contracts), and store credential-looking values as the
server's secrets in the credential store (`auth.json`) instead of the config.

## Config

| Key                | Default  | Meaning                                                                                                       |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------------- |
| `servers`          | `[]`     | The servers (below).                                                                                          |
| `startupTimeoutMs` | `30000`  | How long connecting to a server may take.                                                                     |
| `toolTimeoutMs`    | `300000` | How long a tool call may go without a result or reported progress. No call outlives an hour.                  |
| `startupWaitMs`    | `10000`  | How long the first model request after a start waits for servers still making their first connection.         |
| `maxOutputChars`   | `40000`  | Text of a result the model reads; past it the middle is cut and the whole text saved to a file it can `read`. |

A server (`McpServerSpec` in the contracts) has an `id` (letters, digits, `_`,
`-`), an optional `name`, and either a `command` with `args`, `env`, and `cwd`
(default: the host's directory) or a `url` with `headers`; `type` (`stdio`,
`http`, `sse`) is inferred when absent. Each may set `enabled`,
`disabledTools` (by the server's names), `toolTimeoutMs`, `startupTimeoutMs`,
and `oauth` (`clientId`, `clientSecret`, `scopes`, `callbackPort`) for a server
whose sign-in needs a client registered in advance. `${NAME}` and
`${NAME:-fallback}` work in every string; a name that resolves to nothing keeps
the server from starting and says which.

## Behavior

- **Connections** start in the background when the plugin does; nothing waits
  for them except the first model request after a start, at most
  `startupWaitMs`. A server that fails to connect is retried after 1, 2, 4, 8,
  and 16 seconds, then left until it is restarted or a tool call needs it. A
  server that drops after connecting is lost and retried the same way (a crash
  after 30 seconds up gets its retries back). A URL server that forgot the
  connection's session (404) is connected to again and the call made once
  more; one that refuses the sign-in mid-way goes back to `auth`. Every server
  is one connection for the whole host, shared by every session.
- **Across reloads** a connection whose server did not change is handed to the
  plugin's replacement instead of closed, so turning one server's tool off
  does not restart the others, or lose a browser a server holds open.
- **stdio servers** run in their own process group, inheriting the host's
  environment except names that look like credentials (`*_API_KEY`,
  `*_TOKEN`, `*SECRET*`, …); pass one with `"env": { "GITHUB_TOKEN":
"${GITHUB_TOKEN}" }`. Closing one closes its stdin, then sends SIGTERM, then
  SIGKILL to the group, so what `npx` or `uvx` started stops too. Its stderr,
  and any stdout line that is not a protocol message, is kept in its log
  (`Mcp.Logs`) rather than printed or failing the connection.
- **Tools** are registered while their server is connected, named
  `mcp__<server>__<tool>` with anything but letters, digits, and `_` made `_`,
  and cut to 64 characters with a hash when longer or when two of a server's
  tools would read the same. Their input schema is the server's, with local
  `$ref`s inlined, and descriptions are cut at 2,048 characters. A server's
  `list_changed` registers and unregisters tools as it goes. A tool the server
  marks read-only is `replay: "safe"`. Progress the server reports streams as
  the call's output and keeps the call alive.
- **Results** have two readers. The model reads content: text and PNG, JPEG,
  GIF, or WebP images pass through; audio, other images, binary resources, and
  resource links are described in text; structured output is JSON only when
  the server sent nothing else. A codemode script reads data: each tool
  declares the server's output schema as its `outputSchema` (`unknown` without
  one), and a call resolves to the structured result, else the JSON object or
  array its text holds, else its text; a result with an image or a resource
  resolves to its content blocks. A result the server marks `isError` rejects
  with its text.
- **Resources.** While a connected server offers resources, `mcp_resources`
  lists them and `mcp_read_resource` reads one.
- **Questions** a server asks (elicitation) go through `Interaction` to the
  client running the turn: whether to answer, then each field; a URL it asks
  you to open arrives as a notice. Declining and dismissing are the protocol's
  decline and cancel. Sampling and roots are not offered (both are deprecated
  in the 2026-07-28 spec).
- **Signing in.** A URL server that answers 401 waits in status `auth` until
  `login`: Lemma discovers its authorization server, registers itself
  dynamically unless `oauth.clientId` is set, and publishes the sign-in page as
  a notice (source `mcp:<id>`). It listens for the redirect on
  `localhost:<port>/callback` while asking, through `Interaction`, for the
  address to be pasted, for a browser on another machine. Tokens and the
  registration are stored under `mcp-oauth:<id>` and refreshed as they expire.
  A server with its own `Authorization` header is never signed in.
- **Secrets** a client sends with a server are stored under `mcp:<id>`, never
  in the config; clients see their names. Config values under credential-like
  names come back to clients as `MCP_HIDDEN`, which a save keeps as it was.
- **Inspector.** `mcp.servers` (`lemma inspectors mcp.servers`) lists each
  server's status and tools.

## Reaching tools

Every MCP tool is reached through codemode: a request that has the `codemode`
tool offers them as `RequestDraft.reachable`, out of the model's tool list, so
scripts find them with `searchTools` (each with its TypeScript declaration)
and call them as `tools.mcp__<server>__<tool>`, through the registry, where
hooks and guards apply as to any call. A request without `codemode` declares
them like any tool. Either way an `mcp-servers` system section names each
enabled server, whether it needs a sign-in, and its instructions (cut at 2,048
characters), and says how calls resolve.

## Rationale

- **Codemode only.** Tool definitions cost context in every request (a GitHub
  server's run to tens of thousands of tokens), and a tool list that changes
  when a server connects invalidates the provider's prompt cache. pi, OpenCode
  (v2), and Executor reach MCP tools through code by default; Claude Code and
  Codex defer them behind a search. Codemode is the search here, and with one
  way in there is no per-server setting to choose or explain.
- **Data, not the protocol's envelope.** pi, Codex, and Executor hand scripts
  the whole `CallToolResult`; Executor's declared type for it drifted from
  what calls returned twice (its #851, #2108), and scripts had to dig the data
  out of `structuredContent` or parse text. Cloudflare's code mode unwraps as
  this plugin does, so a script reads the data its declaration names and
  handles failure as any rejected call.
- **The section, not the tool list, names the servers**, and it changes only
  when a server is added, removed, needs a sign-in, or first connects (its
  instructions), not on every reconnect.
- **One connection per server for the host**, because sessions share the
  host's composition. A server that should run in each project's directory
  needs per-project connections and per-project tool names in the registry,
  which this plugin does not do yet; a project's own `.mcp.json` is not read.
- **Own stdio transport.** The SDK's passes a fixed handful of environment
  variables, kills only its direct child (leaving `npx`'s server running), and
  fails a connection on a stray stdout line; orphaned servers and broken
  connections are the most reported MCP bugs in other clients.
- **Questions go through `Interaction`**, not a dialog of this plugin's, so the
  web app, the CLI, and any client answer them as they answer a login.
- **No per-server approval prompt**: servers come from the user's own config,
  which only the user (or a trusted project) writes. A project's MCP config
  would need content-bound approval (re-asking when its command changes); see
  Cursor's CVE-2025-54136.
