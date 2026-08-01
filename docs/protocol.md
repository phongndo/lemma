# Lemma local protocol

## Status and scope

The current protocol is the bounded local wire format used by the runtime. Its implementation
remains in `src/protocol/single_pane.*` for now so framing can be tested independently of sockets and
terminal state. It is not yet the final generalized protocol and currently has no version
negotiation; incompatible changes must therefore remain coordinated between the daemon and client.
This process-named status revision uses the `lemma-v8-<uid>.sock` endpoint so it cannot attach to an
older daemon that does not reserve or refresh the status row correctly.

All integers in the current format are unsigned big-endian. Current message type values are one
ASCII byte for diagnostics only; they must be treated as binary enum values, not text.

## Target checkpointed replication protocol

The generalized protocol replaces the attached output model rather than merely framing its ANSI
bytes. It has one terminal-data architecture for local Unix sockets and SSH stdio:

```text
terminal checkpoint at pane sequence N
-> ready
-> ordered output/resize/reset/exit events after N
-> progressive history ranges
```

The daemon owns canonical terminal state and event sequence allocation. Smart clients own imported
replicas and presentation. ANSI is a client presentation backend; daemon-to-attached-client composed
ANSI is removed after migration. The active feasibility gate is
[`.plan/002-terminal-checkpoint-feasibility.md`](../.plan/002-terminal-checkpoint-feasibility.md), and
final checkpoint sections or wire kind values must not be frozen before it passes.

### Envelope requirements

Every direction is framed. The reviewed production envelope must include or unambiguously derive:

- magic and major/minor protocol version;
- message kind and flags;
- bounded payload length;
- request/result correlation ID where applicable;
- stable workspace, window, pane, and client IDs in payloads that target them; and
- capability/version negotiation for terminal checkpoints, typed input, history, compression,
  presentation, and transport behavior.

All frames, decoder storage, queued output, messages per turn, and aggregate per-client memory have
explicit limits. Unknown required versions, kinds, enum values, IDs, sequence ranges, or capabilities
produce typed errors or disconnect before partial state mutation. The protocol encoding is
Lemma-owned and never copies Ghostty private structs or enum numbers onto the wire.

### Terminal stream values

Each pane has one monotonically ordered sequence covering:

- `terminal_output(bytes)`;
- `terminal_resize(columns, rows, cell pixel dimensions)`;
- `terminal_reset(reason)`; and
- `terminal_exit(status, reason)`.

A checkpoint names its pane, terminal-checkpoint format/features, canonical dimensions, fence
sequence, visible-ready state, and available/missing history ranges. Chunk boundaries are not assumed
to be parser boundaries. Export/import must preserve deterministic continuation across incomplete
UTF-8 and terminal escape sequences.

The daemon is the only endpoint allowed to emit terminal-generated PTY responses or apply
authoritative terminal side-effect policy. Replica import and event application suppress those
outputs.

### Attach, ready, and history

A successful attach proceeds as one explicit state machine:

1. exchange hello/version/capability messages;
2. resolve the workspace and return stable topology IDs;
3. fence each presented pane at an authoritative sequence;
4. send topology and bounded visible checkpoints;
5. send `ready` only after the client can publish its replicas and accept input;
6. send all later ordered pane events without a checkpoint/tail gap; and
7. send bounded recent-to-oldest history chunks at lower priority.

History range identity is independent of the live pane sequence. A client can distinguish complete,
partial, and missing history and can request bounded ranges without blocking live output.

### Acknowledgement, resume, and reset

Clients acknowledge the highest contiguous applied sequence per pane. Resume is allowed only when
session identity, object generations, protocol/checkpoint versions, topology, and every required
event range still match. Otherwise the daemon sends a fresh topology/checkpoint transaction.

A slow client's pending events remain bounded. When it exceeds its lag policy, the daemon stops
retaining an unbounded tail, transitions the client through an explicit reset, sends a newer
checkpoint, and resumes from its successor sequence. If bounded checkpoint progress cannot complete
before its deadline, the client is disconnected without affecting pane or unrelated client progress.

### Typed control and input

Commands use the same semantic command values as built-in and Lua operations, with typed results and
errors. Input preserves the order of bounded key, text, paste, focus, resize request, mouse, command,
and detach values. Lemma-owned client chrome is hit-tested in the client and emits semantic commands
with stable targets. Application mouse input carries a validated `PaneId` and pane-local coordinates;
the daemon validates and encodes it using canonical terminal modes.

One controlling client determines canonical PTY dimensions. A viewer cannot independently resize the
same terminal replica; later permission/control-transfer messages make that authority explicit.

### Transport independence

Unix sockets and SSH stdio carry the same application frames and state machines. Authentication and
transport setup do not weaken protocol validation. Schedulers may prioritize control/input/live
visible events over history, but they cannot reorder events within a pane stream. Compression is
negotiated and bounded for measured large checkpoints, history, or output chunks; tiny interactive
messages are not compressed by assumption.

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
and output streams will add versioned message kinds without exposing C++ storage.

The schemas below remain the description of the independent implemented client/daemon protocol.

## Control connection

A newly accepted connection starts with exactly one control command:

| Command | Byte | Following bytes | Meaning |
| --- | ---: | --- | --- |
| attach | `A` | name length, name, 2-byte columns, 2-byte rows | Attach to one workspace |
| create | `N` | name length, name | Ensure one workspace exists |
| list | `L` | none | List every workspace and close |
| list workspace | `Q` | name length, name | List one workspace and close |
| list windows | `W` | name length, name | List one workspace's windows and close |
| kill | `K` | name length, name | Stop one workspace and close |
| kill all | `X` | none | Stop every workspace and close |

