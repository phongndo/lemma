# Architecture

Lemma is one C++23 executable with client, daemon, and control roles. One per-user daemon owns all
live mux and terminal state. Clients are replaceable input and presentation edges.

```text
Lua config ─> isolated host ─> validated draft ─> immutable native generation
                                                  │
physical input ─> input policy ─┐                  │
CLI / API / mouse ───────────────┴─> typed command ─> Core ─> Runtime
                                                            ├─> PTY/process
PTY output ─> Ghostty terminal ─> render/composition ───────┴─> client
```

## Model

The kernel hierarchy is:

```text
Session -> Tab -> Pane
```

- A **Session** owns launch context, ordered Tabs, identity, lifecycle, and attachment policy.
- A **Tab** owns a pane layout, focus, zoom, ordering, and title policy.
- A **Pane** is the semantic identity of one process surface.
- An **Attachment** is the current controller's view and interaction state for a Session.

Projects, worktrees, tasks, and agent runs are not kernel objects. They can compose stable IDs
through the public API.

Semantic identity is separate from external-resource lifetime:

```text
Session != Attachment != AttachmentRuntime
Pane    != PaneRuntime
```

`PaneRuntime` owns the child process, PTY, terminal, write queue, and scheduling state for a Pane.
`AttachmentRuntime` owns the replaceable client connection, decoder, retained output progress,
presentation caches, and deadlines. Losing an AttachmentRuntime detaches the client; it does not
destroy the Session.

## Components

| Component | Responsibility |
| --- | --- |
| `lemma_app` | CLI grammar and executable role selection |
| `lemma_daemon` | Endpoint ownership, connection admission, and the reactor |
| `lemma_api` | Public Proc, nested Command, Event, JSON, and schema values |
| `lemma_core` | Session/Tab/Pane semantics, commands, layout, and copy policy |
| `lemma_input` | Compiled physical keymaps and per-Attachment input contexts |
| `lemma_config` | Bounded configuration values, wire validation, and native generation compilation |
| `lemma_extension` | Isolated Lua host lifecycle and transactional configuration admission |
| `lemma_runtime` | Processes, PTYs, scheduling, input execution, resizing, and frame progress |
| `lemma_terminal` | The only boundary allowed to include or link against libghostty-vt |
| `lemma_render` | Non-authoritative pane and frame presentation |
| `lemma_protocol` | Bounded private attachment codec |
| `lemma_client` | Host input, outer-terminal presentation, and restoration |
| `lemma_platform` | OS I/O, PTYs, and terminal mode mechanisms |
| `lemma_pty_launcher` | Private, dependency-minimal fresh-process child setup and exec |

Core links no Lua VM, PTY, socket, process, or terminal-emulator owner. Runtime executes accepted
semantic intent using those mechanisms. The daemon borrows one immutable compiled configuration
generation; input routing and runtime operation never call into the host process.

PTY creation prepares bounded launch data and descriptors in the parent, then uses `posix_spawn`
to execute `lemma-pty-launcher` beside the actual caller executable. There is no application-owned
post-fork child path. A nonblocking socket is completely prefilled before spawning; launch secrets
are neither argv nor files, and the helper's first exec receives an empty loader environment. The
single-use record has no listener, dispatcher, or persistent helper process. Command and environment
payloads retain their existing byte/count bounds; overlay assignments use the same environment
bounds without imposing a smaller per-name or per-value limit.

Spawn establishes the child's SID/process group and resets SIGCHLD/SIGPIPE while preserving the
caller's signal mask and credentials. Only the PTY at descriptors 0–2 and setup socket at descriptor
3 survive: Linux uses `posix_spawn_file_actions_addclosefrom_np` (glibc 2.34+), Darwin uses
`POSIX_SPAWN_CLOEXEC_DEFAULT`; both use `POSIX_SPAWN_SETSID`. After its first exec the helper acquires
the controlling terminal, applies cwd/environment/overlays, and performs account-shell lookup or
libc `execvp` resolution, including script fallback. It links no Ghostty, Lua, daemon, or privilege
initialization. There is one PID, one extra exec, and no long-lived intermediary. Parent-side
admission/bootstrap failure returns `-1` with precise `errno` after cleanup, without transferring the
master. As before, later child setup/target exec failure is exit 127, not distinguishable from an
intentional exit 127; there is no target-exec acknowledgement channel. The remaining daemon bootstrap
and isolated Lua-host forks occur on single-threaded startup paths; they must remain before Runtime
worker construction.

## Authority and ownership

Every mutable fact has one authoritative owner:

