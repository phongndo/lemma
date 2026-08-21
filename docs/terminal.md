# Terminal boundary

Ghostty owns terminal semantics. Lemma owns mux and product semantics.

`lemma::vt::Terminal` is the concrete boundary to the pinned `libghostty-vt`. Keep it narrow; it is not a generic backend framework.

## Ownership

Ghostty owns terminal semantics, including:

- VT parsing and parser continuation;
- canonical primary and alternate screens;
- scrollback/history and reflow;
- grapheme, combining-character, and cell-width semantics;
- terminal modes;
- effective styles, colors, and palette overrides;
- cursor semantics;
- terminal-generated responses;
- terminal input, keyboard, paste, and mouse encoding where its API provides them;
- tracked terminal references and terminal selection primitives; and
- terminal formatting primitives where appropriate.

Lemma owns product and mux semantics, including:

- PTY and process lifetime;
- sessions, tabs, panes, and attachments;
- layout, focus, zoom, and mux commands;
- copy-mode UX and policy;
- permissions and security policy;
- routing physical input between mux actions and application input;
- presentation scheduling, backpressure, and composition;
- client and extension lifecycle; and
- agent and automation semantics.

A `PaneRuntime` owns one concrete `vt::Terminal`. The terminal component owns every Ghostty handle and any adapter storage needed to use it. Core addresses the pane by Lemma ID and expresses policy without receiving a Ghostty value. Under explicit hold-on-exit policy, Runtime closes the exited PTY but retains that same canonical terminal for capture and presentation; it does not create a second screen or transfer terminal authority to the procedure frontend.

## Representation boundary

The public side of `terminal/` exposes only Lemma-owned value types, operations, errors, and borrowed views with explicit lifetimes. These must not escape the terminal component:

- Ghostty headers, handles, or pointers;
- allocator identities;
- private layouts;
- Ghostty enum ordinals where they are implementation-specific; and
- borrowed Ghostty storage without a Lemma lifetime contract.

Do not introduce `ITerminal`, `TerminalBackend`, `TerminalBackendFactory`, `GhosttyBackend`, `GhosttyAdapter`, or similar runtime polymorphism without a demonstrated second requirement. The preferred boundary is the concrete:

```text
vt::Terminal -> libghostty-vt
```

Ghostty is statically linked only into the `lemma_terminal` target. Its exact source and build configuration are pinned in `third_party/ghostty-metadata/PIN.json`.

## One terminal authority

Do not casually build this:

```text
Ghostty canonical grid
        ->
Lemma canonical grid
        ->
renderer
```

Ghostty remains canonical. The first theme-bearing attachment establishes stable child-facing session defaults; later attachments do not mutate that canonical theme. ANSI projection preserves inherited defaults and palette indices 0-15 only where the attachment's host-theme query established an equivalent outer entry. Extended indices 16-255, explicit RGB, and distinguishable pane-local OSC color overrides project as explicit RGB because the corresponding outer entries are not queried. Pane overrides are never forwarded as global outer-terminal palette mutations.

The pinned Ghostty C API exposes effective and default colors but not override presence. An application override whose RGB value exactly equals the configured default is therefore indistinguishable and remains semantically indexed/default during projection. Exact handling of that edge requires Ghostty to expose its existing default and palette override provenance through the C API.

The adapter's grapheme bound is part of dependency qualification: the pinned Ghostty stores one base codepoint plus at most 64 suffix codepoints, requiring at most 260 UTF-8 bytes. Lemma reserves that complete bound for render and search traversal and treats overflow as a dependency-contract failure rather than silently substituting a replacement character.

OSC 8 hyperlink projection has a similar narrow upstream boundary: the render row/cell API does not expose stable hyperlink identity or URI as part of the acquired render state. Point-based grid-reference lookup is not a transactional per-cell render contract and would add multiplicative lookup work. Lemma therefore does not fabricate hyperlink projection; end-to-end ANSI hyperlink preservation awaits render-state hyperlink metadata from Ghostty.

Lemma-owned presentation snapshots, deltas, hashes, or retained physical shadows are acceptable only when they are:

1. non-authoritative;
2. bounded;
3. invalidatable and reconstructible;
4. justified by rendering or concurrency needs; and
5. not a second implementation of terminal semantics.

Prefer projecting from Ghostty into bounded caller-owned presentation storage. Ask for a scalar when only a scalar is needed; do not obtain or copy an aggregate terminal snapshot by default.

When Lemma's compositor overrides child-owned non-mouse modes or cursor shape after pane rendering, it invalidates only the affected retained projection metadata. A later incremental frame restores the focused child's canonical state without discarding cell hashes or forcing unrelated repaint.

PTY bytes are parsed exactly once. Raw PTY bytes are not retained merely in case a client may want to replay them.

