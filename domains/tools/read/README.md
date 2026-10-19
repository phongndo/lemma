# tools.read

The `read` tool: a file's text, a page at a time, or an image. Adds it to `Tools`.
No config. Its behavior, description, and limits follow pi's. Its web half
(`./web`) shows a call as the file and the lines read.

| Input                                 | Behavior                                                                                                                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`, `offset?` (1-based), `limit?` | Raw text, cut at 2000 lines or 50KB with a `Use offset=N to continue` notice. PNG/JPEG/GIF/WebP (by magic bytes) come back as an image part; images over 3.75MB are described instead. |

A codemode script's call resolves to the text, or to an image as a block
(`{ type: "image", data, mimeType, note }`, `ReadOutput`) that the script shows
with `image()` or hands to a classifier.

Paths resolve against the session cwd; `~` expands and a leading `@` is dropped
(`resolveToCwd` in `@lemma/tools/files`, which a guard uses to judge the file a
call will touch).

## Rationale

- **It repeats and runs alongside others.** It is `replay: "safe"` and
  `parallel: "safe"`: reads the model asks for together run together, and a
  read a host restart cut off runs again. The other bundled tools are neither,
  since running them twice could do harm (pi's tools repeat none).
- **No image resizing** (pi resizes with a native dependency). The size cap keeps
  an oversized image from entering the history, where it would fail every later
  request.
