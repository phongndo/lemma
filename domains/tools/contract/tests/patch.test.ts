import { describe, expect, it } from "vitest";
import { deriveNewContents, parsePatch, patchPaths, seekSequence } from "../src/patch.ts";
import type { PatchHunk } from "../src/patch.ts";

// Ported from Codex's own tests at 89461ea (codex-rs/apply-patch/src: parser.rs, streaming_parser.rs,
// seek_sequence.rs, file_update_tests.rs), so the port is held to what Codex does.

const failure = (patch: string) => {
  try {
    parsePatch(patch);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("parsed");
};
const chunk = (fields: Partial<Extract<PatchHunk, { kind: "update" }>["chunks"][number]>) => ({
  oldLines: [],
  newLines: [],
  contextLineIndices: [],
  isEndOfFile: false,
  ...fields,
});

describe("parsePatch", () => {
  it("checks the patch's first and last lines, trimmed", () => {
    expect(failure("bad")).toBe("invalid patch: The first line of the patch must be '*** Begin Patch'");
    expect(failure("*** Begin Patch\nbad")).toBe("invalid patch: The last line of the patch must be '*** End Patch'");
    expect(parsePatch("*** Begin Patch \n*** Add File: foo\n+hi\n *** End Patch")).toEqual([{ kind: "add", path: "foo", contents: "hi\n" }]);
    expect(parsePatch("*** Begin Patch\n*** End Patch")).toEqual([]);
  });

  it("reads adds, deletes, updates, and moves", () => {
    expect(
      parsePatch(
        [
          "*** Begin Patch",
          "*** Add File: path/add.py",
          "+abc",
          "+def",
          "*** Delete File: path/delete.py",
          "*** Update File: path/update.py",
          "*** Move to: path/update2.py",
          "@@ def f():",
          "-    pass",
          "+    return 123",
          "*** End Patch",
        ].join("\n"),
      ),
    ).toEqual([
      { kind: "add", path: "path/add.py", contents: "abc\ndef\n" },
      { kind: "delete", path: "path/delete.py" },
      {
        kind: "update",
        path: "path/update.py",
        movePath: "path/update2.py",
        chunks: [chunk({ changeContext: "def f():", oldLines: ["    pass"], newLines: ["    return 123"] })],
      },
    ]);
    expect(parsePatch("*** Begin Patch\n*** Update File: file.py\n@@\n+line\n*** Add File: other.py\n+content\n*** End Patch")).toEqual([
      { kind: "update", path: "file.py", chunks: [chunk({ newLines: ["line"] })] },
      { kind: "add", path: "other.py", contents: "content\n" },
    ]);
  });

  it("takes a first chunk without its @@, and records which lines are context", () => {
    expect(parsePatch("*** Begin Patch\n*** Update File: file2.py\n import foo\n+bar\n*** End Patch")).toEqual([
      { kind: "update", path: "file2.py", chunks: [chunk({ oldLines: ["import foo"], newLines: ["import foo", "bar"], contextLineIndices: [[0, 0]] })] },
    ]);
    // A bare empty line is an empty context line.
    expect(parsePatch("*** Begin Patch\n*** Update File: file.txt\n@@\n context before\n\n context after\n*** End Patch")).toEqual([
      {
        kind: "update",
        path: "file.txt",
        chunks: [
          chunk({
            oldLines: ["context before", "", "context after"],
            newLines: ["context before", "", "context after"],
            contextLineIndices: [
              [0, 0],
              [1, 1],
              [2, 2],
            ],
          }),
        ],
      },
    ]);
  });

  it("keeps the end-of-file marker, and ignores empty lines after it", () => {
    expect(parsePatch("*** Begin Patch\n*** Update File: file.txt\n@@\n+quux\n*** End of File\n\n*** End Patch")).toEqual([
      { kind: "update", path: "file.txt", chunks: [chunk({ newLines: ["quux"], isEndOfFile: true })] },
    ]);
  });

  it("says where an update is empty, and where a line is not one", () => {
    expect(failure("*** Begin Patch\n*** Update File: test.py\n*** End Patch")).toBe("invalid hunk at line 2, Update file hunk for path 'test.py' is empty");
    expect(failure("*** Begin Patch\n*** Update File: a.py\n@@\n*** End Patch")).toBe("invalid hunk at line 4, Update hunk does not contain any lines");
    // An @@ right after another is not a line of its chunk.
    expect(failure("*** Begin Patch\n*** Update File: a.py\n@@ class B:\n@@ def f(self):\n-x\n*** End Patch")).toBe(
      "invalid hunk at line 4, Unexpected line found in update hunk: '@@ def f(self):'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)",
    );
    expect(failure("*** Begin Patch\n*** Frobnicate File: a.py\n*** End Patch")).toBe(
      "invalid hunk at line 2, '*** Frobnicate File: a.py' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'",
    );
  });

  it("takes a heredoc around the patch off, as GPT-4.1 sends it", () => {
    const body = "*** Begin Patch\n*** Update File: file2.py\n import foo\n+bar\n*** End Patch";
    const expected = parsePatch(body);
    for (const open of ["<<EOF", "<<'EOF'", '<<"EOF"']) expect(parsePatch(`${open}\n${body}\nEOF\n`)).toEqual(expected);
    expect(failure(`<<"EOF'\n${body}\nEOF\n`)).toBe("invalid patch: The first line of the patch must be '*** Begin Patch'");
    expect(failure("<<EOF\n*** Begin Patch\n*** Update File: file2.py\nEOF\n")).toBe("invalid patch: The last line of the patch must be '*** End Patch'");
  });

  it("reads an environment id before the files, once", () => {
    expect(parsePatch("*** Begin Patch\n*** Environment ID: remote\n*** Add File: hello.txt\n+hello\n*** End Patch")).toEqual([
      { kind: "add", path: "hello.txt", contents: "hello\n" },
    ]);
    expect(failure("*** Begin Patch\n*** Environment ID: a\n*** Environment ID: b\n*** End Patch")).toBe(
      "invalid patch: apply_patch environment_id cannot be specified more than once",
    );
  });
});

describe("seekSequence", () => {
  it("matches exactly, then ignoring trailing whitespace, then leading and trailing, then Unicode punctuation", () => {
    expect(seekSequence(["foo", "bar", "baz"], ["bar", "baz"], 0, false)).toBe(1);
    expect(seekSequence(["foo   ", "bar\t\t"], ["foo", "bar"], 0, false)).toBe(0);
    expect(seekSequence(["    foo   ", "   bar\t"], ["foo", "bar"], 0, false)).toBe(0);
    expect(seekSequence(["print(“hi”) — ok"], ['print("hi") - ok'], 0, false)).toBe(0);
  });

  it("takes the first match at or after its start, from the end with eof, and nothing that cannot fit", () => {
    expect(seekSequence(["x", "y", "x"], ["x"], 0, false)).toBe(0);
    expect(seekSequence(["x", "y", "x"], ["x"], 1, false)).toBe(2);
    expect(seekSequence(["x", "y", "x"], ["x"], 0, true)).toBe(2);
    expect(seekSequence(["just one line"], ["too", "many", "lines"], 0, false)).toBeUndefined();
    expect(seekSequence(["a"], [], 1, false)).toBe(1);
  });
});

describe("deriveNewContents", () => {
  const update = (patch: string) => (parsePatch(patch)[0] as Extract<PatchHunk, { kind: "update" }>).chunks;

  it("applies interleaved chunks, and lines added at the end", () => {
    const chunks = update("*** Begin Patch\n*** Update File: f\n@@\n a\n-b\n+B\n@@\n d\n-e\n+E\n@@\n f\n+g\n*** End of File\n*** End Patch");
    expect(deriveNewContents("a\nb\nc\nd\ne\nf\n", chunks, "f")).toBe("a\nB\nc\nd\nE\nf\ng\n");
  });

  it("keeps each line's ending, gives new lines the file's first, and ends every line", () => {
    expect(deriveNewContents("one\r\ntwo\r\nthree", update("*** Begin Patch\n*** Update File: f\n one\n-two\n+2\n+2.5\n*** End Patch"), "f")).toBe(
      "one\r\n2\r\n2.5\r\nthree\r\n",
    );
    expect(deriveNewContents("a\nb", update("*** Begin Patch\n*** Update File: f\n a\n-b\n+c\n*** End Patch"), "f")).toBe("a\nc\n");
  });

  it("puts lines only added at the end, whatever their @@ says, and lets an empty last line stand for the final break", () => {
    expect(deriveNewContents("a\nb\nc\n", update("*** Begin Patch\n*** Update File: f\n@@ a\n+after a\n*** End Patch"), "f")).toBe("a\nb\nc\nafter a\n");
    expect(deriveNewContents("a\nb\n", update("*** Begin Patch\n*** Update File: f\n a\n-b\n\n*** End Patch"), "f")).toBe("a\n");
  });

  it("says what it could not find, as Codex does", () => {
    const missingContext = () => deriveNewContents("a\n", update("*** Begin Patch\n*** Update File: f\n@@ class Z:\n-a\n*** End Patch"), "/w/f");
    expect(missingContext).toThrow("Failed to find context 'class Z:' in /w/f");
    const missingLines = () => deriveNewContents("a\n", update("*** Begin Patch\n*** Update File: f\n x\n-y\n*** End Patch"), "/w/f");
    expect(missingLines).toThrow("Failed to find expected lines in /w/f:\nx\ny");
  });
});

describe("patchPaths", () => {
  const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");

  it("lists each path a patch names once, moves too, as Codex reads them", () => {
    expect(
      patchPaths(
        patch(
          "*** Add File: a.txt",
          "+x",
          "*** Update File: ~/b.txt",
          "*** Move to: /tmp/c.txt",
          "@@",
          "-y",
          "*** Delete File: a.txt",
          "*** Delete File: @d.txt",
          "*** Delete File:  spaced.txt",
        ),
      ),
    ).toEqual(["a.txt", "~/b.txt", "/tmp/c.txt", "@d.txt", " spaced.txt"]);
  });

  it("names at least the files the patch changes, whether or not it parses", () => {
    expect(patchPaths("<<'EOF'\n*** Begin Patch\n  *** Update File: e.txt \r\n-x\n")).toEqual(["e.txt"]);
    // An indented header is an update's context line, which the tool does not take for a file: named anyway.
    expect(patchPaths(patch("*** Update File: a.txt", " *** Delete File: b.txt", "+x"))).toEqual(["a.txt", "b.txt"]);
    expect(patchPaths(patch("*** Add File: a.txt", "+*** Delete File: b.txt"))).toEqual(["a.txt"]);
  });
});
