# tools.bash

The `bash` tool: a shell command in the session's directory, or one left running
in the background. Adds it to `Tools`, and a section to the agent's
`PromptSections` listing a session's background commands while they run. Its web
half (`./web`) shows a call as its command, as a shell line, and offers its
`timeout` in Settings › General › Agent (through `HostPlugins`).

| Input                                     | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`, `timeout?` (seconds)           | `bash -c` in the session cwd, stdout+stderr combined. Past 2000 lines or 50KB, the result keeps the first and last 1000 lines or 25KB, with a line between them saying what was left out and where the full output is: a temp file (`outputFile`: only the user can read it, and the host keeps it while it runs). Without a `timeout`, the plugin's default applies. Non-zero exit, timeout, and abort are error results; `details.exitCode` carries the code.                                                              |
| `command`, `background: true`, `timeout?` | Starts the command and answers at once: its job id (its own: a provider may give two calls one id), its pid, and its output file, written from the first byte (`details.background`, `details.fullOutputPath`). The model is told when it exits (`ModelNotice`, below), with how it ended and the first and last 100 lines or 8KB of its output. The default timeout does not apply; one given does. The model checks on it by reading the file, and stops it with `kill -- -<pid>` (the shell leads its own process group). |

A codemode script's call resolves to `BashOutput` (the result's `structured`),
on a non-zero exit, a timeout, or an abort too: `{ output, exitCode, truncated,
fullOutputPath?, timedOut?, aborted?, wallTimeSeconds, background? }`, where `output` is the
whole output up to 1 MiB, else its first and last 512 KiB around a marker, so a
script filters far more than the 50KB the model sees.

`makeBashTool(timeout, jobs?)` makes one with another default timeout, for a
plugin that registers its own `bash`; without `jobs` (`makeJobs`), it offers no
`background`, and its description tells the model to put a long-lived process
in the background itself (`nohup` and `&`, its output to a file).

## Background commands

- **Told when they exit.** The plugin publishes a `ModelNotice` (in
  [`@lemma/agent`](../../agent/contract/src/agent.ts)) from `tools.bash`, its
  id the job's and a line saying how it ended as its `display`, which the
  agent places as a `context` event from the plugin: it steers the session's
  running turn, or starts one after a turn that ran to its end
  ([agent](../../agent/loop/README.md#notices)). Clients show it as a line
  from `tools.bash`, not as the user's message.
- **Listed while they run.** The `tools.bash.jobs` section names each of the
  session's running commands, so a turn that compacted its history away, or
  the next one, still knows of them; with none, there is no section.
- **Kept through a reload.** The jobs are kept outside the plugin instance
  (`hostJobs`), keyed by the core's `Events`, which stays the same object for
  the core's life: a reload (a config change) leaves them running, and the
  replacement tells their exits. Two hosts in one process keep theirs apart.
  When the plugin stops for good (the host stopping, the plugin turned off, or
  a failure, which stops it before any restart), the last instance kills what
  still runs, and tells nothing of it; so does a session's deletion, for its
  own. A host that crashes leaves them running, untold.
- **Not started, it says why.** A command that cannot be started (no `bash`, no
  processes left) is an error result with the reason, not a job.

## Config

`timeout`: the seconds a command runs when the model names no timeout of its
own (default `600`; `0` for none). The tool description states it and offers
the background for what should outlive it, so a command that never exits
cannot hold a turn forever.

## Rationale

- **Replaceable alone.** A sandboxed `bash` is a plugin that registers a tool
  named `bash`, with this plugin turned off. Its web half goes with it, and
  with it how the chat shows bash calls (the terminal icon, the command as the
  summary): a replacement shows its calls with a `ToolViews` item of its own,
  or keeps this one by taking the id `tools.bash` and wrapping this plugin.
- **Process groups.** It spawns the shell as a group leader; abort and timeout
  kill the whole group. After the shell exits, output is read until the pipes go
  idle for 100ms, so a background child holding them cannot hang the call.
- **Both ends.** The start of a command's output says what it set out to do and
  the end how it went; a tail alone loses the first.
  [Codex](https://github.com/openai/codex/tree/89461ea6833832b0551ce24ee32205824d5c108d),
  [mini-SWE-agent](https://github.com/SWE-agent/mini-swe-agent), and
  Terminal-Bench's [Terminus 2](https://github.com/laude-institute/harbor/blob/main/src/harbor/agents/terminus_2/terminus_2.py)
  all keep head and tail (read 2026-10-19), and SWE-agent's 2024 ablations
  found a window of a file served the model better than all of it
  ([paper](https://arxiv.org/abs/2405.15793)).
- **A background flag, not `&`.** A command put in the background with `&`
  leaves the model to poll for it, and its exit unseen.
  [Claude Code](https://code.claude.com/docs/en/tools-reference),
  [opencode](https://github.com/anomalyco/opencode/tree/ba06ff9e), and
  [prime-agent](https://github.com/PrimeIntellect-ai/prime-agent/tree/7cbffa7)
  return at once and tell the model when the command ends, so it gets on with
  other work meanwhile; [Codex](https://github.com/openai/codex/tree/89461ea6833832b0551ce24ee32205824d5c108d)
  keeps the command's terminal for the model to poll, and pi runs nothing in
  the background (read 2026-10-19).