Public terminal introspection remains two narrow projections. `pane.inspect` returns scalar metadata
(size, active screen, viewport/history extent, cursor, child-reported title/PWD provenance, prompt
state, input availability, integrity, and terminal generation) without terminal text. `pane.capture`
returns one bounded visible, recent, or OSC-133 command-output projection in plain or ANSI form with
explicit wrapping, generation, and truncation. `pane.wait` Actions and screen Events reuse that same capture value;
they do not own another formatter or text grid.

Recent capture formats a caller-selected tail from Ghostty's canonical active screen and scrollback
without moving the viewport or installing a selection. Last-command capture asks Ghostty's semantic
selection primitive for an OSC-133-delimited output range. Lemma does not synthesize mouse wheel
input to scrape an alternate-screen application's private transcript: such a read would mutate the
application, race with a controller, and require application-specific idle/detection policy.

## PTY output flow

```text
PTY
 |
 v
Ghostty parse
 |       \
 |        -> terminal responses -> ordered PTY write queue
 |
 +-> effects -> Lemma policy
 |
 +-> damage -> presentation scheduling -> composition -> client
```

Order and ownership:

1. Runtime reads a bounded PTY chunk.
2. The pane's `vt::Terminal` parses it once.
3. Ghostty callbacks copy terminal responses and effects into bounded terminal-owned queues or counters; callbacks do not block.
4. Terminal responses move to the PaneRuntime's ordered PTY write queue before later accepted application input can overtake them. Resize-generated replies such as mode-2048 in-band size reports use the same queue; they are not left in the adapter until the next PTY read or keystroke.
5. Lemma applies policy to effects such as title, bell, clipboard, notification, or unsupported graphics.
6. Ghostty damage informs presentation scheduling. Rendering observes canonical state but does not become authority.

Dropping a terminal response silently is a terminal-integrity failure, not normal backpressure. Effects with product or security consequences remain typed and policy-controlled rather than being forwarded globally to the outer terminal.

## Input flow

```text
physical input
      |
      v
daemon input policy
   /          \
mux command   application input
   |                |
 Core         Ghostty encoder
                    |
                    v
                PTY queue
```

The client or platform decoder preserves key, text, paste, focus, and mouse boundaries where the host exposes them. A daemon-owned input-policy component interprets a compiled keymap and bounded per-Attachment context stack. A mux action becomes the same typed command used by CLI, Lua, and agents; physical keys, prefixes, and named input contexts never enter mux Core. Application input is routed to a stable Pane ID, then Runtime asks that pane's Ghostty terminal to encode it from canonical terminal modes.

Paste remains an opaque bounded event and bypasses keymap interpretation. Routing advances one decoder-held input cursor monotonically, so a context transition or command cannot be replayed when PTY backpressure retains later application input. Each Attachment advances at most 16 routing steps per reactor turn, separately from decoder storage and message capacity; one ordinary unbound byte run is one step. Mouse coordinates are validated against attachment geometry and hit-tested against Lemma layout. Pane events are translated to pane-local coordinates and encoded by Ghostty when the application owns them. A left-dragged separator sends each distinct cell position through the typed command path against one generation-safe structural divider, atomically committing the real layout, pane geometry, child PTY geometry, and Ghostty surfaces. Do not fabricate key metadata unavailable from the physical host.

## Resize flow

```text
attachment geometry
        ->
layout
        ->
pane geometry
        ->
runtime coordinates PTY + Ghostty resize
```

Core owns the semantic layout and computes pane geometry. Runtime prepares dependent presentation storage and coordinates every external resize, including live mouse-divider motion, in one rollback-capable transaction. `PaneLayout` remains the sole owner of the current divider coordinate; mouse capture retains only generation-safe gesture identity.

The transaction reports the target dimensions with `TIOCSWINSZ` before resizing Ghostty. On success the kernel updates the PTY window size and notifies its foreground process group with `SIGWINCH`. Lemma's single-owner reactor does not read or parse PTY output inside the transaction, so output produced immediately after that notification remains buffered until Ghostty has the same geometry. If Ghostty rejects the resize, Runtime restores the previous PTY dimensions; rollback failure is a fail-closed consistency loss. A multi-pane failure rolls already-committed panes back before PTY parsing resumes. `PaneLayout` and pane rectangles publish only after every affected runtime succeeds.

This enforces the directional terminal invariant: Ghostty never parses child output at dimensions that have not already been reported to that child PTY. Live divider motion has no geometry exception, timer, checkpoint, or deferred endpoint. Each distinct decoded cell position performs bounded fixed-plan work and may produce `SIGWINCH`; duplicate positions are no-ops.

Daemon client decoding has a separate CPU bound from decoder storage: each session may apply at most 16 complete client messages and one geometry-bearing message per reactor turn. Retained valid work resumes on the next turn without requiring new socket readiness, so a motion flood cannot make one client monopolize PTY progress.

