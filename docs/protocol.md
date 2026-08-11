# Lemma private local protocol

## Status and scope

The attached terminal path uses private protocol **1.0** on the per-user
`lemma-private-1.0-<uid>.sock` endpoint. It is version-coupled to the Lemma binary and is not a
public RPC, automation, capture, or extension API. The daemon remains authoritative for sessions,
tabs, panes, PTYs, canonical terminal state, layout, and ANSI composition. The attached client only
decodes physical input, transports validated messages, writes complete ANSI frame payloads to the
outer terminal, and restores that terminal.

The existing bounded one-request CLI control commands (create, list, list-tabs, kill, and shutdown)
share the local listener but are not accepted after an attach hello and cannot enter the attached
stream. F4 deliberately does not add semantic automation or public commands.

## Envelope

Every attached message in both directions has this 16-byte big-endian envelope:

```text
+-----------+-------+-------+------+-------+------------+--------------+
| 89 L M A | major | minor | kind | flags | length:u32 | sequence:u32 |
+-----------+-------+-------+------+-------+------------+--------------+
     4 B       1 B     1 B    1 B    1 B       4 B          4 B
```

- Version is exactly `1.0`; this private protocol performs no downgrade or feature negotiation.
- Sequence starts at one independently in each direction and must increase by exactly one.
- Sequence zero, wrap, unknown kind or flags, a bad magic/version, and a kind-specific invalid
  length are terminal protocol errors.
- Header validation occurs as soon as 16 bytes are available. A payload is not exposed until its
  complete bounded bytes and every typed field have been validated.
- No C++ layout, Ghostty value, pointer, descriptor, or native-endian integer is placed on the wire.

The daemon's incremental decoder owns 8,208 inline bytes. The attached client prepares one bounded
4,194,324-byte RAII decoder allocation before entering raw or alternate-screen mode; pages are
faulted only for received bytes. Borrowed payload views remain valid only until `consume()` or
`reset()`. Decoders accept arbitrary fragmentation and coalescing and retain an unconsumed message
for downstream backpressure.

## Closed message set

| Kind | Direction | Flags | Payload | Bound and validation |
|---|---|---:|---|---|
| `hello` (1) | client to daemon | 0 | name length:u8, columns:u16, rows:u16, name | 6–37 B; 1–32 validated session bytes; dimensions 1–500 by 1–200 |
| `hello` (1) | daemon to client | 0 | columns:u16, rows:u16 | exactly 4 B and must echo the accepted viewport |
| `input` (2) | client to daemon | 0 | normalized input bytes | 1–8,192 B |
| `resize` (3) | client to daemon | 0 | columns:u16, rows:u16 | exactly 4 B; dimensions validated before resize |
| `pane_command` (4) | client to daemon | 0 | closed `PaneCommand`:u8 | exactly 1 B; unknown/`none` rejected |
| `detach` (5) | client to daemon | 0 | none | exactly 0 B |
| `render_frame` (6) | daemon to client | bit 0 = full redraw | generation:u32, ANSI bytes | 5–4,194,308 B; generation nonzero; ANSI at most 4 MiB |
| `disconnect` (7) | daemon to client | 0 | reason:u8, printable diagnostic | 1–256 B; closed reason enum |

Pane commands are limited to the built-in split, focus, close, zoom, create/cycle/select/kill-tab
operations already reachable through the prefix keymap. Input remains ordered with commands, resize,
and detach by the client sequence. No list, capture, arbitrary target, RPC correlation, automation,
mouse, clipboard, or extension message exists in this protocol.

Disconnect reasons are `normal`, `protocol_error`, `version_mismatch`, `session_busy`,
`session_missing`, `capacity`, `setup_failed`, `frame_timeout`, `daemon_shutdown`, and
`internal_error`. Setup rejection carries a printable actionable diagnostic in a complete framed
message. A version mismatch is rejected before session lookup, reservation, frame allocation,
terminal resize, or attach mutation.

## Attach transaction and validation

