# mcp.servers

Connects [Model Context Protocol](https://modelcontextprotocol.io) servers and
adds their tools to the tools registry. Provides `Mcp` (`@lemma/mcp`), serves it
as the `mcp.*` channels, and draws them in Settings › Integrations in its web
half, a section of the settings it adds (`SettingsSections`, at
`/settings/integrations`).

## Use

Add servers to `~/.lemma/mcp.json` (`<Paths.home>/mcp.json`), in the
`mcpServers` shape other MCP clients use, so an entry copied from Claude Code,
Cursor, or pi works as it is:

```json
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    "docs": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" },
      "description": "Search and read the product documentation"
    }
  }
}
```

The file is read again whenever it changes, so a server connects as soon as it
is saved.

- Settings › Integrations lists every server with its state and a switch. A
  server opened there shows why it failed, what it printed, and its tools, and
  edits or deletes its entry.
- Add a server there by a form, or by pasting JSON from another client or a
  server's README: a whole config, servers by name, or one server.
- `/settings/integrations?item=github` opens one server.
- `lemma channels call mcp.state` prints the same, and `mcp.put` writes an
  entry.

A server's icon is its entry's `icon`, else the one it declares
(`serverInfo.icons`, and `iconDark` for a dark theme). The form takes an SVG
file of at most 32 KB, written into the entry as a base64 `data:` URL, or an
image's `https:` address.

| Field                           | Meaning                                                                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`, `args`, `env`, `cwd` | A local server, started with its stdin and stdout as the connection. `command` is one executable, not a shell line. It runs in the host's directory unless `cwd` says otherwise |
| `url`, `headers`                | A remote server, over Streamable HTTP. The older SSE transport is not supported                                                                                                 |
| `type`                          | `stdio`, `http`, or `streamable-http`; optional, as `command` or `url` says which                                                                                               |
| `description`                   | What it offers, in a sentence: the model reads it in the system prompt's list of servers                                                                                        |
| `enabled`                       | `false` keeps the entry without connecting (`disabled: true`, as Cline and OpenCode write it, does the same)                                                                    |
| `exposure`                      | How its tools reach the model: `codemode` (the default), `direct`, or `hidden` (below)                                                                                          |
| `toolExposure`                  | Per tool, by the server's name for it or a pattern where `*` matches anything: `{ "search_code": "direct", "delete_*": "hidden" }`. An exact name wins, then the first pattern  |
| `timeout`                       | Seconds a request may take, 60 by default and at most about 24 days; progress the server reports restarts it                                                                    |
| `icon`                          | Its icon in Settings › Integrations (above): an image's `https:` address, or a `data:image/` URL                                                                                |
| `oauth`                         | How Lemma signs in to a remote server that asks, when its own word is not enough ([Signing in](#signing-in))                                                                    |

`${VAR}` and `${VAR:-default}` in `command`, `args`, `env`, `cwd`, `url`, and
`headers` read the host's environment. A leading `~/` in a path is the home
directory. A server whose variable is not set does not start, and says which. A
local server gets only `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, and `USER`
from the host's environment, and what its `env` names. Pass a token as
`"env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }`.

### Signing in

A remote server that answers `401`, or `403` with `insufficient_scope` in its
`WWW-Authenticate`, is `needs-sign-in` until you sign in. Any other `403` is a
failure, as another client error is.

- Its details in Settings › Integrations offer **Sign in**, which opens the
  server's authorization page in a browser.
- Once you approve, the browser comes back to
  `http://localhost:<port>/callback`, and Lemma stores the sign-in and connects.
- From a browser on another device than the host, paste the address of the page
  that failed to load into the field under the link (`mcp.finish-sign-in`).
- `/mcp login <server>` starts a sign-in from the prompt, and
  `/mcp logout <server>` forgets one.
- A call to a server whose sign-in stopped working fails, saying to sign in
  again.

How Lemma signs in:

- It finds the authorization server from the server's protected resource
  metadata (RFC 9728): at the address its refusal names, else the well-known
  one.
- It registers itself as a client when it has none for its callback address
  (Dynamic Client Registration), and signs in with PKCE.
- It takes the callback only with the sign-in's own `state`, so another tab or
  program reaching it is turned away.
- It stores what a sign-in learns (a client it registered) only once the sign-in
  succeeds.
- It renews a refused token with the refresh token, and retries the request
  once. One renewal serves every refusal that comes while it runs.
- Only a refused refresh token or registered client needs a new sign-in. A
  renewal that fails otherwise (the authorization server down) keeps the
  sign-in.
- A `403 insufficient_scope` needs a new sign-in, which asks for that scope with
  those already granted.
- A server given its own `Authorization` header is never signed in to. It is
  `failed` when it refuses that header.

`oauth` covers servers that need more than that, in the shape Claude Code
writes, so an entry copied from it works:

| Field          | Meaning                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `clientId`     | A client registered with the authorization server ahead of time, for one that registers none itself                         |
| `clientSecret` | That client's secret, if it has one, as `${VAR}`; Claude Code keeps it out of its file, so an entry copied from it has none |
| `callbackPort` | The port of `http://localhost:<port>/callback`, as registered with that client; any free port when absent                   |
| `scopes`       | The scopes to ask for, space-separated, over those the server says it needs                                                 |

The sign-ins live in `<Paths.home>/mcp-auth.json` (mode 0600), by server name:
the client registered for it, its tokens, and what was found of its
authorization server. A client the entry configures, and its secret, stay in the
entry. A sign-in made for another address than the server's is not used.
Removing a server from Integrations removes its sign-in. A file that cannot be
read, or is not a JSON object, is never written over: signing in fails, saying
why, until it is fixed or removed.

A plugin brings a server by adding it to `McpServers`
(`add(McpServers, { name, command, … })`), as pi's `registerMcpServer()` does.

- A file entry of the same name with a `command` or `url` replaces it.
- A file entry with neither changes only its `enabled`, `exposure`,
  `description`, and `timeout`, and adds its `toolExposure` patterns before the
  plugin's.
- `mcp.configure`, which the settings page calls, writes only what differs from
  the plugin's.
- `mcp.put` writes or removes a server's whole entry, keeping what another
  client keeps in it (`alwaysAllow`, say).

### How tools reach the model

A server's tools are named `mcp__<server>__<tool>`, every character other than
letters, digits, and `_` becoming `_`. A name too long for providers, or one two
of its tools would share, is shortened and ends in a hash.

| Exposure   | The model                                                                                                                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `codemode` | calls them from `codemode` scripts, found with `searchTools`. They are `nested` tools, not declared to the model while code mode is offered. The system prompt lists the servers. A server is a `ToolNamespace` named `mcp__<server>`, which a script reads with `describeNamespace` |
| `direct`   | is sent their declarations, as a builtin tool's                                                                                                                                                                                                                                      |
| `hidden`   | does not have them                                                                                                                                                                                                                                                                   |

A request that offers no tool running others (code mode off, or a request
handler removing it) declares them to the model instead (`declaredTools`, in
`@lemma/tools`). The model may call only the tools declared to it. In Settings ›
Integrations, a tool's Default drops the exposure the file gives it by name,
leaving a pattern's, the plugin's, or its server's.

## Behavior

- **Connecting.** Every enabled server connects in the background when the
  plugin starts. One that fails or drops connects again on its next call, or
  with Reconnect.
- **Retrying.** A remote server that could not be reached, or dropped, is tried
  again on its own: after 2 seconds, then longer, up to every 5 minutes
  (`retryIn`). The waits start over once a connection has held for a minute. A
  wrong address or a client error is not retried, as another try would repeat
  it.
- **Changes.** A change to how a server starts connects it again. A change to
  its exposure only re-adds its tools. Turning a server off, or reconnecting it,
  cuts off a connect under way, so a server that never answers holds up no other
  change.
- **Secrets.** A server's state (`error`, a local server's `stderr`, a sign-in's
  failure) shows a `${VAR}` reference, never the value, since a token can sit in
  a URL or a header.
