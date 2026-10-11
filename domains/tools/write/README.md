# tools.write

The `write` tool: creates or overwrites a file, creating its parent
directories. Requires `Tools`. No config. Paths resolve as `read`'s do.

Writes and edits to one file run one at a time in-process, by real path
(`withFileLock` in `@lemma/tools/files`).
