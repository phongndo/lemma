# llm.small-model

The model small tasks run on: a thread's title ([agent.titles](../../agent/titles/README.md)),
and whatever else a plugin asks a model in passing rather than in a turn.
Provides `SmallModel` (`@lemma/llm`), so such a plugin names no model of its
own and every one of them follows the same choice. Requires `Llm`.

| Config     | Default | What it does                                                                                       |
| ---------- | ------- | -------------------------------------------------------------------------------------------------- |
| `model`    | unset   | The model, as `provider/model`; a small model of the thread's provider when unset                  |
| `thinking` | unset   | How hard the model reasons, as far as it offers that level (`clampThinking`); the least when unset |

- **Before a model is chosen.** Unset, or naming a model no logged-in
  provider lists, a task runs on a small model of its thread's provider
  (`smallModel`), so it is billed where the thread is, on the person's plan
  when the thread is: of OpenAI's Luna, Gemini's Flash-Lite, then Flash, and
  Claude's Haiku, the first family the provider serves, those of the thread's
  own line first (Haiku for a Claude thread on a provider serving several). It
  is found in the provider's live catalog by the words of its id, so a newer
  Haiku needs no change here: of a family, the model whose id says least
  besides (no region, batch, preview, or image variant), then the newest
  version, its plain id before its dated snapshots. A provider with none of
  them (a model of your own) runs it on the thread's model. OpenCode and Zed
  choose the same way (read 2026-10-22).
- **Reasoning.** `thinking` applies to whichever model a task runs on, as far
  as it offers that level; unset, the least it offers. Titles need little:
  Codex and T3 Code ask theirs at `low`.
- **Its setting.** Its web half offers both fields in one row, Settings ›
  General › Text generation models, written to its row as the Plugins page
  would, with the pickers `llm.model-picker` draws for a plugin's own choice
  (`ModelPickerPart`, `ThinkingPickerPart`). Each names what titles run on for
  a thread on the composer's model, the model chosen or, before one is, its
  provider's small model: there is no Automatic to pick. Picking a model's
  least level unsets `thinking`. The composer's own model is not touched.
- **Not compaction.** [context.compaction](../../context/compaction/README.md)
  writes its summaries with the thread's model, whose cache of the
  conversation serves its request; another model would read all of it afresh.