1. The client allocates its bounded server decoder and sends client `hello` sequence 1.
2. The daemon incrementally validates magic, exact version, kind, flags, length, sequence, session
   syntax, and dimensions before looking up or mutating a session.
3. Missing/busy/failed setup returns `disconnect` sequence 1 and closes after its bounded partial
   write completes. A successful setup reserves one attachment and returns daemon `hello` sequence 1.
4. Only after that hello drains does the daemon hand off the descriptor, initialize live client
   sequence 2, initialize server sequence 2, invalidate retained presentation, and compose a full
   frame.
5. The client enters raw and alternate-screen modes only after a valid daemon hello. Any startup
   failure before that point leaves the terminal untouched.

For live messages, the decoder validates all wire fields before command dispatch, PTY queueing, or
resize. Input payload bytes are opaque only after their envelope is complete; normalized key
encoding and PTY queue capacity remain daemon-owned. A malformed live peer receives a typed protocol
disconnect through the same bounded partial-write machinery when output progress permits, then the
connection is retired without terminating pane processes.

## Render generations, backpressure, and recovery

A transport render message is one complete retained ANSI frame, never an ambiguous socket byte
stream. It has 20 bytes of wire overhead: the 16-byte envelope plus the four-byte full-redraw
generation. The client strips these bytes and writes only the validated ANSI payload to the outer
terminal.

The first render after every attach is full redraw generation 1. A full redraw increments generation
by exactly one; incremental frames repeat the current generation. The client rejects a delta before
the first full frame, a skipped/repeated full generation, or a delta carrying another generation.
Resize, active-tab changes, reconnect, and lag repair all use the daemon's forced-full composition
path. A reconnect starts a fresh attachment and generation 1 rather than replaying a log.

F2 output policy is unchanged and counts framing bytes against its budgets:

- one retained output per attached client;
- at most 64 KiB per client and 256 KiB daemon-wide socket-write progress per reactor turn;
- at most 32 write attempts per client per turn with a persistent round-robin cursor;
- 5 s no-progress and 30 s total-message deadlines;
- partial writes resume at the exact envelope/payload offset; and
- damage arriving behind an in-flight frame stays in canonical terminal state and collapses into one
  later forced full redraw.

A started message is completed or the connection is retired; bytes from messages are never spliced.
A blocked peer therefore has bounded memory, CPU, and lifetime and cannot grow an ANSI event log.

## Terminal cleanup

The client installs handlers for `SIGINT`, `SIGTERM`, `SIGHUP`, `SIGQUIT`, and `SIGWINCH` before raw
mode. A termination handler records signal state, writes nonblocking wakeups, retires a blocked render
writer, and wakes a pre-created control-only restorer. That bounded helper owns an independent tty
endpoint, restores the original termios without waiting for presentation output, and reports the
result to normal scope unwind. The client then emits the outer-mode cleanup through a separate bounded
writer. Clean detach, typed disconnect, EOF, daemon loss, protocol failure, outer-terminal write
failure, and startup failure after raw entry use the same RAII-owned terminal state without the signal
handoff.

## Reproduction coverage

`ProtocolTest` retains deterministic golden encodings and covers fragmented/coalesced decode,
length/type/flag/enum/dimension/session/sequence/version/generation failures, oversize rejection,
typed diagnostics, and redraw recovery. `ClientFrameOutputTest` injects partial writes, EINTR,
EAGAIN, budgets, deadlines, typed-disconnect recovery, blocked output, and forced redraw. Process
tests cover incompatible and malformed local peers, no-partial mismatch mutation, setup slot reuse,
blocked readers, tab/resize/reconnect generations, malformed-peer recovery, daemon loss, EOF,
startup rejection, normal detach, all handled signals, and signal restoration while outer-terminal
output is blocked. F5's stress lane repeats malformed live/setup peers, setup-capacity exhaustion,
non-reading clients, blocked PTYs, resize/output floods, child exit, and recovery against fresh real
daemons; its raw GoogleTest and blocked-client reports are retained as `build/release/f5-*`.
