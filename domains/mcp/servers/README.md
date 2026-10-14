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

`${VAR}` and `${VAR:-default}` in `command`, `args`, `env`, `cwd`, `url`, and `headers` read the host's environment, and a leading `~/` in a path is the home directory. A server whose variable is not set does not start, and says which. A local server gets only `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, and `USER` from the host's environment, and what its `env` names: pass a token as `"env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }`.

A plugin brings a server by adding it to `McpServers` (`add(McpServers, { name, command, … })`), as pi's `registerMcpServer()` does. An entry in the file with the same name and a `command` or `url` takes its place; one with neither changes only its `enabled`, `exposure`, `description`, and `timeout`, and adds its `toolExposure` to the plugin's, its patterns tried first. That is what `mcp.configure`, which the settings page calls, writes for it: only what differs from the plugin's. `mcp.put` writes a server's whole entry, or removes it, keeping what another client keeps in it (`alwaysAllow`, say).

### How tools reach the model

A server's tools are named `mcp__<server>__<tool>`, every character other than letters, digits, and `_` becoming `_` (a name too long for providers, or one two of its tools would share, is shortened and ends in a hash).

| Exposure   | The model                                                                                                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `codemode` | calls them from `codemode` scripts, finding them with `searchTools`: they are `nested` tools, offered to each request but not declared to the model while code mode is, and the system prompt lists the servers that have them |
| `direct`   | is sent their declarations, as a builtin tool's                                                                                                                                                                                |
| `hidden`   | does not have them                                                                                                                                                                                                             |

A request that offers no tool running others (code mode off, or a request handler removing it) declares them to the model instead (`declaredTools`, in `@lemma/tools`), and the model may call only the tools declared to it. In Settings › Integrations a tool's Default drops the exposure the file gives it by name, leaving a pattern's, the plugin's, or its server's, which the page names.

## Config

| Key              | Default | Meaning                                                                                                                                                                                                      |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `maxOutputChars` | `40000` | Text characters of a result the model reads: past them, or past what `tools.registry`'s `maxResultChars` leaves room for, it keeps the start and the end, and the whole text goes to a temp file it can read |

## Behavior

- **Connecting.** Every enabled server connects when the plugin starts, in the background, and stays connected; one that fails or drops connects again on its next call, or with Reconnect. A change to how a server is started connects it again; a change to its exposure only re-adds its tools. Turning a server off, or reconnecting it, cuts off a connect under way, so a server that never answers holds up no other change.
- **Protocol.** Through the official TypeScript SDK (`@modelcontextprotocol/client`), which speaks the stateless 2026-07-28 protocol and falls back to the earlier ones a server may speak only: it asks first (`server/discover`), on a short-lived second copy of a local server.
- **Tools.** Each listed tool is added with the server's input schema as its parameters (its own `$ref`s inlined) and its title and description, ending in the server's name, which `searchTools` also matches. When a server says its tools changed, they are listed again: new ones are added, withdrawn ones removed. A call goes through the tools registry, so hooks and guards (an approval) apply to it as to any tool's.
- **Results.** Text and images reach the model as they are; audio, resource links, and binary resources as a line saying what they were, and an embedded text resource as its text. A result with only structured content is its JSON. `details` keeps the server, the tool, and the structured content, for UIs.
- **The file.** One that is not valid JSON keeps the servers it had, and Settings › Integrations says what is wrong with it; an entry that is invalid fails alone. Changes from the settings page are written into the file without touching the rest of it, a value the server would have without it removed rather than written. A file that is a link (one home-manager keeps, say) is written where it links to; when that cannot be written, the page says to change it where it is managed.

## Rationale

- **Code mode by default.** An MCP server can bring dozens of tools, and their declarations would be sent with every request and change as servers come and go. As `nested` tools they cost nothing until a script searches for them, the request's tool list stays the same (and with it the prompt cache), and a script can combine their calls and keep their large output out of the context. This is the default pi and OpenCode chose; Claude Code and Codex instead load tools by search.
- **Its own file, not this plugin's config row.** A project's row replaces the user's whole config object, so servers could not be added per project, and the `mcpServers` shape is one people already have.
- **The official SDK.** It speaks both protocol eras, and keeps up with the specification.

Not yet: OAuth sign-in for remote servers (give such a server an `Authorization` header), a project's servers (`.mcp.json`), resources, prompts, and elicitation (the plugin declares no elicitation capability, so servers do not ask).