The attached client treats repeated outer `SIGWINCH` samples as one physical gesture. It retains only the latest dimensions and sends the settled endpoint after 50 ms without another sample, or immediately before later user input so input cannot overtake geometry. The client does not forward every window-manager sample as a child PTY resize.

A resize does not make attachment geometry, pane geometry, PTY dimensions, and terminal dimensions the same owned value. Each has one owner and a defined synchronization transition.

## Viewport input policy

Ghostty owns each pane's canonical viewport. Lemma hit-tests normalized SGR wheel reports and routes them from canonical terminal modes: explicit application mouse reporting reaches Ghostty's mouse encoder, alternate-screen alternate-scroll becomes one Ghostty-encoded cursor key per vertical report, and primary-screen host scrolling moves the Ghostty viewport by one row per vertical report. Horizontal trackpad reports remain distinct and never move the vertical history viewport. Ordinary host scrolling does not enter copy mode or create a selection.

New PTY output continues to parse and leaves a historical viewport held. Once application key or paste bytes have been accepted into the pane's bounded PTY queue, Lemma returns that pane to Ghostty's active viewport before presentation. Focus and mouse reports do not independently reset the viewport. The SGR transport carries normalized cell reports rather than source-device pixel deltas, so Lemma must not apply a second wheel multiplier.

## Copy, selection, and search

The boundary is deliberately split:

| Concern | Owner |
| --- | --- |
| Enter/leave copy mode, bindings, active pane, viewport policy, authorization, feedback | Lemma Attachment/Core policy |
| Canonical history, reflow, graphemes, wrapped lines | Ghostty |
| Selection units, tracked endpoints, endpoint motion, terminal formatting | Ghostty through `vt::Terminal` |
| Bounded search scheduling and query UX | Lemma |
| Cell/history traversal and tracked terminal references used by search | Terminal component |
| Highlight, copy cursor, status, overlays | Presentation |
| Clipboard provider and application clipboard permission | Lemma policy/runtime |

Copy mode never pauses PTY parsing. Its explicit fixed-viewport policy retains a bounded absolute offset across output and reflow while Ghostty history remains canonical and continues to evolve. Ordinary wheel scrolling does not use this copy-mode policy. Search must traverse canonical terminal data in bounded slices and must not retain a duplicate text grid or unbounded match list.

Ghostty tracked references must remain encapsulated. Core may retain Lemma-owned continuation values, but never Ghostty pointers or private structs. The terminal adapter may retain one bounded tracked selection checkpoint while copy search previews another range. Runtime controls that checkpoint's lifecycle and may request its current endpoint to seed bounded traversal, but restoration never round-trips through screen coordinates.

## Effects and unsupported semantics

Child-visible capabilities must be truthful. A feature is either supported end to end, explicitly permission-gated, or deliberately unadvertised/unsupported. Parsing a protocol-defined no-op is acceptable; advertising support and silently losing semantics is not.

In particular:

- application clipboard writes require explicit policy distinct from a user-initiated copy action;
- child titles and other text effects are bounded and sanitized before presentation;
- PWD/progress changes invalidate bounded status metadata, desktop notifications use visible-attention policy, and unsupported sequences are captured only to a fixed limit before being dropped;
- graphics remain disabled unless canonical storage, policy, projection, transport, and resource bounds are all qualified; and
- pane color or mode effects are never blindly forwarded as global outer-terminal state.

## Rejected terminal replicas

A 2026 feasibility investigation tested checkpoint-plus-tail client replicas against Ghostty commit `55a3e33ab26a23d75b274b23c7f76d837db00578`. It produced deterministic divergence for:

- an incomplete CSI sequence;
- an incomplete UTF-8 sequence;
- inactive primary-screen state while the alternate screen was active; and
- progressive history, for which no stable bounded range hydration API existed.

At that pin, the C API could not transactionally export both terminal state and persistent parser/decoder continuation, so the temporary prototype was removed. The current pin exposes bounded snapshot encode/decode with parser continuation, progressive history, and an optional decoder flag that retains continuation tracking on the restored terminal. Snapshot format version 1 is explicitly a work in progress without a binary-compatibility guarantee. Lemma does not need client terminal replicas for its daemon-rendered architecture, so PTY replay and reconstructive client checkpoints remain intentionally absent rather than assumed.

Retrying that design requires a new decision, a stable upstream format, measured benefit over daemon rendering, transactional failure behavior, and explicit replica side-effect suppression. Private-memory snapshots, allocator identities, or implementation layouts are never acceptable wire contracts.

## Terminal change review

For terminal work, verify:

1. Does Ghostty already own this semantic?
2. Is the operation expressed as a narrow Lemma-owned value or caller-owned buffer?
3. Does any foreign representation escape?
4. Are bytes parsed or state queried more than necessary?
5. Are responses, effects, damage, and accepted input ordered correctly?
6. Are all buffers, callbacks, traversal, and failure paths bounded?
7. Are adapter, convergence, runtime, and performance tests required by [`quality.md`](quality.md) present?