| State | Owner |
| --- | --- |
| Sessions, Tabs, Panes, layout, focus, zoom, stable IDs | Core |
| Attachment view plus copy, rename, command-line editor, bounded command history, and message log | Core |
| All key bindings, context options, transitions, and transient routing state | Input policy |
| Lua VM and uncommitted configuration draft | Extension host process |
| Processes, PTYs, descriptors, polling, clocks | Runtime |
| Canonical screen, history, modes, cursor, selection primitives | Ghostty behind `vt::Terminal` |
| Attachment connection decoding, output progress, and transient message/frame deadlines | AttachmentRuntime |
| Admitted Proc execution, waits, and owner-generation cancellation | Reactor Proc table |
| Frame buffers and physical presentation shadow | Render/runtime presentation |

A projection may be cached for presentation, but it remains bounded, invalidatable, and
authoritatively reconstructible. Stable IDs cross component and trust boundaries; borrowed
references remain owner-local.

The shipped interaction policy is configuration data, not a privileged routing path. The default
preset and an equivalent explicit user policy compile into the same immutable representation. Core
implements semantic commands such as resizing or moving a copy selection; configuration alone
selects the keys and routing-context transitions that invoke them.

## Commands

Keyboard and mouse interaction use direct typed input commands. Agent execution enters through a
Proc containing one to 64 ordered Commands:

```text
CLI / CONTROL -> Proc admission -> compiled Command -> Command executor -> Core command / Runtime intent
                     │                    │                   │
                     │                    │                   └─> lemma.command-result/v1
                     │                    └─> at most one per reactor turn
                     └─> validate all Commands and backward references once
```

`lemma.proc/v1` is the sole public execution request. CLI syntax and backward result references are
frontend representations rather than Core state. Before admission, Proc validation checks every
Command and reference. Execution resolves references to concrete generational IDs and performs
authoritative lifetime and ownership checks immediately before each Command. Closing an owning
connection invalidates its generation and cancels the Proc before another Command.

Lifecycle commands run through the deterministic `SessionMachine`: Core stages fallible semantic
owners, Runtime executes a bounded typed spawn/resize/retire effect batch, and Core publishes the
transition only after required effects succeed. Events observe committed state and never provide
another mutation path. The deterministic mux harness records concrete targets, arguments, and
Runtime outcomes at this boundary. Versioned traces therefore replay without the generator, and
recorded result/state checkpoints turn minimized failures into permanent regression corpus entries.

The interactive command line is another typed frontend, not another command executor. One native
catalog owns command paths and completion metadata. The attachment-owned editor parses its bounded
human grammar, fills omitted targets with current stable IDs, and dispatches the resulting typed
commands through the same executor used by Proc. While editing, the status row contains only the
command prompt. A failed submission closes the prompt and projects its typed result as a left-aligned
status message rather than exposing JSON. One monotonic AttachmentRuntime deadline expires that
projection after 1.5 seconds, while input can dismiss it immediately; the bounded Attachment message
log remains available through a synthetic read-only full-pane projection. The status renderer is
the sole owner of interaction chrome: active routing contexts and search prompts replace normal
Session/Tab status, while pane composition contains no mode-overlay path. Command history remains a
separate bounded fact. An optional configured file seeds the daemon-wide initial history and is
atomically replaced on clean shutdown only after a successful load or confirmed absence; live
Attachment histories still diverge independently. A
Session switch transfers one
drained connection decoder and sequence to an existing detached Session, then forces a full redraw;
it never creates a nested client or restarts the terminal process. The catalog is the sole
projection boundary for command descriptors, and handlers at that boundary compile to bounded typed
Lemma commands rather than introducing another execution path.

Application input is distinct from mux commands. The attached client preserves one typed envelope
and sequence per event; when one physical read contains multiple mouse reports, it copies those
complete envelopes into a bounded 16 KiB transport batch and sends each full batch once. The daemon
input policy resolves physical bindings; Runtime then asks the target Pane's Ghostty terminal to
encode mode-dependent keyboard, paste, focus, and mouse input.

