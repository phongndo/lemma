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

A `PaneRuntime` owns one concrete `vt::Terminal`. The terminal component owns every Ghostty handle and any adapter storage needed to use it. Core addresses the pane by Lemma ID and expresses policy without receiving a Ghostty value.

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

Ghostty remains canonical. The first theme-bearing attachment establishes stable child-facing session defaults; later attachments do not mutate that canonical theme. ANSI projection preserves inherited default and palette-indexed colors so each attaching terminal performs the final palette lookup. Explicit RGB and distinguishable pane-local OSC color overrides remain explicit RGB; pane overrides are never forwarded as global outer-terminal palette mutations.

The pinned Ghostty C API exposes effective and default colors but not override presence. An application override whose RGB value exactly equals the configured default is therefore indistinguishable and remains semantically indexed/default during projection. Exact handling of that edge requires Ghostty to expose its existing default and palette override provenance through the C API.

OSC 8 hyperlink projection has a similar narrow upstream boundary: the render row/cell API does not expose stable hyperlink identity or URI as part of the acquired render state. Point-based grid-reference lookup is not a transactional per-cell render contract and would add multiplicative lookup work. Lemma therefore does not fabricate hyperlink projection; end-to-end ANSI hyperlink preservation awaits render-state hyperlink metadata from Ghostty.

Lemma-owned presentation snapshots, deltas, hashes, or retained physical shadows are acceptable only when they are:

1. non-authoritative;
2. bounded;
3. invalidatable and reconstructible;
4. justified by rendering or concurrency needs; and
5. not a second implementation of terminal semantics.

Prefer projecting from Ghostty into bounded caller-owned presentation storage. Ask for a scalar when only a scalar is needed; do not obtain or copy an aggregate terminal snapshot by default.

PTY bytes are parsed exactly once. Raw PTY bytes are not retained merely in case a client may want to replay them.

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
4. Terminal responses move to the PaneRuntime's ordered PTY write queue before later accepted application input can overtake them.
5. Lemma applies policy to effects such as title, bell, clipboard, notification, or unsupported graphics.
6. Ghostty damage informs presentation scheduling. Rendering observes canonical state but does not become authority.

Dropping a terminal response silently is a terminal-integrity failure, not normal backpressure. Effects with product or security consequences remain typed and policy-controlled rather than being forwarded globally to the outer terminal.

## Input flow

```text
physical input
      |
      v
Lemma interpretation
   /          \
mux command   application input
   |                |
 Core         Ghostty encoder
                    |
                    v
                PTY queue
```

The client or platform decoder preserves key, text, paste, focus, and mouse boundaries where the host exposes them. Core interprets bindings and mux policy. A mux action becomes the same typed command used by CLI, Lua, and agents. Application input is routed to a stable Pane ID, then Runtime asks that pane's Ghostty terminal to encode it from canonical terminal modes.

Paste remains an opaque bounded event and cannot accidentally become prefix commands. Mouse coordinates are validated against attachment geometry, hit-tested against Lemma layout, translated to pane-local coordinates, and then encoded by Ghostty when the application owns the event. Do not fabricate key metadata unavailable from the physical host.

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

Core owns the semantic layout and computes pane geometry. Runtime prepares dependent presentation storage and coordinates the external resize. PTY and Ghostty dimensions must not remain inconsistent: reject before mutation where possible, otherwise roll back or fail closed if consistency cannot be restored.

A resize does not make attachment geometry, pane geometry, PTY dimensions, and terminal dimensions the same owned value. Each has one owner and a defined synchronization transition.

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

Copy mode never pauses PTY parsing. A fixed viewport is attachment policy while Ghostty history continues to evolve. Search must traverse canonical terminal data in bounded slices and must not retain a duplicate text grid or unbounded match list.

Ghostty tracked references must remain encapsulated. Core may retain Lemma-owned continuation values, but never Ghostty pointers or private structs.

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

At that pin, the C API could not transactionally export both terminal state and persistent parser/decoder continuation, so the temporary prototype was removed. The current pin now exposes bounded snapshot encode/decode with parser continuation and progressive history, but snapshot format version 1 is explicitly a work in progress without a binary-compatibility guarantee. Lemma does not need client terminal replicas for its daemon-rendered architecture, so PTY replay and reconstructive client checkpoints remain intentionally absent rather than assumed.

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
