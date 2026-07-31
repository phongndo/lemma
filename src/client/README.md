# Client

Home of Fiber's smart attached client and control clients.

The target attached client owns the daemon connection, protocol handshake, bounded generational
replica store, terminal checkpoint import, ordered pane-event application, acknowledgements and
resynchronization, client-local viewport/search/selection state, input decoding, Fiber chrome hit
testing, and presentation coordination. It can disappear or discard every replica without affecting
daemon-owned processes, PTYs, topology, or canonical terminal state.

The first smart presentation backend runs inside an existing outer terminal. It therefore also owns
raw-terminal lifetime, prefix/input capture, outer resize observation, ANSI writes, and exact mode
restoration. A future native backend removes that outer-terminal layer while consuming the same
replicas and protocol.

The current implementation is transitional: it owns raw-terminal lifetime, local prefix handling,
resize forwarding, daemon connection lifetime, outer-terminal byte writes, and restoration, but no
pane terminal state. During the replication cutover, terminal ownership moves into this component
through `fiber_terminal`, and the tested ANSI compositor moves behind this client. The daemon's old
composed-ANSI attach path is then removed rather than retained as a second architecture.

The client never accesses core storage directly, generates PTY responses, treats physical rectangles
as authoritative IDs, or encodes application input from replica modes. It sends semantic commands or
stable pane IDs plus pane-local input to the authoritative daemon.