`PaneRuntimeStore` owns an intrusive generation-safe registry of live Panes. Reactor descriptor
publication and non-dormant Pane work iterate that registry rather than the 4,096-slot capacity. The
store is also the authority for failed and unparking counts, whether PTY writes can be pending, and
the minimum parking, presentation, and compression deadlines. Queueing or arming work tightens its
hint immediately; a reached conservative stale minimum permits one bounded live-Pane refresh but can
never make work late. Failure clearing, hold, removal, and hydration transitions balance the counts.
`Sessions` keeps generational identity in its bounded store and lifecycle-maintained dense pointer
registries for all live Sessions, attached controllers, and pending frame work; swap removal updates
the moved Session's inverse index. Fixed pending-connection, observer, Proc, and capacity-rejection
tables retain authoritative dense live-slot registries: stable protocol indices still address sparse
owners, while ordinary descriptor, service, and deadline passes are O(live owners). Turn-local
per-Session budgets initialize only slots owned by the dense live-Session registry. The reactor
samples one clock value for pre-poll work and refreshes it after the blocking poll, and it collects
children only when the child-reaper descriptor reports readiness.

On Linux, sets of at least eight descriptors use one persistent epoll queue while sparse; every
descriptor owner supplies a nonzero identity for its exact ownership lifetime, so closing and reusing
the same numeric descriptor forces a new registration. Event-mask and index changes reconcile before
waiting. A prior turn with at least 25% readiness uses `poll()` for the next turn to avoid epoll's
dense-event cost, and any epoll setup or synchronization failure also falls back to `poll()`. Other
platforms retain `poll()` until their native backend has execution evidence. Both paths preserve the
same server-before-input ordering and bounded per-turn fairness.

## Terminal and presentation flow

Ghostty owns VT semantics. Lemma owns process, mux, security, scheduling, and presentation policy.
PTY bytes are parsed once into the Pane's canonical terminal:

```text
PTY -> Ghostty parse
          ├─> terminal responses -> ordered PTY write queue
          ├─> effects -> Lemma policy
          └─> damage -> render -> pane composition -> attached client
```

Ghostty's borrowed response callback appends synchronously to the Pane's existing bounded ordered
PTY write queue before later accepted application input. The terminal adapter retains no duplicate
response queue; a missing or rejecting sink fails that Pane closed. Attach, resize, tab changes, and
lag recovery can rebuild a complete ANSI frame from daemon-owned state. The client does not own a
second terminal grid or PTY replay log.

The terminal boundary can encode one complete pin-specific Ghostty snapshot into caller-owned
storage and restore it through the same quota allocator, terminal policy, callbacks, and adapter
helpers used by fresh construction. Encoding and input are capped by the 64 MiB snapshot boundary;
restore requires a CRC-valid FINISH marker, no trailing bytes, and the server-retained Pane geometry.
Continuation tracking is disabled by default so ordinary terminals pay no new per-input work. The
pinned Ghostty snapshot omits tracked selection, so an active selection makes snapshot sizing and
encoding fail closed; automatic parking then retains the authoritative live terminal and retries
only after another quiet interval. A Pane that may be snapshotted opts into at most 1 MiB before receiving input, allowing unfinished VT
and UTF-8 parser state to survive restore. Complete restore and READY-first restore share one path;
each incremental step consumes at most one history page and reports source and screen progress.
Destroying an unfinished restore cancels it by freeing the decoder before its borrowed terminal.
`PaneResidency` encodes `Active -> Parking -> Parked -> Unparking -> Active`. Active PTYs permit I/O;
parked PTYs permit readiness observation only. Output/HUP/ERR readiness requests restoration without
reading bytes. Hydrating PTYs are omitted from the readiness set until complete; merely clearing the
event mask would still spin on level-triggered HUP with `poll()`. Attach, input, capture, output, and
explicit terminal-dependent requests share the wake transition. Hydration fairly advances at most
one Ghostty history page per Pane step and eight Pane steps per reactor turn.

