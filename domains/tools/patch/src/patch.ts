import { constants } from "node:fs";
import { access, readFile, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { Schema } from "effect";
import type { Tool } from "@lemma/tools";
import { unifiedPatch } from "@lemma/tools/diff";
import { fsMessage, realPath, replaceFile, resolveToCwd, text, throwIfAborted, withFileLocks } from "@lemma/tools/files";
import { deriveNewContents, parsePatch } from "@lemma/tools/patch";
import type { PatchHunk } from "@lemma/tools/patch";

/** Codex's parameter for the patch, so models trained on its `apply_patch` send what they know. */
export const PatchInput = Schema.Struct({
  input: Schema.String.annotate({ description: "The entire contents of the apply_patch command" }),
});
export type PatchInput = typeof PatchInput.Type;

/** One file a patch changed, in `PatchDetails.files`. */
export interface PatchedFile {
  /** What the patch did to it. An `add` of a file that was there replaced it whole. */
  readonly change: "add" | "update" | "move" | "delete";
  /** Where it was, absolute. */
  readonly path: string;
  /** For a move: where it is now, absolute. */
  readonly movedTo?: string;
  /** Unified diff of its text, for UIs; empty when its text did not change. */
  readonly patch: string;
  /** First changed line in the new file; none for a deleted one. */
  readonly firstChangedLine?: number;
}

export interface PatchDetails {
  /** In the patch's order. */
  readonly files: readonly PatchedFile[];
  /** The files' diffs one after another, for a UI that shows one diff (the chat shows `details.patch`). */
  readonly patch: string;
}

/** A change to one file, resolved against the disk and not yet written. */
interface Change {
  readonly change: PatchedFile["change"];
  readonly path: string;
  readonly display: string;
  readonly movedTo?: { readonly path: string; readonly display: string };
  /** Its text before and after, LF and without a BOM, for its diff. */
  readonly before: string;
  readonly after: string;
  /** An `add` of a file that was there. */
  readonly replaced: boolean;
}

/** What a path holds as the patch leaves it: the file written there (a move keeps its source's mode), or `null`, none. */
type Planned = { readonly raw: string; readonly mode?: number } | null;

interface Resolved {
  readonly changes: readonly Change[];
  /** What each path the patch touches ends as, in the order it first touches them. */
  readonly planned: ReadonlyMap<string, Planned>;
  /** The paths there were files at before the patch. */
  readonly onDisk: ReadonlySet<string>;
  /** Each path as the patch first names it. */
  readonly names: ReadonlyMap<string, string>;
}

/** What the model is told of a patch that cannot apply, as Codex tells it: nothing has been written yet. */
function failed(reason: string): never {
  throw new Error(`apply_patch verification failed: ${reason}`);
}

const missing = (cause: unknown): undefined => {
  if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
  throw cause;
};

const BOM = "\uFEFF";
const toLF = (text: string) => text.replace(/\r\n?/g, "\n");

/**
 * Every file of the patch, in order, against the disk: read, checked, and patched in memory as Codex verifies a patch
 * (`verify_apply_patch_args`), nothing written. Throws, for the model, at the first that cannot be. Beyond Codex, what
 * the writes need is checked too (a file to replace or remove is writable, its directory takes changes, and one to
 * create can be), so the patch applies whole or not at all; and a file is one file however it is named (a symlink
 * to it, or a Move's destination), so a patch that would change it twice, which Codex refuses for a path named twice,
 * is refused too rather than lose one of the changes.
 */
async function resolvePatch(hunks: readonly PatchHunk[], cwd: string): Promise<Resolved> {
  const changes: Change[] = [];
  const planned = new Map<string, Planned>();
  const onDisk = new Set<string>();
  const names = new Map<string, string>();

  /** What is at `absolute`, or undefined for nothing; `context` says, as Codex does, what failed. */
  const read = async (absolute: string, display: string, context: string, write: boolean): Promise<Exclude<Planned, null> | undefined> => {
    if (!names.has(absolute)) names.set(absolute, display);
    try {
      const info = await stat(absolute).catch(missing);
      if (info === undefined) return undefined;
      onDisk.add(absolute);
      if (info.isDirectory()) throw Object.assign(new Error(`EISDIR: ${absolute}`), { code: "EISDIR" });
      await access(absolute, write ? constants.R_OK | constants.W_OK : constants.R_OK);
      return { raw: (await readFile(absolute)).toString("utf8"), mode: info.mode & 0o7777 };
    } catch (cause) {
      return failed(`${context}: ${fsMessage(cause, display)}`);
    }
  };
  /** What is at `absolute`, which has to be there. */
  const existing = async (absolute: string, display: string, context: string, write: boolean) =>
    (await read(absolute, display, context, write)) ?? failed(`${context}: ${fsMessage(Object.assign(new Error("ENOENT"), { code: "ENOENT" }), display)}`);
  /** Checks that a file can be made at `absolute`, where none is: its nearest existing directory takes new entries. */
  const creatable = async (absolute: string, display: string, context: string) => {
    let at = dirname(absolute);
    let info = await stat(at).catch(missing);
    while (info === undefined && dirname(at) !== at) {
      at = dirname(at);
      info = await stat(at).catch(missing);
    }
    try {
      if (info !== undefined && !info.isDirectory()) throw Object.assign(new Error(`ENOTDIR: ${at}`), { code: "ENOTDIR" });
      await access(at, constants.W_OK | constants.X_OK);
    } catch (cause) {
      failed(`${context}: ${fsMessage(cause, display)}`);
    }
  };
  /** The files the patch has named so far, by real path: each one the patch may change once. */
  const named = new Set<string>();
  const once = async (absolute: string) => {
    const real = await realPath(absolute);
    if (named.has(real)) failed(`invalid patch: multiple operations target ${absolute}`);
    named.add(real);
  };
  /** Checks that the file at `absolute`, if it is on disk, can be removed: its directory takes changes. */
  const removable = async (absolute: string, display: string) => {
    if (!onDisk.has(absolute)) return;
    await access(dirname(absolute), constants.W_OK | constants.X_OK).catch((cause: unknown) =>
      failed(`Failed to remove ${absolute}: ${fsMessage(cause, display)}`),
    );
  };

  if (hunks.length === 0) throw new Error("No files were modified.");
  for (const hunk of hunks) {
    const absolute = resolveToCwd(hunk.path, cwd);
    await once(absolute);
    if (hunk.kind === "add") {
      const was = await read(absolute, hunk.path, `Failed to write file ${absolute}`, true);
      if (was === undefined) await creatable(absolute, hunk.path, `Failed to write file ${absolute}`);
      planned.set(absolute, { raw: hunk.contents });
      changes.push({
        change: "add",
        path: absolute,
        display: hunk.path,
        before: was === undefined ? "" : toLF(was.raw.replace(BOM, "")),
        after: toLF(hunk.contents),
        replaced: was !== undefined,
      });
    } else if (hunk.kind === "delete") {
      const was = await existing(absolute, hunk.path, `Failed to read ${absolute}`, false);
      await removable(absolute, hunk.path);
      planned.set(absolute, null);
      changes.push({ change: "delete", path: absolute, display: hunk.path, before: toLF(was.raw.replace(BOM, "")), after: "", replaced: false });
    } else {
      const was = await existing(absolute, hunk.path, `Failed to read file to update ${absolute}`, true);
      // A BOM is not a line's text: kept out of matching, and put back.
      const bom = was.raw.startsWith(BOM) ? BOM : "";
      const before = was.raw.slice(bom.length);
      let after: string;
      try {
        after = deriveNewContents(before, hunk.chunks, absolute);
      } catch (cause) {
        return failed((cause as Error).message);
      }
      const written = { raw: bom + after, ...(was.mode === undefined ? {} : { mode: was.mode }) };
      const common = { path: absolute, display: hunk.path, before: toLF(before), after: toLF(after), replaced: false };
      const to = hunk.movePath === undefined ? undefined : resolveToCwd(hunk.movePath, cwd);
      if (to !== undefined && (await realPath(to)) !== (await realPath(absolute))) {
        await once(to);
        await removable(absolute, hunk.path);
        if ((await read(to, hunk.movePath!, `Failed to write file ${to}`, true)) === undefined)
          await creatable(to, hunk.movePath!, `Failed to write file ${to}`);
        planned.set(absolute, null);
        planned.set(to, written);
        changes.push({ change: "move", ...common, movedTo: { path: to, display: hunk.movePath! } });
      } else {
        planned.set(absolute, written);
        changes.push({ change: "update", ...common });
      }
    }
  }
  return { changes, planned, onDisk, names };
}

/**
 * Writes what `resolved` plans: every file first, then the removals, so a crash between leaves a moved file in both
 * places, never in neither. A file moved to a new path keeps its mode, written with it. A failure partway (a full
 * disk) leaves what was written before it, and says what that was.
 */
async function write(resolved: Resolved): Promise<void> {
  const done: string[] = [];
  let doing = { verb: "write", path: "" };
  try {
    for (const [path, planned] of resolved.planned) {
      if (planned === null) continue;
      doing = { verb: "write", path };
      await replaceFile(path, planned.raw, planned.mode === undefined ? {} : { mode: planned.mode });
      done.push(resolved.names.get(path)!);
    }
    for (const [path, planned] of resolved.planned) {
      if (planned !== null || !resolved.onDisk.has(path)) continue;
      doing = { verb: "remove", path };
      await unlink(path);
      done.push(resolved.names.get(path)!);
    }
  } catch (cause) {
    const display = resolved.names.get(doing.path)!;
    throw new Error(
      `Could not ${doing.verb} ${display}: ${fsMessage(cause, display)}. ${done.length === 0 ? "No file was changed." : `Changed before the failure: ${done.join(", ")}.`}`,
    );
  }
}

/** The tool's result: Codex's summary, the files added (`A`), changed (`M`, a moved one by where it went), and deleted (`D`). */
function result(changes: readonly Change[]) {
  const listed = (letter: string, kinds: readonly PatchedFile["change"][]) =>
    changes.filter((change) => kinds.includes(change.change)).map((change) => `${letter} ${change.movedTo?.display ?? change.display}`);
  const files = changes.map((change): PatchedFile => {
    const sides =
      change.movedTo !== undefined
        ? { from: change.display, to: change.movedTo.display }
        : change.change === "add" && !change.replaced
          ? { from: "/dev/null", to: change.display }
          : change.change === "delete"
            ? { from: change.display, to: "/dev/null" }
            : change.display;
    const { patch, firstChangedLine } = unifiedPatch(sides, change.before, change.after);
    return {
      change: change.change,
      path: change.path,
      ...(change.movedTo === undefined ? {} : { movedTo: change.movedTo.path }),
      patch,
      ...(firstChangedLine === undefined || change.change === "delete" ? {} : { firstChangedLine }),
    };
  });
  const details: PatchDetails = { files, patch: files.map((file) => file.patch).join("") };
  const summary = ["Success. Updated the following files:", ...listed("A", ["add"]), ...listed("M", ["update", "move"]), ...listed("D", ["delete"])];
  return text(summary.join("\n"), details);
}

/** Codex's description of its `apply_patch` function tool, as it last had it (`apply_patch_spec.rs` before e783341b70). */
const DESCRIPTION = `Use the \`apply_patch\` tool to edit files.
Your patch language is a stripped‑down, file‑oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high‑level envelope:

*** Begin Patch
[ one or more file sections ]
*** End Patch

Within that envelope, you get a sequence of file operations.
You MUST include a header to specify the action you are taking.
Each operation starts with one of three headers:

*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).
*** Delete File: <path> - remove an existing file. Nothing follows.
*** Update File: <path> - patch an existing file in place (optionally with a rename).

May be immediately followed by *** Move to: <new path> if you want to rename the file.
Then one or more “hunks”, each introduced by @@ (optionally followed by a hunk header).
Within a hunk each line starts with:

For instructions on [context_before] and [context_after]:
- By default, show 3 lines of code immediately above and 3 lines immediately below each change. If a change is within 3 lines of a previous change, do NOT duplicate the first change’s [context_after] lines in the second change’s [context_before] lines.
- If 3 lines of context is insufficient to uniquely identify the snippet of code within the file, use the @@ operator to indicate the class or function to which the snippet belongs. For instance, we might have:
@@ class BaseClass
[3 lines of pre-context]
- [old_code]
+ [new_code]
[3 lines of post-context]

- If a code block is repeated so many times in a class or function such that even a single \`@@\` statement and 3 lines of context cannot uniquely identify the snippet of code, you can use multiple \`@@\` statements to jump to the right context. For instance:

@@ class BaseClass
@@ \t def method():
[3 lines of pre-context]
- [old_code]
+ [new_code]
[3 lines of post-context]

The full grammar definition is below:
Patch := Begin { FileOp } End
Begin := "*** Begin Patch" NEWLINE
End := "*** End Patch" NEWLINE
FileOp := AddFile | DeleteFile | UpdateFile
AddFile := "*** Add File: " path NEWLINE { "+" line NEWLINE }
DeleteFile := "*** Delete File: " path NEWLINE
UpdateFile := "*** Update File: " path NEWLINE [ MoveTo ] { Hunk }
MoveTo := "*** Move to: " newPath NEWLINE
Hunk := "@@" [ header ] NEWLINE { HunkLine } [ "*** End of File" NEWLINE ]
HunkLine := (" " | "-" | "+") text NEWLINE

A full patch can combine several operations:

*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch

It is important to remember:

- You must include a header with your intended action (Add/Delete/Update)
- You must prefix new lines with \`+\` even when creating a new file
- File references can only be relative, NEVER ABSOLUTE.
`;

export const patchTool: Tool<PatchInput> = {
  name: "apply_patch",
  description: DESCRIPTION,
  input: PatchInput,
  execute: async ({ input }, { cwd, signal }) => {
    let hunks: readonly PatchHunk[];
    try {
      hunks = parsePatch(input);
    } catch (cause) {
      return failed((cause as Error).message);
    }
    const paths = hunks.flatMap((hunk) => [
      resolveToCwd(hunk.path, cwd),
      ...(hunk.kind === "update" && hunk.movePath !== undefined ? [resolveToCwd(hunk.movePath, cwd)] : []),
    ]);
    return withFileLocks(paths, async () => {
      // Checked between steps rather than rejecting from a listener, so the locks are held until the writes settle.
      throwIfAborted(signal);
      const resolved = await resolvePatch(hunks, cwd);
      throwIfAborted(signal);
      await write(resolved);
      return result(resolved.changes);
    });
  },
};
