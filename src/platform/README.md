# Platform

Narrow wrappers for operating-system mechanisms: owned descriptors, PTYs, child processes,
foreground process-group inspection, Unix sockets, SSH-stdio subprocess plumbing, polling, signals,
clocks, raw terminal mode, and concrete native-presentation mechanisms when implemented.

Platform code performs mechanisms and reports explicit results. It does not decide mux policy,
mutate core topology, parse protocol messages, or render frames. Abstract only operations Fiber
actually uses; do not build a speculative portability framework.
