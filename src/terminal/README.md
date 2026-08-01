# Terminal adapter

Home of Lemma's only boundary to `libghostty-vt`.

The target adapter supports two explicit roles:

- **authoritative daemon terminal:** consumes ordered PTY output/resize/reset events, owns canonical
  screen and scrollback state, captures effects and PTY responses, encodes application input, and
  exports bounded versioned checkpoints; and
- **client replica terminal:** transactionally imports checkpoints and applies ordered pane events for
  presentation while suppressing PTY responses and authoritative side effects.

The interface exposes only Lemma-owned terminal sizes, effects, damage, cells, checkpoint values,
history ranges, versions, and bounded input/output values. Ghostty headers, private enum values,
allocator identities, pointers, and memory layouts never cross this component or appear directly on
the wire.

Checkpoint export/import must continue deterministically across arbitrary PTY chunk boundaries,
including incomplete parser/UTF-8 state. The pinned library does not yet expose the complete portable
API; `.plan/002-terminal-checkpoint-feasibility.md` is the mandatory gate before production protocol
work.

This component does not own PTYs, child processes, topology, client sockets, sequencing, lag policy,
or presentation scheduling. The current adapter implements only the authoritative role plus ANSI
rendering support; replica and checkpoint behavior remain target work.
