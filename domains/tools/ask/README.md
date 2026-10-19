# tools.ask

The `ask_user` tool: one to four multiple-choice questions for the user, asked
together, which the agent waits on. Adds it to `Tools` and serves the questions
to clients as the `ask.*` channels; its web half (`./web`) shows the open
thread's questions above the composer's text box, a call in the chat as its questions
and answers, and every thread with questions open as `Needs input` (`ThreadWaits`).

| Input                                                                      | Limits                                |
| -------------------------------------------------------------------------- | ------------------------------------- |
| `questions[]`: `header`, `question`, `options[]`, `multiSelect?`           | 1–4 questions, each with its own text |
| `options[]`: `label` (`" (Recommended)"` shows as a badge), `description?` | 2–4 options, each with its own label  |

The user answers each question with a pick (or several), their own words, or
both (a note on the pick), or skips it; or they hide the questions and send a
message instead, which joins the turn. What the model reads says which:

| Outcome     | When                                                                                                       | The result says                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| answered    | A client answered (`ask.answer`)                                                                           | Each question with `chose …`, `wrote …`, `chose …, and added …`, or `skipped: decide yourself` |
| replied     | A person's steer was queued for the session: sent while the questions were open, or before they were asked | The user sent a message instead, which follows                                                 |
| unavailable | No client had `ask.open` open, nor opened it within `waitForClientMs`                                      | Nobody can answer: go on, and say what was assumed                                             |

The result's `details` (`AskDetails`) holds the questions and the outcome,
which the chat shows.

| Channel      | Kind   | Payload                                                | Result                                                                                  |
| ------------ | ------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `ask.open`   | stream | none                                                   | Every open call (`sessionId`, `toolCallId`, `questions`, `at`) now, then on each change |
| `ask.answer` | call   | `{ sessionId, toolCallId, answers }`, one per question | Fails `NotFound` once answered or withdrawn, `InvalidAnswer` for one that does not fit  |

An answer is `{ "kind": "answered", "selected": ["<label>"], "text": "…" }`
or `{ "kind": "skipped" }`. From a shell:

```sh
lemma channels open ask.open
lemma channels call ask.answer '{"sessionId":"<session>","toolCallId":"call_1","answers":[{"kind":"answered","selected":["SQLite (Recommended)"]}]}'
```

| Setting           | Default | What it does                                                                                                       |
| ----------------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `waitForClientMs` | `15000` | With no client that answers connected as the agent asks, how long to wait for one before answering that nobody can |

## Rationale

- **No timeout once someone can answer.** A question waits until it is
  answered, replied to, or its turn is cancelled, through a closed tab or a
  reload. Products that answered for the user after a minute had to take it
  back. Only a question asked with no client connected at all waits
  `waitForClientMs`, long enough for a reload or a host restart to reconnect,
  and then tells the model nobody is there (a script's `lemma run`).
- **Its own channels, not the host's `Interaction`.** `Interaction` is for a
  person who is there now: it fails at once with nobody attached, and after
  15 seconds once every client has left (see the transport's
  `interactionGraceMs`), which is right for a login or an approval and wrong for
  a question that can wait. So `lemma questions` and `lemma answer` do not list
  these; `lemma channels` does.
- **A message sent meanwhile is a reply.** A prompt queued while questions
  are open would wait behind them: a follow-up for the turn to end, a steer for
  the turn's current tool calls. So a follow-up sent then is made a steer
  (`AgentInputHook`), and a steer answers the questions: the model reads that
  the user replied, then the message, in the same turn. A plugin's notice
  (`QueuedPrompt.source`, such as a background command's exit) is no reply: it
  waits behind the questions.
- **The composer is the answer box.** The questions draw just above the text
  box (`ComposerTakeovers`) as the completion menu does, an option a menu row
  with its description beside it (whole in its tip) and the digit that picks
  it, so `/`, `@`, and a question read alike, and it takes the menu's keys
  from the text box while that holds nothing: Up and Down move, a digit picks,
  Enter picks the highlighted option (or, with it picked, goes on), and Left
  and Right change question. The text box takes the
  answer to the question shown (the person's own words, or a note on what they
  picked, which the placeholder names). A pick selects and stays, as in Codex,
  so the note can follow it, and picking it again unselects it; the send button
  and Enter go to the next question, the review, and sending; a lone question takes no Enter before it has an answer. The thread's
  draft waits, and comes back when the questions close or are let go. They do
  not take the box while the person has a prompt of their own unsent, nor once
  they let it go (Escape, or the chevron): a line above the composer says they
  wait, and its chevron brings them back; a message sent meanwhile answers them as a reply.
  Each question keeps its own text, so moving between them loses nothing, and
  the web half keeps it by session, call, and questions while the call is open
  (and for a while after a reconnect, as a host restart asks the call again).
- **Dismissing answers.** The × sends every question as skipped, whatever was
  picked or written, so the agent decides them all and the turn goes on;
  skipping leaves one question to the agent; sending a message replies; the
  turn's stop button stops. Escape only hides the questions, so a stray key
  discards nothing. A call a stop cuts off has no result, and the
  model's provider reports it as one without a result.
- **Asked again after a restart.** It is `replay: "safe"`: a call a host
  restart cut off asks the same questions again, under the same call id, so the
  web half's draft for it survives. It is `direct`, since its result is the
  record of the answers.
- **Steers it cannot see.** It learns of steers from `QueueChanged`, which an
  observer hears a moment after the queue changed. A steer queued just as a
  question opens is caught either way: one heard before the questions open
  (before the call, or while it waits for a client) answers at once, and one
  heard after answers the open questions.
- **Calls by session and id.** A provider that sends no tool call ids gives
  every call the same one, so open calls are kept, listed, and answered by
  session and id together; a session has one open at a time.
