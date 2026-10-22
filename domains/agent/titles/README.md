# agent.titles

Names threads with the small model (`SmallModel` in `@lemma/llm`, which
[llm.small-model](../../llm/small-model/README.md) provides): a title of a few
words for what a thread asks, as T3 Code, Claude Code, Codex, and OpenCode
name theirs. Requires `Sessions`, `Llm`, and `SmallModel`. No config: turn it
off and a thread keeps the title its first prompt gives it.

- **When.** A thread's first turn titles it from its first prompt, cut near
  60 characters (`titleFrom` in `@lemma/agent/kit`), marking the title
  `provisional` (`@lemma/sessions`). That title shows at once, and this
  plugin, hearing it appended (`SessionAppended`), asks the small model for a
  better one in the background, while the turn runs. Only a provisional title
  is replaced: a thread named before its first prompt (a delegated agent's) is
  left as it is, whatever its name.
- **What the model reads.** The first prompt's text, its start and end when
  it is long (6,000 characters at most), under `TITLE_PROMPT`: 2 to 6 words, a
  verb for a task, names as written, the person's language, and the prompt
  named rather than answered. It is asked on the model `SmallModel` chooses
  for the thread's model, with the thread's session id, so a plugin around
  model calls (`LlmRequestHook`) counts it with the thread.
- **The answer.** Its first line of text, found past reasoning in `<think>`
  tags, a code fence, a label line, or in a JSON object's `title`; the quotes
  or Markdown around the whole of it, its backticks, and a trailing period
  dropped, names kept as written, and a title past 60 characters cut at a word
  (`cleanTitle`). The call is capped at 100 output tokens, or 2,000 for a
  model asked to reason, which OpenAI and Google count with the answer.
- **Your title wins.** It is appended as a `title` event, as a rename is, only
  while no title has come after the provisional one: a rename made while it
  was written stays.
- **When it fails** (no model available, the provider failing, nothing
  written, or a minute gone by), the title from the prompt stays.
- **Anew.** Regenerate title (`agent.regenerate-title`: in the palette for the
  open thread, `lemma commands run` with `--session`, and, from the web half,
  each thread's menu, for a thread prompted) names a thread again, whatever
  its title, by its first prompt and its latest messages, the person's and the
  agent's text, as many as 6,000 characters hold, with its title now. Asked
  while the first title is still being written, it waits for that, so its own
  is the title the thread ends with.