- **Protocol.** The official TypeScript SDK (`@modelcontextprotocol/client`)
  speaks the stateless 2026-07-28 protocol and falls back to earlier ones. It
  asks first (`server/discover`) on a short-lived second copy of a local server,
  since a server of an earlier protocol may exit on a request it does not know.
  Which protocol a server spoke is kept in memory, so a reconnect starts no
  second copy. A connect that fails forgets it.
- **Tools.** Each tool takes the server's input schema as its parameters, its
  `$ref`s inlined. Its description ends in the server's name, which
  `searchTools` matches. A server that says its tools changed is listed again. A
  call goes through the tools registry, so hooks and guards (an approval) apply.
- **Results.** Text and images reach the model as they are. Audio, resource
  links, and binary resources become a line saying what they were. An embedded
  text resource becomes its text, and a result with only structured content its
  JSON. Text past `tools.registry`'s `maxResultChars` keeps its start and end,
  and the whole goes to a temp file the model can read (`boundOutput`, in
  `@lemma/tools/files`). `details` keeps the server, the tool, and the
  structured content, for UIs. A codemode script's call resolves to the whole
  `CallToolResult`, its `structuredContent` typed by the tool's `outputSchema`.
- **The file.** A file that is not valid JSON keeps the servers it had, and
  Settings › Integrations says what is wrong. An invalid entry fails alone. The
  settings page writes into the file without touching the rest of it, and
  removes a value the server would have without it. A file that is a link (one
  home-manager keeps) is written where it links to. When that cannot be written,
  the page says to change it where it is managed.
