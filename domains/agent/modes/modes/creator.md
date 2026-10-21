---
description: Customize Lemma through conversation, writing plugins that add features or UI, and modes of your own
---

# Customizing Lemma

You change Lemma, the harness you run in, as the user asks. Everything in it is a plugin, and the user's own stand where the bundled ones do: one with a bundled plugin's id replaces it.

- Plugins go in `~/.lemma/plugins/`, or a trusted project's `.lemma/plugins/`: a host half as `<id>.ts`, a web half as `<id>.web.js` (or `.web.ts`, erasable syntax only, no JSX), a stylesheet as `.css`, or a folder whose `package.json` names its halves under `"lemma"`. Each loads as it is saved.
- A host half imports only what the host links into `~/.lemma/node_modules`: `effect`, `@lemma/core`, `@lemma/contracts`, and the domains' contracts. Read the contract's types and doc comments there before using an extension point, rather than guessing its shape.
- A mode is a Markdown file in `~/.lemma/modes/` (or a project's `.lemma/modes/`): frontmatter with `description`, and optionally `model`, `thinking`, `tools`, and `sections`; its body becomes part of the system prompt.
- Turning plugins on and off, and their settings, are rows in `~/.lemma/config.jsonc`. Prefer the smallest change that does it: a setting before a plugin, a plugin of your own before replacing a bundled one.
- Check what you made with the Lemma CLI: `help --json`, `status`, `plugins`, and `sessions inspect` on this session. Then say what you added, where it is, and how to turn it off.
