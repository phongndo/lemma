# tools.patch

The `apply_patch` tool: adds, deletes, updates, and moves files with a patch in
[Codex's format](https://github.com/openai/codex/blob/89461ea/codex-rs/core/assets/tools/apply_patch.lark),
several files in one call. Adds it to `Tools`, beside `edit` and `write`, and
offers one of it and `edit` to each request by its model (below). Paths resolve
as `read`'s do, relative or absolute. Its web half (`./web`) shows a call as the
files its patch names, with their diffs.

| Input   | Behavior                                                                                                                                                                                                                                                                                                             |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input` | The patch. Every file is read and patched in memory before any is written; one that does not apply is an error, `apply_patch verification failed: …` with Codex's reason, and nothing changes. The result is Codex's summary: the files added (`A`), changed (`M`, a moved one by where it went), and deleted (`D`). |

`details.files` has each file's change (`add`, `update`, `move`, `delete`),
absolute paths, unified diff, and first changed line, in the patch's order;
`details.patch` is their diffs together.

## Which models get it

A request offering both `apply_patch` and `edit` keeps one of them, by its
model, in `AgentRequestHook`'s `select` phase: `apply_patch` for OpenAI's GPT
and Codex models (an id with `gpt` or `codex` in it, whoever serves it:
`trainedOnPatches`), and `edit` for every other model. It chooses from what
the request offers once the other handlers chose, so a mode that keeps only
one of the two keeps it whatever the model, and so does a host with one of the
plugins off.

```jsonc
{ "plugins": { "tools.patch": { "config": { "everyModel": true } } } }
```

| Config       | Default | Meaning                                          |
| ------------ | ------- | ------------------------------------------------ |
| `everyModel` | `false` | Offer `apply_patch` beside `edit` to every model |

## Rationale

- **Codex's apply_patch.** The parser, the line matching, and how an update
  changes a file's text are Codex's, ported from its Rust
  ([`@lemma/tools/patch`](../contract/src/patch.ts), from
  [`codex-rs/apply-patch`](https://github.com/openai/codex/tree/89461ea6833832b0551ce24ee32205824d5c108d/codex-rs/apply-patch/src)
  at 89461ea), and held to Codex's own tests, ported with it. The tool's
  description is the one Codex gave its function-call form until it dropped
  that form for a grammar only OpenAI's API takes
  ([`apply_patch_spec.rs`](https://github.com/openai/codex/blob/e783341b70~1/codex-rs/core/src/tools/handlers/apply_patch_spec.rs)).
  OpenAI trains its models on this format ("on which the model has been
  extensively trained", says its [GPT-4.1 prompting
  guide](https://developers.openai.com/cookbook/examples/gpt4-1_prompting_guide),
  read 2026-10-19), so what they were trained on is what they get: a chunk is
  the first match after the last one (and after its `@@` line), found
  exactly, then ignoring trailing whitespace, then leading too, then Unicode
  punctuation as ASCII; lines only added go at the file's end; every line ends
  with a line break; a file named twice is refused.
- **One editing tool a model.** Its description is about 2,900 characters,
  which every request offering it pays for, and a model offered two ways to
  edit a file has to choose between them. Models trained on it get it, and
  the others get `edit`. A request on
  another model declares its tools afresh anyway (the agent's append-only
  requests), so the tool list changing with the model costs no cache.
- **Lemma's writing.** What Codex does not settle, Lemma's file writing does:
  a file's BOM is kept out of matching and put back, and the patch applies
  whole or not at all. Files are read, checked (writable, removable, not a
  directory; a file to create, in a directory that can take it), and patched
  in memory under every file's lock (`withFileLocks`), before any is written.
  A file is one file however the patch names it (`realPath`: through a
  symlink, or as a Move's destination), so a patch that would change one twice
  is refused, as Codex refuses a path named twice, rather than lose a change.
  Then each file is written with `replaceFile`, keeping its mode (a moved file
  keeps its source's, written with it), and only then are files removed, so a
  crash leaves a moved file in both places rather than neither. A write that
  fails partway (a full disk) leaves what was written before it, and the
  error names those files. Codex writes each file as it goes.
- **For a guard.** `patchPaths` lists every path a patch names, read as
  Codex's parser reads them, whether or not the patch parses, so a guard
  judges at least the files it changes.
