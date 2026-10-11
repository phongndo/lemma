# Debugging plugins

Where to look when a plugin misbehaves: whether it runs, what it is plugged
into, what it did, and why it failed. Each step names the tool; the linked
README has the rest.

## Does it run?

- **`lemma plugins check <folder>`** starts a host of its own with a plugin
  folder and says what the plugin provides, requires, handles, and adds, or
  why it does not run: a setup that threw, a web half missing or not
  compiling ([Writing plugins](plugins.md#testing)).
- **`lemma plugins`**, and Settings › Plugins, list every plugin with its
  state and, for one that failed, its fault; the plugins that require a
  failed one stop with it, halted by it. `lemma plugins restart <id>` starts
  it and them again once it is fixed.
- **The host's output** warns of what it left out, naming the plugin
  (`lemma: warning [notes]: …`): a row naming no plugin (with the id meant,
  when one is close), a plugin that cannot run, a web half that does not
  compile, with its file, line, and column.
- **`--safe`** starts the host as shipped, reading no config or plugin file,
  and **`?safe`** does the same for the web app: the way back from a
  customization that breaks either ([Configuration](configuration.md)).

## What is it plugged into?

- **`lemma kernel hooks`** prints each hook's chain in the order its handlers
  run, each with its plugin; `lemma kernel registries`, `events`, and
  `capabilities` print who adds to each registry, who observes each event,
  and who provides and requires each capability. The devtools (Ctrl+Shift+D,
  Cmd+Shift+D on macOS) show the same for the page and the host, panel by
  panel ([the web app](../apps/web/README.md)).
- **`lemma inspectors`** lists what host plugins let you look into (the
  tools registered, the turns running, the commands), and `lemma inspectors
<id>` prints one.

## What did it do?

- **The trajectory** (a thread's Trajectory view, or `lemma inspect
<session>`) shows every request, response, and tool call of a session, from
  its log, with each one's pipeline: the plugin that contributed each system
  section and tool, the handlers each step passed through, and why a step
  ended or went on. `lemma inspect <session> --request <r>` prints one request
  so, and `--rebuilt` the exact request the model was sent (`lemma --help`,
  and [the CLI](../apps/cli/README.md)).
- **The trace** (the devtools' Trace panel) shows what ran in the host and
  the page, span by span, filtered by plugin, session, turn, step, tool, hook,
  status, or duration. A hook's span holds its handler's own time, and, for a
  hook declared with a `summary`, a few plain values of what each handler was
  given, passed on, and returned (`hook.in.*`, `hook.next.*`, `hook.out.*`:
  counts and names, never the payload). A trajectory record's **Show in trace** opens
  the spans of its turn or call
  ([devtools.trace](../domains/devtools/trace/README.md)).
- **`lemma trace export`** writes the host's trace to a file, as JSON or, with
  `--format chrome`, for [Perfetto](https://ui.perfetto.dev): to keep it past
  the host, which holds only the last few thousand spans, or to send it.

## Why did it fail?

- **A fault is its plugin's.** What a plugin starts fails as that plugin's
  fault, named for it: its setup, a handler, a tool, a task, a timer, and an
  event handler run through `action`. In the host, so is a promise it left
  unhandled, traced back to the plugin whose work started it; the page can
  do that only while the work runs, so a web half runs its handlers through
  `action`. The Plugins page, a notice, and the Trace panel's Faults tab show
  it ([the kernel](../packages/core/README.md)).
- **A web half's item fails alone.** A slot item or part that throws while it
  draws is its plugin's fault, and the region draws the next item
  ([the web app](../apps/web/README.md)).
- **A web half in TypeScript has source maps**, so the browser's devtools
  show its own files and lines.
- **A failed turn says why in its log**: the trajectory shows the error, the
  attempts a request took, and what decided where each step ended.

## Making it happen again

A plugin's tests run it in real turns against a scripted model
(`@lemma/test-host`), and `lemma dev` runs it in your host as you edit it
([Writing plugins](plugins.md#testing)).