A name length is one byte and is followed by 1-32 validated ASCII workspace-name bytes. Create and
attach return one response byte; a missing named workspace also returns `M`:

| Response | Byte | Meaning |
| --- | ---: | --- |
| ready | `Y` | Workspace exists, or the connection is now the streaming client |
| busy | `B` | This workspace already has an attached client |
| missing | `M` | The named workspace does not exist |
| capacity | `C` | Workspace capacity is exhausted |
| failed | `F` | Workspace creation failed |

After `Y`, the daemon sends a complete reconstructed terminal frame before switching the connection
to nonblocking live operation.

## Attached-client stream

Only the client sends framed messages. Daemon-to-client traffic is already encoded outer-terminal
bytes and is deliberately unframed in the current protocol. Detach and pane/window command packets
are translated into bounded `lemma::Command` values and validated by the shared dispatcher before
the engine applies them. Wire enums therefore do not double as authoritative core operations.

### Input

```text
+--------+----------------+-------------------+
| 'I'    | length: u16be  | length input bytes|
+--------+----------------+-------------------+
   1 B          2 B             0..8192 B
```

The client prefix parser may emit at most twice the terminal read batch. The decoder rejects larger
lengths before exposing a message. Input bytes are normalized and encoded through the pane's
terminal adapter rather than blindly forwarding recognized control/navigation sequences.

### Resize

```text
+--------+----------------+-------------+
| 'R'    | columns: u16be | rows: u16be |
+--------+----------------+-------------+
   1 B          2 B            2 B
```

The runtime clamps dimensions to its configured hard limits, resizes the PTY, and then resizes the
canonical terminal state. Both operations must succeed.

### Pane command

```text
+--------+--------------------+
| 'P'    | pane command: u8   |
+--------+--------------------+
   1 B           1 B
```

The command byte is a closed enum for window create/next/previous/select/kill and pane left/right or
top/bottom splits, directional/next/previous focus, close, and zoom. Unknown values terminate the
attached connection as protocol errors. The core applies commands only to the attached workspace
and its active window.

### Detach

```text
+--------+
| 'D'    |
+--------+
   1 B
```

Detach closes only the attached connection. It does not terminate the shell or workspace.

## Decoder contract

`protocol::ClientDecoder` owns a fixed 16 KiB buffer and supports arbitrary stream fragmentation and
coalescing. The caller follows this sequence:

1. obtain `writable_bytes()`;
2. receive at most that span's size;
3. call `commit(received)`;
4. call `next()` until it reports incomplete input;
5. process each borrowed message synchronously; and
6. call `consume()` before asking for another message or receiving more bytes.

An input span returned in `ClientMessage` borrows decoder storage and becomes invalid on `consume()`
or `reset()`. It must never be retained in core state or passed to deferred extension work.

Unknown types, oversized lengths, and buffer exhaustion are terminal protocol errors for that
connection. They never partially mutate mux state.

## Prefix parser

The attached client currently recognizes a fixed tmux-compatible `C-b` prefix:

- `C-b %` and `C-b "` emit left/right and top/bottom split commands;
- `C-b Arrow`, `C-b o`, and `C-b ;` emit focus commands;
- `C-b x` and `C-b z` emit pane close and zoom commands;
- `C-b c`, `C-b n`, and `C-b p` create, select the next, or select the previous window;
- `C-b 1` through `C-b 9` select windows 1-9, `C-b 0` selects window 10, and `C-b &`
  kills the active window;
- `C-b d` emits a detach message;
- `C-b C-b` emits one literal `C-b` input byte;
- unknown keys forward the literal prefix and key.

Incomplete prefix sequences remain pending for at most 50 ms. If the sequence is still incomplete,
the client forwards every buffered byte literally so a lone prefix or `C-b Escape` cannot be
swallowed indefinitely.

Command actions retain their offsets among ordinary input so packet emission preserves input order.
The parser handles fragmented arrow-key escape sequences, remains bounded, and stays outside
terminal VT parsing. The eventual configurable key-table system will replace this fixed policy.

## Migration and validation requirements

The generalized endpoint may coexist with `lemma-v8` only while the smart client is proven and the
existing process suite is migrated. Peers must never silently speak one format to an endpoint
expecting the other. After cutover, production attached output uses the checkpoint/event protocol and
the old daemon ANSI endpoint is removed.

The protocol change requires:

- golden encodings and round trips for every envelope and value;
- checkpoint-plus-tail equivalence tests across arbitrary parser and resize boundaries;
- fragmentation, coalescing, malformed, truncated, duplicate, out-of-order, stale-ID, wrong-pane,
  oversized, version, and capability cases;
- transactional checkpoint import and allocation-failure tests;
- lag, acknowledgement, resume, forced reset, and non-reading-client process scenarios;
- one protocol fuzz target with a bounded seed corpus;
- the same behavior suites over local Unix and SSH-stdio transports; and
- mismatch diagnostics that tell users which client, daemon, protocol, or checkpoint version must be
  upgraded.

The target migration and exit gates are detailed in
[`.plan/003-replicated-terminal-foundation.md`](../.plan/003-replicated-terminal-foundation.md).
Exact remote CLI/bootstrap and config-synchronization behavior remain open in
[`product-contract.md`](product-contract.md).
