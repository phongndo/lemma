# Platform

Narrow wrappers for operating-system mechanisms: owned descriptors, PTYs, child processes,
foreground process-group inspection, Unix sockets, polling, signals, clocks, raw terminal mode, and
concrete native-presentation mechanisms when implemented. The 1.0 remote baseline invokes the normal
client or CLI on the remote host over ordinary SSH; custom SSH-stdio subprocess plumbing is deferred
beyond 1.0.

Platform code performs mechanisms and reports explicit results. It does not decide mux policy,
mutate core topology, parse protocol messages, or render frames. Abstract only operations Lemma
actually uses; do not build a speculative portability framework.
