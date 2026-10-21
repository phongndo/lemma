# mcp.servers

Connects [Model Context Protocol](https://modelcontextprotocol.io) servers and adds their tools to the tools registry. Provides `Mcp` (`@lemma/mcp`), serves it as the `mcp.*` channels, and draws them in Settings › Integrations in its web half. Requires `Paths`.

## Use

Add servers to `~/.lemma/mcp.json` (`<Paths.home>/mcp.json`), in the `mcpServers` shape other MCP clients use, so an entry copied from Claude Code, Cursor, or pi works as it is:

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

The file is read again whenever it changes: a server connects as soon as it is saved. Settings › Integrations lists every server with its state and a switch; one opened shows why it failed (and what it printed), how it is reached, and its tools and how they reach the model, and edits or removes its entry. Add one there by a form, or by pasting JSON from another client or a server's README (a whole config, servers by name, or one server). `lemma channels call mcp.state` prints the same, and `mcp.put` writes an entry.

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
| `icon`                          | An image's address (`https:`, or a `data:image/` URL) drawn as its icon in Integrations, over the one the server declares about itself (`serverInfo.icons`)                     |
| `oauth`                         | How Lemma signs in to a remote server that asks, when its own word is not enough ([Signing in](#signing-in))                                                                    |

`${VAR}` and `${VAR:-default}` in `command`, `args`, `env`, `cwd`, `url`, and `headers` read the host's environment, and a leading `~/` in a path is the home directory. A server whose variable is not set does not start, and says which. A local server gets only `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, and `USER` from the host's environment, and what its `env` names: pass a token as `"env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }`.

### Signing in

A remote server that answers `401` or `403` asks to be signed in to, and is `needs-sign-in` until it is: Settings › Integrations counts it among the integrations in trouble, and its details offer **Sign in**. Signing in opens the server's authorization page in a browser; once you approve, the browser comes back to Lemma at `http://localhost:<port>/callback`, and Lemma stores the sign-in and connects. A browser on another device than the host lands on a page that does not load: paste its address into the field under the page's link (`mcp.finish-sign-in`). `/mcp login <server>` starts one from the prompt, and `/mcp logout <server>` forgets one. A call to a server whose sign-in stopped working fails, saying the person signs in, and Settings shows it as needing sign-in again.

Lemma finds the server's authorization server from the server (its protected resource metadata, RFC 9728, at the address its refusal names, else the well-known one, then the authorization server's own), registers itself there as a client when it has none for the address the browser comes back to (Dynamic Client Registration), and signs in with PKCE; the browser's way back is taken only with the sign-in's own `state`, so another tab or program reaching it is turned away and the sign-in waits on. What a sign-in learns on the way (a client it registered) is stored only once it succeeds, so one stopped halfway leaves the sign-in Lemma holds as it was. Lemma sends the token with each request, and renews it with its refresh token when the server refuses it, retrying the request once, one renewal for every refusal that comes while it runs; only when the authorization server refuses the refresh token does the server need signing in again, and a renewal that fails otherwise (the authorization server down) keeps the sign-in for the next call. A server that refuses for want of a scope (`403 insufficient_scope`) needs signing in again too, and the next sign-in asks for that scope with those already granted. A server given its own `Authorization` header is never signed in to: it is `failed` when it refuses that header.

`oauth` covers servers that need more than that, in the shape Claude Code writes, so an entry copied from it works:

| Field          | Meaning                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `clientId`     | A client registered with the authorization server ahead of time, for one that registers none itself                         |
| `clientSecret` | That client's secret, if it has one, as `${VAR}`; Claude Code keeps it out of its file, so an entry copied from it has none |
| `callbackPort` | The port of `http://localhost:<port>/callback`, as registered with that client; any free port when absent                   |
| `scopes`       | The scopes to ask for, space-separated, over those the server says it needs                                                 |

The sign-ins live in `<Paths.home>/mcp-auth.json` (mode 0600), by server name: the client registered for it, its tokens, and what was found of its authorization server; a client the entry configures, and its secret, stay the entry's. One made for another address than the server's is not used, and removing a server from Integrations removes its sign-in.

A plugin brings a server by adding it to `McpServers` (`add(McpServers, { name, command, … })`), as pi's `registerMcpServer()` does. An entry in the file with the same name and a `command` or `url` takes its place; one with neither changes only its `enabled`, `exposure`, `description`, and `timeout`, and adds its `toolExposure` to the plugin's, its patterns tried first. That is what `mcp.configure`, which the settings page calls, writes for it: only what differs from the plugin's. `mcp.put` writes a server's whole entry, or removes it, keeping what another client keeps in it (`alwaysAllow`, say).

### How tools reach the model

A server's tools are named `mcp__<server>__<tool>`, every character other than letters, digits, and `_` becoming `_` (a name too long for providers, or one two of its tools would share, is shortened and ends in a hash).

| Exposure   | The model                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codemode` | calls them from `codemode` scripts, finding them with `searchTools`: they are `nested` tools, offered to each request but not declared to the model while code mode is, and the system prompt lists the servers that have them. A server with tools is a `ToolNamespace` named `mcp__<server>` (its name an alias), described by its `description` or the first line of what it tells clients, which a script reads whole with `describeNamespace` |
| `direct`   | is sent their declarations, as a builtin tool's                                                                                                                                                                                                                                                                                                                                                                                                    |
| `hidden`   | does not have them                                                                                                                                                                                                                                                                                                                                                                                                                                 |

A request that offers no tool running others (code mode off, or a request handler removing it) declares them to the model instead (`declaredTools`, in `@lemma/tools`), and the model may call only the tools declared to it. In Settings › Integrations a tool's Default drops the exposure the file gives it by name, leaving a pattern's, the plugin's, or its server's, which the page names.

## Config

| Key              | Default | Meaning                                                                                                                                                                                                      |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `maxOutputChars` | `40000` | Text characters of a result the model reads: past them, or past what `tools.registry`'s `maxResultChars` leaves room for, it keeps the start and the end, and the whole text goes to a temp file it can read |

## Behavior

- **Connecting.** Every enabled server connects when the plugin starts, in the background, and stays connected; one that fails or drops connects again on its next call, or with Reconnect. A remote server that could not be reached, or dropped its connection, is also tried again on its own, after 2 seconds, then longer, up to every 5 minutes (`retryIn`), until it connects; not one whose address is wrong, or that answered with a client error, which another try would repeat. A change to how a server is started connects it again; a change to its exposure only re-adds its tools. Turning a server off, or reconnecting it, cuts off a connect under way, so a server that never answers holds up no other change.
- **Errors.** What a server's state says (`error`, a local server's `stderr`, a sign-in's failure) shows a `${VAR}` reference where the entry has one, never the value the host's environment gave it, since a token can sit in a URL or a header.
- **Protocol.** Through the official TypeScript SDK (`@modelcontextprotocol/client`), which speaks the stateless 2026-07-28 protocol and falls back to the earlier ones a server may speak only: it asks first (`server/discover`), on a short-lived second copy of a local server, since a server of the earlier ones may exit on a request it does not know. Which one a server spoke is kept, in memory, by how it is started: connecting it again asks nothing of one that spoke an earlier protocol, and asks one that spoke 2026-07-28 on its own process, so no second copy starts (a reconnect of a Node.js server takes half the time). A connect that fails forgets it, and the next asks again, as does each host's first.
- **Tools.** Each listed tool is added with the server's input schema as its parameters (its own `$ref`s inlined) and its title and description, ending in the server's name, which `searchTools` also matches. When a server says its tools changed, they are listed again: new ones are added, withdrawn ones removed. A call goes through the tools registry, so hooks and guards (an approval) apply to it as to any tool's.
- **Results.** Text and images reach the model as they are; audio, resource links, and binary resources as a line saying what they were, and an embedded text resource as its text. A result with only structured content is its JSON. `details` keeps the server, the tool, and the structured content, for UIs. A codemode script's call resolves to the whole `CallToolResult` (`{ content, structuredContent?, isError? }`, every block as the server sent it, before the model's text is bounded), its `structuredContent` typed by the tool's `outputSchema`.
- **The file.** One that is not valid JSON keeps the servers it had, and Settings › Integrations says what is wrong with it; an entry that is invalid fails alone. Changes from the settings page are written into the file without touching the rest of it, a value the server would have without it removed rather than written. A file that is a link (one home-manager keeps, say) is written where it links to; when that cannot be written, the page says to change it where it is managed.
- **`/mcp` in the prompt.** The web half adds `/mcp` to `PromptCommands` ([`@lemma/threads`](../../threads/contract/src/threads.ts)): `list` (`ls`) shows each server's state; `login` (`sign-in`) starts a sign-in and leaves the page's link in a message, and `logout` (`sign-out`) forgets one; `reconnect`, `enable` (`on`), and `disable` (`off`) take a server, offered among those it applies to; `exposure <server> <codemode|direct|hidden>` sets a server's; `tool <server> <tool> <exposure>` sets one tool's, its tools offered once the server is typed, and `default` removing the file's own.

## Rationale

- **Code mode by default.** An MCP server can bring dozens of tools, and their declarations would be sent with every request and change as servers come and go. As `nested` tools they cost nothing until a script searches for them, the request's tool list stays the same (and with it the prompt cache), and a script can combine their calls and keep their large output out of the context. This is the default pi and OpenCode chose; Claude Code and Codex instead load tools by search.
- **Its own file, not this plugin's config row.** A project's row replaces the user's whole config object, so servers could not be added per project, and the `mcpServers` shape is one people already have.
- **The official SDK.** It speaks both protocol eras, and keeps up with the specification, its OAuth client included: Lemma supplies where a sign-in is kept and how the browser comes back, not the protocol.
- **Sign-ins in a file of their own, not `auth.json`.** `auth.json`'s entries are model providers' (pi-ai lists them as such), and a server's sign-in holds more than a token: the client Lemma registered with its authorization server, and what it found of that server.
- **The browser comes back to `localhost`.** The callback listens only while a sign-in waits, on the host's loopback addresses, at `http://localhost:<port>/callback`, the form Claude Code uses, which authorization servers that match a registered address exactly expect. A browser that cannot reach it has the paste, as model providers' sign-ins do.
- **Agents read the servers' states, and may ask to sign in.** `mcp.list` declares it only reads and holds no address or entry, so `tools.lemma` offers it to scripts, which can see why a server's tools are missing. Starting a sign-in asks the person first there; finishing one, whose address carries a code, is never offered.

Not yet: a project's servers (`.mcp.json`), resources, prompts, and elicitation (the plugin declares no elicitation capability, so servers do not ask); and for signing in, `authServerMetadataUrl` and clients identified by a metadata document (Client ID Metadata Documents), which a server with Dynamic Client Registration does not need.
