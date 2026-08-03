# Lemma local protocol

## Status and scope

The current protocol is the bounded local wire format used by the runtime. Its implementation remains
in `src/protocol/single_pane.*` so framing can be tested independently of sockets and terminal state.
It has no version negotiation and daemon-to-attached-client output is currently unframed ANSI.
Incompatible changes therefore remain coordinated through the process-named `lemma-v8-<uid>.sock`
endpoint.

The production direction is a bounded versioned **server-rendered** protocol. It preserves daemon
terminal and presentation authority, frames both directions, and does not carry terminal checkpoints,
raw PTY event tails, or client VT replicas. Migration priority is maintained in the rolling
[`TODO.md`](../TODO.md) backlog.

All integers in the current format are unsigned big-endian. Current one-byte ASCII-looking type
values are diagnostic conveniences, not text protocol values.

## Production server-rendered protocol contract

```text
client -- typed key/text/paste/focus/mouse/resize/command --> daemon
client <-- typed result/error/effect + bounded ANSI frame -- daemon
```

The daemon owns canonical terminals, topology, resolved rectangles, per-attachment view state,
application-input encoding, and ANSI composition. The client owns physical input decoding, transport,
outer-terminal writes, and cleanup. Attach and recovery regenerate complete visible state from the
daemon; no replay log is needed.

### Envelope

Every production message is framed. The reviewed envelope must include or derive:

- magic and major/minor protocol version;
- closed message kind and flags;
- bounded payload length;
- request/result correlation ID where applicable;
- stable space, window, pane, and client IDs in explicit targets; and
- negotiated input, presentation, and effect capabilities.

Frames, decoder storage, queued output, messages per turn, setup progress, and aggregate per-client
memory all have explicit limits. Unknown required versions, kinds, flags, enum values, IDs, or
capabilities produce typed errors or disconnect before partial state mutation. Wire values are
Lemma-owned and never expose Ghostty types or private layouts.

### Message families

The initial production protocol carries:

- `client_hello`, `daemon_hello`, and actionable mismatch results;
- attach/create/list/window-list/kill/shutdown requests and typed results;
- stable topology values needed by command results and diagnostics;
- ordered key, text, paste, focus, mouse, resize, command, and detach input;
- bounded complete ANSI render frames and full-redraw generation/epoch markers;
- title, bell, clipboard, notification, or other typed client effects where explicit client policy is
  required; and
- ping/progress/error values needed for bounded setup and cleanup.

The attached-client envelope remains private and version-coupled to the binary. It is not exposed as
an automation protocol.

### Public semantic automation

One transport-independent semantic schema is shared by `--format=json`, the isolated Lua host, and a
versioned same-user automation socket for scripts and AI agents. It includes:

- stable object and actor/client IDs, request correlation, deadlines, cancellation, and optional
  idempotency keys;
- typed commands, arguments, success/no-effect/capacity/unavailable/stale/malformed errors, and
  capability/schema introspection;
- immutable topology, process, terminal-observation, configuration, and extension snapshots;
- typed launch with executable/arguments, cwd, bounded environment, PTY, and remain-on-exit policy;
- bounded capture, send-text/key/paste, wait-for-output/exit, signal, cancel, restart, and close;
- bounded lifecycle/topology/configuration/output events with sequence, truncation, gap, and snapshot-
  repair semantics; and
- generated machine-readable schemas plus a maintained agent skill.

Automation never receives ANSI render frames as state, Ghostty/private values, or direct descriptors.
Every supported human semantic mutation has an equivalent request or a documented exclusion. The
public semantic compatibility policy is independent from private attached-client framing.

### Attach and full redraw

A successful attach is an explicit transaction:

1. exchange version/capability hello values;
2. resolve the space and allocate daemon-side attachment state;
3. validate canonical dimensions;
4. invalidate retained presentation state;
5. queue one complete visible ANSI frame; and
6. enter live input/output only after setup succeeds.

Active-window changes, resize, reconnect, and presentation invalidation use the same complete-frame
path. Reliable stream order preserves accepted frames.

### Backpressure and recovery

Only complete bounded frames enter an attachment queue. Once a frame begins writing it is completed
or the connection is retired; bytes from different frames are never spliced. While a frame is
blocked, new PTY output remains represented by canonical terminal damage instead of growing an output
log. When the frame drains, the daemon emits a full redraw at a newer generation. A client that misses
its bounded progress deadline is disconnected without affecting pane processes or unrelated work.

A reconnect always receives a fresh complete frame. Delta resume may be added as a measured
optimization, but correctness never depends on retained render history or acknowledgements.

### Typed control and input

Commands use the same semantic values as built-in key and Lua operations, with typed success,
no-effect, capacity, unavailable, invalid-target, malformed, mismatch, and internal errors.

Input preserves the order of bounded key, text, paste, focus, resize, mouse, command, and detach
values. Clients decode physical sequences; the daemon owns prefix/keymap interpretation, presentation
hit testing, stable target resolution, and application-input encoding. Application mouse values are
translated from outer coordinates to validated pane-local cells using the daemon's current layout and
canonical terminal modes.

### Remote use

The 1.0 remote baseline is ordinary SSH terminal operation:

```sh
ssh -t host lemma
ssh host lemma list --format=json
```

That path runs the normal thin attached client on the remote host and lets SSH carry terminal bytes.
A later local client may carry the same framed protocol through an SSH-stdio bridge, but such a
transport does not change terminal/presentation ownership and is not a 1.0 requirement.

## Extension-host protocol

The isolated Lua host uses a separate implemented protocol in `src/protocol/extension.*`. Every
frame has a 20-byte header:

