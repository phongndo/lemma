# tools.write

The `write` tool: creates or overwrites a file, creating its parent
directories. Adds it to `Tools`. No config. Paths resolve as `read`'s do. Its
web half (`./web`) shows a call as the file written.

Writes and edits to one file run one at a time in-process, by real path
(`withFileLock` in `@lemma/tools/files`). A write replaces the file whole or
not at all (`replaceFile`): a crash or a full disk leaves the old file, not a
truncated one. It keeps an existing file's mode, and through a symlink it
writes the target. A file another user owns, or in a directory the user
cannot add to, is written in place instead.
