# Client

Home of Lemma's thin attached client and control clients.

The attached client owns the daemon connection, protocol handshake/decoder, physical keyboard,
paste, focus, resize, and mouse decoding, bounded outer-terminal writes, raw-terminal lifetime, and
exact restoration. It can disappear without affecting daemon-owned processes, PTYs, topology,
terminal state, scrollback, copy state, or presentation authority.

The client owns no terminal emulator, mux topology, layout hit testing, command authority, or
application-input modes. It sends bounded typed physical input and command requests. The daemon
resolves stable targets, applies keymaps/prefix policy, hit-tests its current presentation, encodes
application input, and sends complete bounded ANSI render frames.

A future native client may consume replaceable presentation snapshots/deltas, but it does not replay
PTY input or become terminal authority. Native presentation is not a 1.0 requirement.