Cold states own an owner-only, unlinked, close-on-exec file containing libsodium
[XChaCha20-Poly1305 secretstream](https://libsodium.gitbook.io/doc/secret-key_cryptography/secretstream)
ciphertext, not plaintext. Every 64 KiB chunk authenticates the exact pin/profile, schema, geometry,
and length envelope as additional data. The ordered stream and required final tag reject mutation,
reordering, truncation, and trailing bytes before Ghostty receives any plaintext. Each snapshot owns
an independent random key in guarded, explicitly locked libsodium memory; failed key locking fails
parking admission without losing the live terminal. The stream state shares that locked allocation
and is wiped after each operation. Keys are wiped on snapshot destruction. This protects backing-file
contents from recovery/tampering, not live-memory compromise, process dumps, hibernation, or swap of
transient plaintext. Memory locking has [OS and register/stack limitations](https://libsodium.gitbook.io/doc/memory_management).

Encoding and decryption use operation-owned anonymous plaintext mappings that are wiped and unmapped
on release. The restoring decoder is destroyed before its borrowed plaintext mapping, including on
cancellation. Parked storage retains one descriptor and one guarded locked allocation per Pane.
Payload quotas exclude the 120-byte envelope, 17-byte per-chunk authentication overhead, filesystem
allocation rounding, and kernel ciphertext cache. Hydration temporarily holds encrypted backing,
a full decrypted snapshot, and the rebuilding terminal simultaneously. No crash durability is
promised: writes use checked `pwrite`, not writable file mappings or synchronous `msync`/`fsync`.
Deferred kernel writeback and cache memory still cost resources; a daemon PSS reduction alone does
not measure them.

The reactor parks only live, quiet Panes in detached, unobserved Sessions after five minutes.
Creation, detach, wake, hydration completion, and output activity arm/postpone authoritative quiet
deadlines. Only a due minimum permits an eligibility walk. Pending writes, observers, and pending
attachments retain a conservative retry deadline; failures retry after a full interval from attempt
completion. Each due pass selects at most one Pane round-robin, including failures. Snapshot sizing,
encoding, encryption/I/O, and initial decryption remain synchronous: this bounds the Pane multiplier,
not the maximum single-operation reactor latency. Large-snapshot foreground isolation remains an
unqualified merge gate. Attach preparation retains
its reservation until every Pane is active; automation receives retryable `pane_hydrating` while a
wake is pending. Restore failure fails the Pane rather than consuming later PTY bytes against an
unknown terminal state.

Public screen observers share one daemon-owned, lazily allocated, bounded visible-screen projection
cache keyed by Session, Pane, and observation generation. The first observer for a generation
formats canonical terminal state; later observers append their own sequence-bearing Event envelope
from the immutable cached bytes. A control capture invalidates the cache before borrowing its
writable scratch. Slow observers retain only their own bounded output offset and cannot prevent
other observers or PTYs from progressing. Create-only working-directory storage and protocol fields
larger than 64 bytes are separate lifecycle-funded allocations, so persistent observers do not
retain general connection-setup capacity.

ANSI projection bulk-reads each borrowed raw Ghostty row. Direct packed-cell decoding remains
private to the terminal adapter and is enabled only after the linked `ghostty_type_json()` descriptor
and representative typed accessors agree on the pinned layout; construction fails closed otherwise.
Styles and complete graphemes still use typed accessors when their packed tags require them. Each
row initializes one bounded grapheme scratch buffer and reuses only the exact prefix reported by the
typed getter or direct encoder; cells do not repeatedly clear hard-limit storage. Physical hashes
describe emitted cells. Separate scroll hashes include raw cells, resolved styles, complete
graphemes, selection, palette/default colors, and theme projection. Partial damage invalidates
scroll equivalence until a complete-damage frame refreshes it. Hardware scrolling is permitted only
when one Pane owns the outer origin and full width, so status and neighboring content cannot move.
Likewise, a composed Pane may encode trailing blanks with `CSI K` only when its surface reaches the
outer content viewport's physical right edge; a left Pane must emit bounded cells rather than erase a
neighbor. Standalone rendering continues to own its complete line. Consecutive changed rows may use
ordered relative row movement, but resynchronization and the first changed row retain absolute
positioning.

Autonomous output enters the bounded burst lane: the first frame waits 3 ms, a continuing short
burst waits 6 ms per frame, and output sustained past 50 ms uses 16 ms display cadence. Deadlines are
never postponed after arming. State changes and input-correlated damage bypass these delays, and a
blocked sink retains one bounded complete-repair request rather than creating timer work.

Resize is coordinated in one direction:

```text
Attachment geometry -> Core layout -> Pane geometry -> PTY size -> Ghostty size
```

The child PTY receives the target dimensions before Ghostty parses output at those dimensions.
Multi-pane resize publishes semantic geometry only after the dependent runtime work succeeds.

## Invariants

1. The daemon is the sole authority for mux state and Pane terminal truth.
2. `Session -> Tab -> Pane` is the only kernel hierarchy.
3. Semantic objects and runtime resources have distinct identities and lifetimes.
4. Every mutable fact has one owner; other representations are derived.
5. Every semantic mutation uses a typed command and typed result.
6. Ghostty representations remain private to `lemma_terminal`.
7. Required PTY-response, application-input, and presentation ordering is explicit.
8. Queues, payloads, loops, timeouts, and retained presentation work are bounded.
9. Slow or malformed clients and observers cannot prevent unrelated PTY progress.
10. Visible state is reconstructible without retaining an unbounded event, frame, or PTY-byte log.
11. Session lifecycle transitions preserve the complete semantic and Core/Runtime ownership
    invariants after every atomic operation; rejected effects do not publish partial Core state.
