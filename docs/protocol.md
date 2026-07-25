# Fiber local protocol

## Status and scope

The current protocol is the bounded local wire format used by the runtime. Its implementation
remains in `src/protocol/single_pane.*` for now so framing can be tested independently of sockets and
terminal state. It is not yet the final generalized protocol and currently has no version
negotiation; incompatible changes must therefore remain coordinated between the daemon and client.
This process-named status revision uses the `fiber-v8-<uid>.sock` endpoint so it cannot attach to an
older daemon that does not reserve or refresh the status row correctly.

All integers are unsigned big-endian. Message type values are one ASCII byte for diagnostics only;
they must be treated as binary enum values, not text.

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
bytes and is deliberately unframed in the current protocol.

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

## Client/daemon evolution requirements

Remote operation and independent client releases eventually require a generalized client/daemon
protocol with magic, version and capabilities, request IDs, explicit message lengths in both
directions, typed errors, stable IDs, peer authentication, and bounded terminal-output semantics.
Its semantic commands should be shared with built-in and Lua operations, while its transport may be
a local Unix socket or SSH stdio.

Introduce those fields as one tested protocol change with golden encodings, fragmentation,
malformed- and oversized-input cases, client/daemon mismatch diagnostics, and fuzz coverage. The
versioned endpoint may coexist with the current endpoint during development, but a client must never
silently speak one format to a daemon expecting the other. Exact remote CLI and launch-context
behavior remain open in [`product-contract.md`](product-contract.md).
