import { resolve } from "node:path";
import { Effect } from "effect";
import type { Context } from "effect";
import { definePlugin, Registries } from "@lemma/core";
import { FILE_SEARCH_LIMIT, FileChannels, WorkspaceChannels } from "@lemma/workspace";
import type { DirectoryListing, FileSearchResult, GitBranch, WorkspaceStatus } from "@lemma/workspace";
import { callHere, CliCommands, defineCliCommand, table, time, usageError } from "@lemma/cli";

type Reader = Context.Service.Shape<typeof Registries>;

export const formatWorkspace = (status: WorkspaceStatus): string => {
  if (!status.exists) return `${status.path}: does not exist`;
  const git = status.git;
  if (git === undefined) return `${status.path}: not a git repository`;
  return table([
    ["path", status.path],
    ["branch", git.branch ?? `(detached at ${git.head ?? "?"})`],
    ["head", git.head ?? "(no commits)"],
    ["changes", String(git.changes)],
    ...(git.upstream === undefined ? [] : [["upstream", `${git.upstream} (ahead ${git.ahead}, behind ${git.behind})`]]),
    ...(git.worktreeOf === undefined ? [] : [["worktree of", git.worktreeOf]]),
  ]);
};

export const formatBranches = (branches: readonly GitBranch[]): string =>
  branches.length === 0
    ? "No branches."
    : table(
        branches.map((branch) => [
          branch.current ? "*" : " ",
          branch.name,
          branch.remote ? "remote" : "",
          time(branch.updatedAt),
          branch.worktree === undefined ? "" : `in ${branch.worktree}`,
        ]),
      );

export const formatListing = (listing: DirectoryListing): string =>
  [listing.parent, ...listing.entries.map((entry) => `  ${entry.name}/${entry.git ? "  (git)" : ""}`), ...(listing.truncated ? ["  …"] : [])].join("\n");

export const formatFiles = (result: FileSearchResult): string =>
  [
    ...(result.entries.length === 0 ? ["No matches."] : result.entries.map((entry) => (entry.kind === "directory" ? `${entry.path}/` : entry.path))),
    ...(result.truncated ? ["…"] : []),
    ...(result.indexing === true ? ["(still reading the directory: some may be missing)"] : []),
  ].join("\n");

/** A path for the host: `~` is left for the host to expand; anything else resolves against where the client runs. */
const hostPath = (cwd: string, path: string | undefined) => (path?.startsWith("~") ? path : resolve(cwd, path ?? "."));

const pathFlag = { path: { type: "string", placeholder: "dir", description: "The project directory, on the host's machine (default: here)" } } as const;

export const workspaceCommands = (registries: Reader) => [
  defineCliCommand({
    path: ["workspace", "status"],
    summary: "Whether a project directory exists, and its git branch, head, changes, and upstream",
    args: [{ name: "path", description: "The directory (default: here)" }],
    run: ({ args, cwd }) =>
      Effect.map(callHere(registries, WorkspaceChannels.status, { path: hostPath(cwd, args.path) }), (status) => ({
        json: status,
        text: formatWorkspace(status),
      })),
  }),
  defineCliCommand({
    path: ["workspace", "branches"],
    summary: "Local branches by recency, then remote-only ones",
    args: [{ name: "path", description: "The directory (default: here)" }],
    run: ({ args, cwd }) =>
      Effect.map(callHere(registries, WorkspaceChannels.branches, { path: hostPath(cwd, args.path) }), (branches) => ({
        json: branches,
        text: formatBranches(branches),
        ids: branches.map((branch) => branch.name),
      })),
  }),
  defineCliCommand({
    path: ["workspace", "checkout"],
    summary: "Check out a branch in the project",
    args: [{ name: "branch", description: "The branch", required: true }],
    flags: { ...pathFlag, create: { type: "boolean", description: "Create it first" } },
    run: ({ args, flags, cwd }) =>
      Effect.map(
        callHere(registries, WorkspaceChannels.checkout, { path: hostPath(cwd, flags.path), branch: args.branch, ...(flags.create ? { create: true } : {}) }),
        (status) => ({ json: status, text: formatWorkspace(status) }),
      ),
  }),
  defineCliCommand({
    path: ["workspace", "worktree"],
    summary: 'A linked worktree on a new branch, as the web app\'s "new worktree"',
    args: [{ name: "branch", description: "The new branch", required: true }],
    flags: { ...pathFlag, base: { type: "string", placeholder: "ref", description: "What it starts from (default: the current head)" } },
    run: ({ args, flags, cwd }) =>
      Effect.map(
        callHere(registries, WorkspaceChannels.createWorktree, {
          path: hostPath(cwd, flags.path),
          branch: args.branch,
          ...(flags.base === undefined ? {} : { base: flags.base }),
        }),
        (status) => ({ json: status, text: formatWorkspace(status) }),
      ),
  }),
  defineCliCommand({
    path: ["workspace", "mkdir"],
    summary: "Create a directory",
    args: [{ name: "path", description: "The directory", required: true }],
    run: ({ args, cwd }) =>
      Effect.map(callHere(registries, WorkspaceChannels.createDirectory, { path: hostPath(cwd, args.path) }), (status) => ({
        json: status,
        text: formatWorkspace(status),
      })),
  }),
  defineCliCommand({
    path: ["workspace", "browse"],
    summary: "Complete a directory path, as the add-project dialog does: a trailing slash lists a directory",
    args: [{ name: "partial", description: "A path, partly typed (default: here)" }],
    run: ({ args, cwd }) => {
      const partial = args.partial;
      const path =
        partial === undefined
          ? `${cwd}/`
          : partial.startsWith("~") || partial.startsWith("/")
            ? partial
            : `${resolve(cwd, partial)}${partial.endsWith("/") ? "/" : ""}`;
      return Effect.map(callHere(registries, WorkspaceChannels.browse, { partialPath: path }), (listing) => ({ json: listing, text: formatListing(listing) }));
    },
  }),
  defineCliCommand({
    path: ["workspace", "files"],
    summary: "A project's files and directories matching a query, best first, as the composer's @ finds them",
    args: [{ name: "query", description: "What to look for (the words are one query)", variadic: true }],
    flags: { ...pathFlag, limit: { type: "number", short: "n", description: `At most this many (1 to ${FILE_SEARCH_LIMIT})` } },
    run: ({ args, flags, cwd }) =>
      Effect.gen(function* () {
        if (flags.limit !== undefined && !(Number.isInteger(flags.limit) && flags.limit >= 1 && flags.limit <= FILE_SEARCH_LIMIT))
          return yield* usageError(`--limit must be a whole number from 1 to ${FILE_SEARCH_LIMIT}`);
        const result = yield* callHere(registries, FileChannels.search, {
          cwd: hostPath(cwd, flags.path),
          query: args.query.join(" "),
          ...(flags.limit === undefined ? {} : { limit: flags.limit }),
        });
        return { json: result, text: formatFiles(result), ids: result.entries.map((entry) => entry.path) };
      }),
  }),
];

/**
 * The project directory's commands for the `lemma` command (`CliCommands`):
 * `workspace status|branches|checkout|worktree|mkdir|browse|files`, the
 * controls the web app's workspace bar and add-project dialog offer. It
 * reaches the workspace through its channels, so it requires nothing.
 */
export default definePlugin({
  id: "workspace.cli",
  version: "0.1.0",
  setup: function* (_, owner) {
    const registries = yield* Registries;
    for (const command of workspaceCommands(registries)) yield* owner.add(CliCommands, command);
  },
});
