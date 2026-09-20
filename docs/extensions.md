# Runtime extensions

Extensions are external programs that compose three primitives:

| Primitive | Purpose |
| --- | --- |
| Proc | Request an authoritative change through the [Automation API](api.md) |
| Event | Observe committed state or interaction with an owned Surface |
| Surface | Present extension-owned state as a retained Grid |

```text
Lemma state -> Event -> extension state -> Surface update -> native Scene -> user
                  ^             |                                           |
                  |             +-> Proc -> Lemma state                      |
                  +---------------- owned interaction Event <---------------+
```

V1 supports full-duplex framed connections, capability negotiation, Procs, Attachment-scoped Grids,
dock/float/overlay placement, and owner-directed input. A Surface is not a Pane, PTY, or terminal
emulator. A terminal remains a real Pane using the ordinary process, Ghostty, and lifecycle machinery.
Floating terminal creation, shared/Session-scoped Surfaces, and wholesale native-UI replacement are
not supported.

Runtime extensions can use any language that speaks the protocol. The separate
[configuration and command host](configuration.md#external-command-programs) can declare and launch
invocation-scoped programs through `argv` commands, discovered by command-line completion and
invoked by name or keybinding. Persistent runtime services still manage their own launch/lifetime;
there is no persistent-service registry or automatic restart policy.

## Navigation picker

The [standalone Python picker](../extensions/picker.py) is a complete Session/Tab/Pane workflow,
not a terminal emulator. From the checkout, install it at the path used by this configuration:

```sh
mkdir -p "$HOME/.config/lemma"
cp extensions/picker.py "$HOME/.config/lemma/picker.py"
```

Add this [configuration](../examples/picker.lua) to `init.lua` (adjust `argv` to use a different
Python executable or installation path):

```lua example=../examples/picker.lua
local lemma = require("lemma")

lemma.command.register("nav.pick", {
  description = "Choose a Session, Tab, or Pane",
  timeout_ms = 120000,
  argv = { "python3", os.getenv("HOME") .. "/.config/lemma/picker.py" },
})
lemma.keymap.set("prefix", "p", "nav.pick")
```

`C-b p` opens the picker, as does `nav.pick` in the native command line. Up/Down or `k`/`j` select a
row; Right/`l` descends from Sessions to Tabs to Panes; Left/`h` goes back. Enter selects the target,
`r` refreshes the current listing, and Escape/`q` closes. IDs are retained rather than inferred from
row positions at commit time. A stale or busy target is rejected; it cannot silently choose a
replacement or steal another client. Titles use ASCII fallbacks in this dependency-free example.

The picker discovers only the current level, subscribes to no terminal screens, and blocks on its
owned input while idle. Closing, losing Surface focus, detaching, switching, or crashing releases its
UI and returns control to native code. Each invocation starts a fresh helper; this is not a
persistent sidebar or a general extension client library. The two-minute command deadline is also
the configured host watchdog, so close the picker when finished.

## Boundary and trust

The daemon owns mux and terminal state. Extensions own their application state and refer to Lemma
objects by stable IDs, never borrowed Core pointers. For example, filtering a picker changes
extension state and its Surface; selecting or killing a real Session submits a Proc.

Extension code never runs on the daemon's PTY, input-routing, scheduling, or composition stacks.
Native Scene code owns geometry, ordering, clipping, borders, occlusion repair, damage aggregation,
cursor arbitration, and terminal output. A slow extension can make its own UI stale, but PTY progress
and composition have no synchronous dependency on it.

Protocol isolation is not an OS sandbox. Extensions execute with the user's permissions and should
be trusted. They share host CPU and memory, and their messages still require native decoding and
validation; isolation means bounded work and measured responsiveness, not literal zero impact.

V1 negotiates these capabilities:

| Capability | Grants |
| --- | --- |
| `observe` | Selected state Events, snapshots, and optional bounded screen projections |
| `proc` | Proc submission |
| `surface` | Surface lifecycle/content and scoped interaction Events |

Surface input goes only to its owner, not to every observer. Lemma retains a native recovery path
that extension UI cannot override.

## Connection and framing

Connect to the ordinary [daemon Unix endpoint](api.md#direct-connections). V1 multiplexes Proc and
SurfaceUpdate requests with ProcResult, Event, and Error responses on one full-duplex stream.
The connection owns one `ExtensionGenerationId`.

Every record has a 16-byte network-byte-order header; the initial magic byte selects this protocol:

```text
0..3   magic       8a 4c 4d 45 ("LME" after the discriminator)
4      major       1
5      minor       0
6      kind        Hello=1 Welcome=2 Proc=3 ProcResult=4 SurfaceUpdate=5 Event=6 Error=7
7      flags       0
8..11  payload     unsigned JSON payload byte length
12..15 sequence    nonzero unsigned request or record ID
```

Payloads are UTF-8 JSON. Unknown versions, kinds, flags, invalid lengths, zero sequence IDs,
malformed JSON, duplicate keys, or records using an ungranted capability are rejected.
`lemma api schema --json` exposes the payload schemas; Welcome supplies negotiated resource limits,
including `record_bytes`. Framing and parser limits apply in addition to JSON Schema validity.

The first record is Hello. This [example](../examples/extension-hello.json) binds to an existing
Session named `example`; send it as a framed Hello, not as a CONTROL JSON line:

```json example=../examples/extension-hello.json
{
  "schema": "lemma.extension/v1",
  "name": "project-sidebar",
  "capabilities": ["observe", "proc", "surface"],
  "events": {
    "schema": "lemma.events/v1",
    "session": {"name": "example"}
  }
}
```

`observe` and `surface` require `events.session`, selecting that Session's Attachment. A proc-only
connection may omit `events` and have no Session/UI scope; its Commands use ordinary explicit
selectors. Supplying `events`, even without `observe`, requires a live Session and binds connection
lifetime to it. This alone does not grant observation.

Lemma replies with one `lemma.extension-welcome/v1` record containing the generation, granted
capabilities, and limits. `attachment` is present only for scoped connections. When `observe` is
granted, an authoritative `snapshot` follows before incremental Events.

## Ordering and admission

ProcResult echoes the Proc header's sequence ID. Error echoes the rejected record's sequence,
including a rejected SurfaceUpdate; it is not a ProcResult and does not imply execution.
V1 admits at most one outstanding Proc per owner. Rejected admission executes no Commands;
admitted Procs retain ordinary ordered, non-atomic, partial-completion semantics.

Admission reserves one maximum-sized framed result in the bounded output queue. Other admissions
cannot consume that reservation. Completion converts it to queued bytes; ownership cancellation or
disconnect releases it. This is not a delivery guarantee across transport failure, nor an
exactly-once execution guarantee across reconnects.

Records retain enqueue order on the single stream. Event sequence IDs belong to a separate lane,
not the request-ID space. There is no global result-before-all-events ordering. Structural Surface
Events are retained until their owner's Proc result is enqueued. **Await a successful structural
ProcResult before sending content that depends on its Surface ID or geometry.** Read the result to
learn whether a request succeeded; use Events to observe committed consequences and other actors.

Surface updates apply in input order. A rejected update leaves the previous Grid intact and
produces a correlated Error when output capacity permits. Successful updates have no separate
acknowledgement. Presentation may coalesce updates; dependent accepted patches are not discarded.

## Observation and lifetime

Observation starts from the snapshot's exact Pane presence, process outcome, and terminal
generations. Incremental selection examines only the subscription's bounded stable Pane IDs on
reactor activity, not a periodic full-pane scan. A changed Pane does not depend on an unrelated wake.
Held-child exit produces `pane.process`; removal of a previously present selected Pane produces
`pane.closed`. Events describe committed current state, not every transient process transition.
There is no Event replay log.

Every Surface has a generational `SurfaceId` and belongs to the Attachment and owner generation
selected at admission. Disconnect or connection replacement invalidates that generation, closes
its Surfaces, revokes focus, cancels remaining owned work, and releases retained state without an
extension cleanup callback. Completed Proc effects are not rolled back. Slot reuse never transfers
focus or pointer capture to a different Attachment generation.

Destroying a bound Session revokes the connection and its resources whether or not `observe` was
granted. Clients receive EOF; a final Event across that ownership boundary is not guaranteed.
Reconnection creates a new owner generation: rebuild desired Surfaces from private extension state
and fresh authoritative snapshots rather than expecting old IDs or retained execution history.

Ordinary terminal-client detach does not destroy the semantic Attachment. Its Surfaces and Surface
focus remain available on re-attach while the extension stays connected. Switching Sessions moves
the client connection, not these resources; switching back restores the source Attachment's retained
presentation.

## Grid updates

A Surface contains a bounded retained Grid: dimensions, row text runs, styles, cursor state, and
damage generation. It is presentation state, not terminal truth. Use Proc for `surface.create`,
`surface.configure`, `surface.focus`, and `surface.close`, because these change authoritative
Attachment state and can affect Pane geometry.

High-frequency content uses `lemma.surface-update/v1`: optional style-table replacement, row text
runs, and cursor state. Each supplied row replaces that row's runs, not the whole Grid. Different
row patches cannot supersede each other. The complete update is validated before retained state
changes; rejected updates cannot leave partial content.

Schema validity, negotiated limits, and current-state validity are distinct:

- `style` and `cursor.visible` defaults apply only when absent; nulls and wrong types are malformed.
- Welcome's `columns`/`rows` limits bound Grid dimensions and maximum row-patch count.
- Coordinates must fit the current Grid; style indices must exist in its retained or replacement
  table. Row patches cannot repeat a row or overlap runs.
- `text_bytes_per_row` counts UTF-8 bytes; JSON Schema string lengths count Unicode characters.
- Framing bytes and parser value/depth bounds still apply. A schema-valid update may be rejected
  for stale ownership, current geometry, or retained-memory capacity.

## Placement

Placements are `dock.left`, `dock.right`, `dock.top`, `dock.bottom`, `float`, and `overlay`.
Core still owns tiled terminal layout; extension Surfaces compose around or above it, not as
synthetic Panes.

Docks reserve Attachment viewport space. Structural changes resolve Surface placement, then Core
layout, Pane geometry, and dependent PTY/Ghostty resize. The extension declares constraints; native
code resolves geometry and commits the transaction. A rejected transaction retains prior Surface
state.

Floats and overlays reserve no tiled space. They can be opaque or transparent: missing runs in
transparent rows reveal repaired lower Scene content. Docks must be opaque because their reserved
space has no Pane backing.

After terminal shrink, docks resolve in ascending Surface-slot order. A dock that cannot leave at
least one Pane cell on its axis is suspended and reserves no space; later docks may still fit.
Floats/overlays extending beyond the viewport are suspended whole, not clipped or moved. Suspension
retains placement and content, revokes focus/pointer capture to native Pane fallback, and does not
block closing or repairing another Surface. A suspended Surface reappears when it fits, without
retaking focus. Creating or configuring a Surface requires its new placement to resolve visibly;
native layout minimums and fallible PTY resize can still reject the structural transaction.

## Focus and input

A focusable Surface receives input only while it owns Attachment focus. Mouse interaction may focus
it according to native Scene policy; programmatic focus uses Proc. Successful numbered/next/previous
Tab selection, Pane focus, and creation with `focus=created` return input to the native Pane,
regardless of frontend. Rejected operations and `focus=preserve` creation retain Surface focus.
Native prompts temporarily take input without changing that semantic target; canceling returns to it.

Surface interaction Events include `surface.resized`, `surface.focused`, `surface.blurred`,
`surface.closed`, `surface.key`, `surface.mouse`, and `surface.paste`. Local picker queries, selected
rows, and scrolling belong to the extension, not Core.

`surface.mouse` coordinates are zero-based offsets from the Surface origin. Pointer capture preserves
delivery outside the Surface and reports signed out-of-bounds offsets.

`surface.key` carries either `text` (complete valid UTF-8, including escaped U+0000) or `bytes_hex`
(opaque bytes as lowercase hexadecimal), never both. Invalid or split UTF-8 chunks use `bytes_hex`.
Reconstruct a raw stream by UTF-8-encoding text and hex-decoding bytes in Event order; there is no
lossy replacement or cross-record Unicode assumption. `surface.paste` always uses `bytes_hex`.

Input is chunked below Welcome's `input_bytes` bound (8192 bytes), covering maximum-size legacy key
records. Paste production uses at most 4096 bytes per turn, leaving framing headroom after hex
encoding in the write quantum. Chunks are transport boundaries, not characters or complete pastes.
Hex/JSON expansion fits the record bound; queue overflow remains a separate policy.

## Backpressure and failure

Welcome reports per-owner and aggregate peer, Surface, retained input/output, and per-turn service
limits. Accounting derives from peer-owned input, records, queues, Events, and Proc reservations.
Event bytes include framing and decrement as written; a record occupies its Event slot until its
last byte drains, even while unrelated output keeps the queue nonempty.

Global turn budgets charge socket reads/writes, record count, and complete framed bytes before
parsing or structural application. Rotating peer order prevents a low slot from owning successive
budgets. Slow peers cannot grow memory without bound or block unrelated Procs, PTYs, or Attachments.
An update storm can delay presentation or disconnect its owner on resource exhaustion, but cannot
create unbounded scheduling work or silently drop dependent accepted patches.

Unchanged retained content creates no extension work. Hidden or fully occluded Surfaces need no
composition work until they affect output. With no damage or Events, idle extensions should add no
per-byte, per-cell, or per-frame work beyond bounded connection bookkeeping. Validate isolation
with the [extension performance gate](performance.md#extension-isolation), not idle-helper timings
alone.

Crash, protocol failure, or disconnect cleans up the failed owner as described above. Native UI,
Sessions, Panes, terminal state, and unrelated extensions remain usable. A malformed content update
is rejected transactionally; extension code never participates in Core lifecycle transitions.

For executable boundary coverage, see the [runtime tests](../tests/mux/test_extension_runtime.py)
and [Surface conformance corpus](../tests/mux/fixtures/extension_conformance.json).
