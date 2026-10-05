# @lemma/plugin-compaction

Keeps a conversation within its model's context window. Handles
`AgentRequestHook` after every other handler (order 1000), so it sizes the
request as it will be sent: before a model call that would fill more than `at`
of the window, the older part of the turn's history is summarized by a model
and a `compaction` event is appended to the turn (`RequestDraft.append`).
Every reader of the log (`deriveMessages`, and so the agent, `rebuildRequest`,
and the clients) then shows the model the summary in place of that part; the
log keeps every original event, and the web app marks the place with a
divider. Requires `Llm`.

| Config       | Default | What it does                                                                      |
| ------------ | ------- | --------------------------------------------------------------------------------- |
| `at`         | `0.8`   | Share of the window the conversation may fill before its older part is summarized |
| `keepRecent` | `20000` | Tokens of the latest conversation kept word for word (at most 30% of the window)  |
| `model`      | unset   | The model that writes summaries (`provider/model`); the turn's model when unset   |

- **The estimate.** The last response after the latest compaction reports the
  tokens of the context it was given and of its output; messages since then are
  estimated at four characters a token (an image as 1,200). Without such a
  response, the system prompt, tools, and messages are all estimated.
- **The cut.** The kept part starts at a prompt or a response, never between a
  tool call and its result, and at least one message is summarized. It may fall
  inside the running turn, so a long turn with many tool calls stays in bounds.
- **The summary.** A later compaction summarizes the previous summary with the
  messages after it. Tool output and long text are cut in what is sent, and the
  oldest messages go first so the request, with its answer of up to 8,192
  tokens, fits the writing model's window even for text as dense as 1.5
  characters a token. A summary stopped at that limit is not used.
- **Its cost.** The event records the turn it happened in and what writing the
  summary cost (`turnId`, `usage`); the turn's usage (`TurnEnded`, the
  trajectory, `lemma run`, the web app's turn footer) includes it.
- **When the model refuses a request as too long** (the agent asks again with
  `RequestDraft.overflow`), it summarizes whatever its estimate says, even in a
  turn where summarizing failed before: four characters a token can misjudge
  dense text.
- **When it fails** (the model errors, stops at its limit, or writes nothing),
  a warning `Notice` says so, the call goes ahead as it would have without this
  plugin, and the turn is not summarized again; the next turn tries once more.
  A compaction that succeeds is announced with an info `Notice`.
