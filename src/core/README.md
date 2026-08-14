# Core

Home of Lemma's authoritative mux engine and dense state.

The current engine owns up to 64 named sessions, 1,024 tabs, and 4,096 panes in one reactor.
Each session is bounded to 16 tabs and 64 panes. Every pane owns one child process, PTY,
canonical terminal adapter, resolved surface, and ordered bounded PTY write queue. Tabs own
generational IDs, binary split trees, focus, and zoom. Sessions own order/selection, a bounded immutable launch cwd/environment snapshot, attached-client
state, status, per-attachment view/prefix/copy/search state, retained presentation state, and frame
scheduling. Copy mode consumes vi/arrow UI input without forwarding it to the child, freezes its
viewport while PTY parsing continues, and presents a tracked cursor/range. Explicit copy formatting,
OSC 52 delivery, bounded search, and idle-compression slices remain part of the single-owner reactor.

The current core uses a fixed-capacity generational session store, hierarchical generational tab and
pane slots, generated attached-client IDs, and validated command targets. Pending attach
reservations retain stable IDs rather than cross-turn session pointers. Each session retains a
bounded deterministic command/result trace, and PTY reads use a rotating aggregate per-turn budget.
Attached-client descriptor progress is core-owned: one retained frame per client uses partial-write
and EAGAIN handling, 64 KiB per-client and 256 KiB global turn budgets, a persistent round-robin
cursor, and 5 s no-progress/30 s total-frame deadlines. Damage behind a blocked frame collapses into
one full recovery redraw. The target core still adds a
separate dense client store, actor/request origins, stored layout ratios, typed input, native
clipboard providers and broader policy, explicit render-redraw generations, immutable
snapshots/events, bounded output observations, and complete typed command results. A lagging
client retains only bounded frame work; canonical terminal damage represents newer state until one
full redraw can be sent or the client is disconnected.

The public `lemma/command.hpp` model is the single mutation path for keyboard, mouse, client, CLI,
Lua, remote, automation, and AI-agent operations. The core validates generational targets and
presentation hit tests; physical rectangles and local slots never become public identities.

The core may orchestrate platform, terminal, protocol, renderer, and extension interfaces. It does
not know CLI syntax, Lua stack details, Unix socket naming policy, outer-terminal encoding, or Ghostty
C types. Generalized task/run/view entities remain out of scope through 1.0.
