# context.compaction

Keeps a conversation within its model's context window. Handles
`AgentRequestHook` in its phase `fit`, after every handler that shapes the request, so it sizes the
request as it will be sent: before a model call that would fill more than `at`
of the window, the older part of the turn's history is summarized by a model
and a `compaction` event is appended to the turn (`RequestDraft.append`).
Every reader of the log (`deriveMessages`, and so the agent, `rebuildRequest`,
and the clients) then shows the model the summary in place of that part; the
log keeps every original event, and the web app marks the place with a
divider. Requires `Llm`.

| Config       | Default | What it does                                                                                                                  |
| ------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `at`         | `0.8`   | Share of the window the conversation may fill before its older part is summarized                                             |
| `keepRecent` | `20000` | Tokens of the latest conversation kept word for word (at most 30% of the window)                                              |
| `model`      | unset   | The model that writes summaries (`provider/model`); the turn's model when unset                                               |
| `review`     | `false` | Have a model that sees only the summary ask what it leaves out, and the turn's model answer: two more model calls per summary |

- **The meter.** Its web half adds a ring to the composer's row, beside its buttons
  (`ComposerActions`), so how full the open thread's context is stays in
  view. It measures as the estimate below
  does (`measuredTokens`), against the selected model's window, since that is
  the model the next prompt goes to, and reads `at` from the same row. It turns
  the warning color within 10 points of `at`, and the error color past the
  window. It is not measured before the first reply, or after a summary until
  the next reply (the system prompt and tools are sized only on the host). Beside
  it is the share of the last reply's input the provider's cache served
  (`82% CH`, spelled out in its tooltip); a provider that reports no caching shows
  0%. Turning the plugin off removes both.
- **The estimate.** The last response after the latest compaction reports the
  tokens of the context it was given and of its output; messages since then are
  estimated at four characters a token (an image as 1,200). Without such a
  response, the system prompt, the tools the model is sent (not those only a
  tool calls), and messages are all estimated.
- **The cut.** The kept part starts at a prompt or a response, never between a
  tool call and its result, and at least one message is summarized. It may fall
  inside the running turn, so a long turn with many tool calls stays in bounds.
- **Other plugins' say.** Each compaction runs through `CompactionHook`
  ([`@lemma/context`](../contract/src/index.ts)), whose terminal is this
  plugin's model writing the summary: a handler writes its own (no model call;
  the event's `source` is that plugin), moves the cut, reworks the summary, or
  skips the compaction.
- **Asking for one.** A prompt of `/compact`, alone or followed by what the
  summary should focus on (`/compact keep the API decisions`), is handled
  rather than sent (`AgentInputHook`): the session's next model call, in the
  running turn or the next one, summarizes whatever the estimate says, once,
  keeping at most a quarter of the conversation word for word. The web half
  offers it in the `/` menu (`PromptCommands`). A notice says
  when there is nothing to summarize or a handler skipped it. The request is
  held in memory, so a restart before that call forgets it.
- **The summary.** It follows a fixed outline (goal, constraints, progress,
  decisions, next steps, critical context), which asks for exact paths and
  errors, and for the ids and results of any other agents or background work.
  A later compaction folds the previous summary into one with the messages
  after it, keeping what is still true. A summary stopped at its limit (8,192
  tokens at most) is not used.
- **Written in a fork.** The turn's own model writes it, unless `model` names
  another: it is asked the turn's last request again (its system prompt, tools,
  thinking, and history, rebuilt from the log) with the request for a summary
  after it, so the provider's cache serves all of it but that, at about a tenth
  of the price of sending it fresh ([Claude Code's
  account](https://claude.dev/blog/lessons-from-building-claude-code-prompt-caching-is-everything/),
  read 2026-10-19).
  The 20% of the window `at` leaves is the room it needs. When it cannot be (the
  model refused the request as too long, another model writes summaries, or the
  fork would not fit), or the fork's call fails, or its answer is cut off at
  its limit, calls a tool, or has no text, the writing model is sent the
  history as a transcript instead: tool output and long text cut, the
  oldest messages going first, so it fits even for text as dense as 1.5
  characters a token.
- **The files.** The compaction names the files the history it replaces read
  and changed (by the `read`, `write`, `edit`, and `apply_patch` calls in it
  that succeeded),
  after the previous compaction's, and the model reads them with the summary
  (`summaryText` in `@lemma/sessions`), told to read a file again before
  relying on what the summary says of it. What else the model needs after a
  compaction comes from the request after it, which declares its system prompt
  afresh: the project's instructions, the skills, and the background commands
  still running, as their sections say now.
- **Reviewed, if asked.** With `review`, a model that sees only the summary
  lists up to five things it leaves out, and the turn's model answers them in a
  fork as above; the answers go after the summary. A review that fails, or
  whose questions or answers are cut off, leaves the summary as written. It
  costs two more calls per compaction, so it is off by default. Terminal-Bench's
  [Terminus 2](https://github.com/laude-institute/harbor/blob/main/src/harbor/agents/terminus_2/terminus_2.py)
  reviews its summaries the same way (read 2026-10-19).
- **Three a turn.** A turn that fills the window again after each summary (an
  output too large for what is kept) is summarized at most three times; a
  warning says so, and the threshold asks for none until the next turn. An
  overflow, or `/compact`, still does.
- **Not clearing tool results.** Dropping old tool output from the history
  would shorten it more cheaply, but it rewrites what earlier requests sent:
  every later token of the cached prefix is sent again, and Anthropic's newest
  models refuse thinking made before the change ([append-only
  requests](../../agent/loop/README.md#append-only-requests)).
- **Its cost.** The event records the turn it happened in and what writing the
  summary cost (`turnId`, `usage`); the turn's usage (`TurnEnded`, the
  trajectory, `lemma run`, the web app's turn footer) includes it.
- **When the model refuses a request as too long** (the agent asks again with
  `RequestDraft.overflow`), it summarizes whatever its estimate says, even in a
  turn where summarizing failed before (a `/compact` waiting then is made by
  the call after): four characters a token can misjudge dense text.
- **When it fails** (the model errors, stops at its limit, or writes nothing),
  a warning `Notice` says so, the call goes ahead as it would have without this
  plugin, and the turn is not summarized again; the next turn tries once more.
  A compaction that succeeds is announced with an info `Notice`.
