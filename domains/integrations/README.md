# integrations

Settings › Integrations: what Lemma works with besides its own models, in one list beside the open item. Its kinds, such as the MCP servers that give agents tools ([mcp.servers](../mcp/servers/README.md)), are each added by the plugin that runs it. Its contract is [`@lemma/integrations`](contract/src/index.ts).

| Plugin                       | Halves | What it does                                                                                                                   |
| ---------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| [`integrations.page`](page/) | web    | The page: every kind's items, filtered as you type, the open one's details, and an Add dialog searching what every kind offers |

The page holds no kind of its own: an item's row (its icon, version, status in a few words, with a dot only for trouble, and a switch), its details, what it offers to add, and its form for one it does not offer are its kind's, drawn with the page's classes (`DetailClasses`) so every kind reads alike. The address names the open item (`/settings/integrations?kind=mcp&item=github`), and a search of the settings finds each one. The `+` opens one search over every kind's offers (`IntegrationCatalog`), each added by picking it, and each kind's own form after them (`Custom MCP server…`). The section's badge counts the items in error.

## Extending it

What the contract offers in each of the [five shapes](../../docs/plugins.md#the-five-shapes):

| Shape     | What the contract offers                                                                                                                                                                       |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add       | `IntegrationKinds`: a kind of integration, with its items, an item's details, what it offers to add (`IntegrationCatalog` of `IntegrationOffer`s), and its form; `IntegrationsSection`, its id |
| Intercept | Nothing: a kind draws its own details                                                                                                                                                          |
| Observe   | Nothing                                                                                                                                                                                        |
| Call      | `Settings.open(IntegrationsSection, { kind, item })` (`@lemma/settings`) opens an item, `{ add: "all" }` the Add dialog, `{ add: kind }` it on one kind                                        |
| Serve     | Nothing: a plugin of the id `integrations.page` replaces the page                                                                                                                              |