```text
+------------+---------+------+-------+--------------+------------+
| "FEX1": 4 | ver: u16| kind | flags | length: u32  | id: u64    |
+------------+---------+------+-------+--------------+------------+
```

Version 1 currently carries one host-to-daemon transactional generation: begin, bounded command and
keymap registrations, event subscriptions, retained sidebar declarations, commit, or configuration
error. Payloads are limited to 16 KiB and the incremental decoder owns 32 KiB. A message borrows
decoder storage only until consumption. The core reads at most a bounded message/read batch after
PTYs, client input, and rendering; it never waits for Lua.

A valid commit atomically replaces the active registration generation. A configuration error rejects
the candidate and preserves the prior generation. Disconnect removes active extension registrations
and schedules an isolated host restart. Command invocation, snapshots, event delivery, UI updates,
and output streams add versioned message kinds without exposing C++ storage.

The schemas below describe the independent currently implemented client/daemon protocol.

## Current control connection

A newly accepted connection starts with exactly one control command:

| Command | Byte | Following bytes | Meaning |
| --- | ---: | --- | --- |
| attach | `A` | name length, name, 2-byte columns, 2-byte rows | Attach to one space |
| create | `N` | name length, name | Ensure one space exists |
| list | `L` | none | List every space and close |
| list space | `Q` | name length, name | List one space and close |
| list windows | `W` | name length, name | List one space's windows and close |
| kill | `K` | name length, name | Stop one space and close |
| kill all | `X` | none | Stop every space and close |

A name length is one byte followed by 1–32 validated ASCII space-name bytes. Create and attach
return one response byte; a missing named space returns `M`:

| Response | Byte | Meaning |
| --- | ---: | --- |
| ready | `Y` | Space exists, or connection is now the streaming client |
| busy | `B` | Space already has an attached client |
| missing | `M` | Named space does not exist |
| capacity | `C` | Space capacity is exhausted |
| failed | `F` | Space creation failed |

After attached `Y`, the daemon sends a complete reconstructed frame before nonblocking live
operation.

## Current attached-client stream

Only the client sends framed messages. Daemon-to-client traffic is currently encoded outer-terminal
bytes and deliberately unframed. Detach and pane/window packets become bounded `lemma::Command`
values and pass through the shared validating dispatcher.

### Input

```text
+--------+----------------+-------------------+
| 'I'    | length: u16be  | length input bytes|
+--------+----------------+-------------------+
   1 B          2 B             0..8192 B
```

The client prefix parser may emit at most twice the terminal read batch. The decoder rejects larger
lengths before exposing a message. Recognized control/navigation sequences are normalized and encoded
through the canonical terminal adapter rather than blindly forwarded.

### Resize

```text
+--------+----------------+-------------+
| 'R'    | columns: u16be | rows: u16be |
+--------+----------------+-------------+
   1 B          2 B            2 B
```

The runtime clamps dimensions to hard limits, resizes pane PTYs, then resizes canonical terminals.

### Pane command

```text
+--------+--------------------+
| 'P'    | pane command: u8   |
+--------+--------------------+
   1 B           1 B
```

The command byte is a closed enum for window create/next/previous/select/kill and pane left/right or
top/bottom splits, directional/next/previous focus, close, and zoom. Unknown values terminate the
attached connection as protocol errors. The core applies commands only to the attached space and
active window.

### Detach

```text
+--------+
| 'D'    |
+--------+
   1 B
```

Detach closes only the attached connection. It does not terminate the shell or space.

## Current decoder contract

`protocol::ClientDecoder` owns a fixed 16 KiB buffer and supports arbitrary fragmentation and
coalescing. The caller:

1. obtains `writable_bytes()`;
2. receives at most that span's size;
3. calls `commit(received)`;
4. calls `next()` until incomplete;
5. processes each borrowed message synchronously; and
6. calls `consume()` before receiving or decoding another message.

A span in `ClientMessage` borrows decoder storage and becomes invalid on `consume()` or `reset()`. It
must never be retained in core state or passed to deferred extension work. Unknown types, oversized
lengths, and buffer exhaustion are terminal protocol errors and never partially mutate mux state.

## Current prefix parser

The client recognizes a fixed tmux-compatible `C-b` prefix:

- `C-b %` and `C-b "` split left/right and top/bottom;
- `C-b Arrow`, `C-b o`, and `C-b ;` change pane focus;
- `C-b x` and `C-b z` close and zoom;
- `C-b c`, `C-b n`, and `C-b p` create/cycle windows;
- `C-b 1` through `C-b 9` select windows 1–9, `C-b 0` selects window 10, and `C-b &` closes the
  active window;
- `C-b d` detaches;
- `C-b C-b` sends a literal prefix; and
- unknown keys forward the literal prefix and key.

Incomplete prefix sequences remain pending for at most 50 ms, then forward literally. Command
actions retain offsets among ordinary input so packet emission preserves order. The eventual
configurable key-table system replaces this fixed policy without moving command authority into the
client.

## Migration and validation requirements

The versioned endpoint may coexist with `lemma-v8` only for explicit migration tests. Peers never
silently speak one format to another. The production change requires:

- golden encodings and round trips for every envelope and value;
- fragmentation, coalescing, malformed, truncated, stale-ID, oversized, version, capability,
  progress-deadline, and output-backpressure cases;
- complete-frame partial-write and forced-full-redraw tests;
- blocked/non-reading client process scenarios proving unrelated PTY progress;
- attach, resize, window-change, reconnect, and lag reconstruction tests;
- one bounded protocol fuzz corpus;
- precise mismatch diagnostics; and
- preservation of every existing mux process scenario during cutover.

Current implementation priority and completion checks are maintained in [`TODO.md`](../TODO.md).
