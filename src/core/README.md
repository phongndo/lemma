# Core

Home of Lemma's authoritative mux engine and dense state.

The current engine owns up to 64 named spaces, 1,024 windows, and 4,096 panes in one reactor.
Each space is bounded to 16 windows and 64 panes. Every pane owns one child process, PTY,
canonical terminal adapter, resolved surface, and ordered bounded PTY write queue. Windows own
generational IDs, binary split trees, focus, and zoom. Spaces own order/selection, attached-client
state, status, per-attachment view/prefix state, retained presentation state, and frame scheduling.

The target core adds dense generational space/pane/client stores, actor/request origins, stored
layout ratios, copy/search state, typed input, explicit render-redraw generations, immutable
snapshots/events, bounded output observations, and complete typed command results. A lagging
client retains only bounded frame work; canonical terminal damage represents newer state until one
full redraw can be sent or the client is disconnected.

The public `lemma/command.hpp` model is the single mutation path for keyboard, mouse, client, CLI,
Lua, remote, automation, and AI-agent operations. The core validates generational targets and
presentation hit tests; physical rectangles and local slots never become public identities.

The core may orchestrate platform, terminal, protocol, renderer, and extension interfaces. It does
not know CLI syntax, Lua stack details, Unix socket naming policy, outer-terminal encoding, or Ghostty
C types. Generalized task/run/view entities remain out of scope through 1.0.
