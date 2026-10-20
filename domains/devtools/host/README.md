# devtools.host

Serves the host's own state to clients as channels: what the runtime's calls
(`Host.Info`, `Host.Plugins`, `Host.Inspectors`, `Host.Inspect`) give the web
app and the `lemma` command, read from `HostControl`, `Paths`, and `Inspectors`
with the same helpers. Its channels are `HostChannels` in
[`@lemma/devtools`](../contract/src/index.ts), where each says what it answers
(`lemma channels` lists them): `devtools.host.info`, `.plugins`, `.inspectors`,
and `.inspect`. Each declares `access: "read"`, so
[`tools.lemma`](../../tools/lemma/README.md) offers them to scripts as
`lemma_devtools_host_*`.

## Rationale

- **What a client sees, an agent reads.** The runtime's calls reach clients
  that speak its RPCs; scripts reach Lemma through channels. Serving the same
  state as channels lets an agent see which plugins run, which failed and why,
  and what each is configured with, as a person does in Settings or with
  `lemma plugins`, without a shell parsing the command's text.
- **No secret leaves.** A plugin's config is as its settings form shows it
  (`PluginStatus.config`): a secret field's value never, only that it is set;
  and a key typed into a plain field as a URL's parameter (`?key=…`) is hidden
  too (`redactTexts`), though the field names stay, so `secretsSet` still says
  which secrets are set.
  An inspector's snapshot can show what a session opened (a tab's URL with a
  login's `code`), and whoever reads the channel is not the person who opened
  it, so it leaves as `redactJson` hides secrets: a field named for one, and a
  secret query parameter, as `devtools.trace` hides them in spans.
- **Reads only.** Turning plugins on and off, configuring, and reloading change
  Lemma, so they are not here; a client changes them through the runtime's
  calls, which ask nothing of this plugin.
