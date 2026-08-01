# Extension host

Lemma configuration and extensions run as trusted Lua 5.5 code in one persistent child process per
daemon. The daemon starts and supervises the host; a host crash or blocked callback cannot stop pane
processes, PTY parsing, input, checkpoint/event synchronization, or client presentation.

The host loads `$XDG_CONFIG_HOME/lemma/init.lua`, falling back to `~/.config/lemma/init.lua`. A
missing file is a valid empty generation. Lua has its normal user-level standard libraries and may
load modules, use the filesystem and network, and start its own processes. Project-local Lua is not
automatically trusted or loaded.

Communication uses the bounded extension framing in `src/protocol/extension.*`. A successful load
sends one transactional generation containing command, keymap, subscription, and UI registrations.
The core activates only a complete commit. Invalid or failed candidates do not partially mutate the
active generation. The reactor drains extension IPC after PTYs, client input, and due client
synchronization work.

The current vertical slice establishes process isolation, full-Lua loading, bounded registration,
atomic activation, disconnect cleanup, and restart backoff. Configuration failures are retained in
control listings and reported to the daemon's system log. Command callback invocation, state
snapshots, event delivery, client-rendered declarative sidebars, process/timer APIs, output
subscriptions, and transactional replacement-host reload remain follow-up slices.

Extensions receive stable IDs and immutable values, never C++ pointers or daemon-owned descriptors.
They request typed core commands instead of mutating topology directly. A native C++ plugin ABI is
not planned.