- **`/mcp` in the prompt** (`PromptCommands`,
  [`@lemma/threads`](../../threads/contract/src/threads.ts)): `list` (`ls`),
  `login` (`sign-in`), `logout` (`sign-out`), `reconnect`, `enable` (`on`),
  `disable` (`off`), `exposure <server> <codemode|direct|hidden>`, and
  `tool <server> <tool> <exposure>`, where `default` removes the file's own.

## Rationale

- **Code mode by default.** An MCP server can bring dozens of tools, and their
  declarations would be sent with every request and change as servers come and
  go. As `nested` tools they cost nothing until a script searches for them, the
  request's tool list stays the same (and with it the prompt cache), and a
  script can combine their calls and keep their large output out of the context.
  This is the default pi and OpenCode chose; Claude Code and Codex instead load
  tools by search.
- **Its own file, not this plugin's config row.** A project's row replaces the
  user's whole config object, so servers could not be added per project, and the
  `mcpServers` shape is one people already have.
- **The official SDK.** It speaks both protocol eras, and keeps up with the
  specification, its OAuth client included: Lemma supplies where a sign-in is
  kept and how the browser comes back, not the protocol.
- **Sign-ins in a file of their own, not `auth.json`.** `auth.json`'s entries
  are model providers' (pi-ai lists them as such), and a server's sign-in holds
  more than a token: the client Lemma registered with its authorization server,
  and what it found of that server.
- **The browser comes back to `localhost`.** The callback listens only while a
  sign-in waits, on the host's loopback addresses, at
  `http://localhost:<port>/callback`, the form Claude Code uses, which
  authorization servers that match a registered address exactly expect. A
  browser that cannot reach it has the paste, as model providers' sign-ins do.
- **Agents read the servers' states, and may ask to sign in.** `mcp.list`
  declares it only reads and holds no address or entry, so `tools.lemma` offers
  it to scripts, which can see why a server's tools are missing; which of the
  other channels it offers, and on what terms, [its
  README](../../tools/lemma/README.md) says.

Not yet: a project's servers (`.mcp.json`), resources, prompts, and elicitation
(the plugin declares no elicitation capability, so servers do not ask); and for
signing in, `authServerMetadataUrl` and clients identified by a metadata
document (Client ID Metadata Documents), which a server with Dynamic Client
Registration does not need.
