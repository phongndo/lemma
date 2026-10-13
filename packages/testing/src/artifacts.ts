import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import type { SimDisk } from "./disk.ts";

/** A host's URL carries its token: evidence CI uploads leaves it out. */
const redact = (text: string) => text.replace(/([?&]token=)[^&\s"']+/g, "$1<redacted>");

/** The commit a run was at, and whether the working tree had changes beside it. */
function source(): { readonly sha?: string; readonly dirty?: boolean } {
  try {
    const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return { sha: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain") !== "" };
  } catch {
    // Not a git checkout.
    return {};
  }
}

const relative = (name: string) => {
  const path = normalize(name);
  if (path.startsWith("/") || path.startsWith("..")) throw new Error(`Not a relative name in the evidence: ${name}`);
  return path;
};

/**
 * Saves a failed run's evidence before its runner removes its temporary state, in a new directory under
 * `LEMMA_TEST_ARTIFACTS` (the OS temp directory by default), and returns that directory. It holds `failure.json`: the
 * commit, and `details`, which name the seed and the command that replays it; each of `files`, by name; and a copy of
 * each of `copies`, a name for a path to copy, when that path exists. A caller copies durable state, never
 * credentials.
 */
export function failureArtifact(
  kind: string,
  details: Readonly<Record<string, unknown>>,
  files: Readonly<Record<string, string>> = {},
  copies: Readonly<Record<string, string>> = {},
): string {
  const root = process.env.LEMMA_TEST_ARTIFACTS ?? tmpdir();
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, `lemma-${kind}-`));
  writeFileSync(join(directory, "failure.json"), redact(JSON.stringify({ kind, source: source(), ...details }, null, 2)) + "\n");
  for (const [name, contents] of Object.entries(files)) {
    const target = join(directory, relative(name));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, redact(contents));
  }
  for (const [name, path] of Object.entries(copies)) if (existsSync(path)) cpSync(path, join(directory, relative(name)), { recursive: true });
  console.error(`Failure evidence: ${directory}`);
  return directory;
}

/** A simulated disk's files, as they would be read now, for `failureArtifact`'s `files` under `disk/`. */
export const diskFiles = (disk: SimDisk): Record<string, string> =>
  Object.fromEntries(disk.list().map((file) => [join("disk", relative(file.replace(/^\/+/, ""))), disk.read(file) ?? ""]));
