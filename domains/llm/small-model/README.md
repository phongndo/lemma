# llm.small-model

The model small tasks run on: a thread's title
([agent.titles](../../agent/titles/README.md)), and whatever else a plugin asks
a model in passing rather than in a turn. Provides `SmallModel` (`@lemma/llm`),
so such a plugin names no model of its own and every one of them follows the
same choice.

| Config     | Default | What it does                                                                                       |
| ---------- | ------- | -------------------------------------------------------------------------------------------------- |
| `model`    | unset   | The model, as `provider/model`; a small model of the thread's provider when unset                  |
| `thinking` | unset   | How hard the model reasons, as far as it offers that level (`clampThinking`); the least when unset |

- **Before a model is chosen.** With `model` unset, or naming a model no
  logged-in provider lists, a task runs on a small model of its thread's
  provider (`smallModel`). So it is billed where the thread is, on the person's
  plan when the thread is. The model is the first family the provider serves of
  OpenAI's Luna, Gemini's Flash-Lite, then Flash, and Claude's Haiku, the
  thread's own line first. It is found in the live catalog by the words of its
  id, so a newer Haiku needs no change here. Of a family, it takes the id that
  says least besides (no region, batch, preview, or image variant), then the
  newest version, its plain id before dated snapshots. A provider with none of
  them (a model of your own) runs the task on the thread's model. OpenCode and
  Zed choose the same way (read 2026-10-22).
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
