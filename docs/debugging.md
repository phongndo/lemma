# Debugging plugins

This page says where to look when a plugin misbehaves. It asks four
questions: does it run, what is it plugged into, what did it do, and why did
it fail? Each step names a tool, and the linked README says the rest.

## Does it run?

- **`lemma plugins`** lists every plugin and its state. Settings › Plugins
  lists the same.
  - A plugin that failed shows its fault.
  - The plugins that require a failed one stop with it, halted by it.
  - `lemma plugins restart <id>` starts it and them again once it is fixed.
- **The host's output** warns of what the host left out, and names the plugin
  (`lemma: warning [notes]: …`). It warns of two things:
  - a row naming no plugin, with the id you probably meant when one is close;
  - a plugin that cannot run.
- **`lemma plugins check [path]`** runs a plugin file or folder in a host of
  its own, before you install it. It says whether the plugin starts, or gives
  its fault. It also says what the plugin takes part in
  ([Writing plugins](plugins.md#testing)).
- **`--safe`** starts the host as shipped, reading no config or plugin file.
  **`?safe`** does the same for the web app. Use them to get back from a
  customization that breaks either one ([Configuration](configuration.md)).

## What is it plugged into?

- **`lemma kernel hooks`** prints each hook's chain, with each handler's
  plugin, in the order the handlers run. Three more commands print the other
  shapes:
  - `lemma kernel registries`: who adds to each registry;
  - `lemma kernel events`: who observes each event;
  - `lemma kernel capabilities`: who provides and who requires each
    capability.
- **The devtools** show the same for the page and the host, panel by panel.
  Open them with Ctrl+Shift+D, or Cmd+Shift+D on macOS
  ([the web app](../apps/web/README.md)).
- **`lemma inspectors`** lists what host plugins let you look into, such as the
  tools registered, the turns running, and the commands.
  `lemma inspectors <id>` prints one.

## What did it do?

- **The trajectory** shows every request, response, and tool call of a
  session, from its log. Open it as a thread's Trajectory view, or run
  `lemma sessions inspect <session>`. Each record shows its pipeline:
  - the plugin that contributed each system section and tool;
  - the handlers each step passed through;
  - why a step ended or went on.

  `lemma sessions inspect <session> --request <r>` prints one request that
  way. Add `--rebuilt` to print the exact request the model was sent. See
  `lemma --help` and [the CLI](../apps/cli/README.md).

- **What a plugin costs** in the model's requests shows in two places: a
  plugin's **Cost** tab on the Plugins page, and
  `lemma sessions inspect <session> --request last --plugins`. Both give the
  plugin's sections and tools in the open thread's latest request, in tokens.
  They also say which changed since the request before.
  - A part that changes between requests invalidates the provider's prompt
    cache for everything after it.
  - So a plugin whose text changes each time should move that text into a
    `context` event.
  - `lemma sessions cache` counts the requests in a directory's sessions that
    changed the system prompt or tools, and says which plugins changed them.
- **The trace** is the devtools' Trace panel. It shows what ran in the host and
  the page, span by span. You can filter it by plugin, session, turn, step,
  tool, hook, status, or duration.
  - A hook's span holds its handler's own time.
  - A hook declared with a `summary` also records a few plain values: what
    each handler was given, passed on, and returned (`hook.in.*`,
    `hook.next.*`, `hook.out.*`). These are counts and names, never the
    payload.
  - A trajectory record's **Show in trace** opens the spans of its turn or call
    ([devtools.trace](../domains/devtools/trace/README.md)).

## Why did it fail?

- **A fault is its plugin's.** What a plugin starts fails as that plugin's
  fault, named for it. That covers its setup, a handler, a tool, a task, a
  timer, and an event handler run through `action`.
  - In the host, a promise the plugin left unhandled is its fault too. The host
    traces it back to the plugin whose work started it.
  - The page can trace that only while the work runs. So a web half runs its
    handlers through `action`.
  - The Plugins page, a notice, and the Trace panel's Faults tab show the fault
    ([the kernel](../packages/core/README.md)).
- **A web half's item fails alone.** A slot item or part that throws while it
  draws is its plugin's fault. The region then draws the next item
  ([the web app](../apps/web/README.md)).
- **A blocked event loop is named.** When the host's event loop is blocked for
  a second, the host says so on stderr while the block lasts. It names the
  plugin whose code was running. It keeps the stall in the trace as a
  `host.stall` span under that plugin
  ([the host](../packages/host/README.md#a-blocked-event-loop)).
- **A failed turn says why in its log.** The trajectory shows the error, the
  attempts a request took, and what decided where each step ended.

## Making it happen again

A plugin's tests run it in a core of its own. Beside it run the plugins it
needs, or fakes of them ([Writing plugins](plugins.md#testing)).
