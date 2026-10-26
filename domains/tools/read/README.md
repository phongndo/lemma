# tools.read

The `read` tool: a file's text, a page at a time, or an image. Adds it to `Tools`.
No config. Its behavior, description, and limits follow pi's. Its web half
(`./web`) shows a call as the file and the lines read.

| Input                                 | Behavior                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`, `offset?` (1-based), `limit?` | Raw text, a page of 2000 lines (or `limit`), fewer past the result's budget (`tools.registry`'s `maxResultChars`), with a marker saying what was left out and `Use offset=N to continue` (`keepHead`). A first line longer than the budget shows its start, and how to read on in it with bash. PNG/JPEG/GIF/WebP (by magic bytes) come back as an image part; images over 3.75MB are described instead. |

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
- **A page at a time.** pi reads the whole file into one string to cut a
  page from it; this reads it a megabyte at a time and keeps only the page,
  paging exactly as splitting the whole would: on a 40MB, million-line file
  the first page took 27ms and 18MB of memory instead of 181ms and 381MB
  (2026-10-21), and a file past V8's string limit (about 512MB) reads instead
  of failing. In a file up to 64MiB it reads on past the page to count every
  line (the `of N` note); in a larger one it stops at the page's end, and the
  note gives the file's size instead. A line is what `wc -l` counts, plus a
  last one without a newline. `details.truncation` holds the counts of a page
  cut to the budget, not a second copy of the text.
- **No image resizing** (pi resizes with a native dependency). The size cap keeps
  an oversized image from entering the history, where it would fail every later
  request.
