import { resolve } from "node:path";
import { Effect } from "effect";
import { FileChannels, WorkspaceChannels } from "@lemma/contracts";
import { call } from "./channels.ts";
import { usage } from "./command.ts";
import type { CliError, Command, Io, Options } from "./command.ts";
import { formatBranches, formatFiles, formatListing, formatWorkspace } from "./format.ts";

/**
 * `lemma workspace …`: the project directory controls the web app's
 * workspace bar and add-project dialog offer, through `WorkspaceChannels`
 * and `FileChannels`.
 */

/** A path for the host: `~` is left for the host to expand; anything else resolves against where the CLI runs. */
const hostPath = (io: Io, path: string | undefined) => (path?.startsWith("~") ? path : resolve(io.cwd, path ?? "."));

export const workspaceCommand = (sub: string | undefined, args: readonly string[], io: Io, options: Options): Command | CliError => {
  const extra = (count: number) => (args.length > count ? usage(`Unexpected argument "${args[count]}"`) : undefined);
  switch (sub) {
    case undefined:
    case "status":
      return (
        extra(1) ??
        (({ rpc }) =>
          Effect.map(call(rpc, WorkspaceChannels.status, { path: hostPath(io, args[0] ?? options.path) }), (status) => ({
            json: status,
            text: formatWorkspace(status),
          })))
      );
    case "branches":
      return (
        extra(1) ??
        (({ rpc }) =>
          Effect.map(call(rpc, WorkspaceChannels.branches, { path: hostPath(io, args[0] ?? options.path) }), (branches) => ({
            json: branches,
            text: formatBranches(branches),
          })))
      );
    case "checkout": {
      const branch = args[0];
      if (branch === undefined) return usage("workspace checkout needs a branch");
      return (
        extra(1) ??
        (({ rpc }) =>
          Effect.map(
            call(rpc, WorkspaceChannels.checkout, { path: hostPath(io, options.path), branch, ...(options.create ? { create: true } : {}) }),
            (status) => ({
              json: status,
              text: formatWorkspace(status),
            }),
          ))
      );
    }
    case "worktree": {
      const branch = args[0];
      if (branch === undefined) return usage("workspace worktree needs a branch name");
      return (
        extra(1) ??
        (({ rpc }) =>
          Effect.map(
            call(rpc, WorkspaceChannels.createWorktree, {
              path: hostPath(io, options.path),
              branch,
              ...(options.base === undefined ? {} : { base: options.base }),
            }),
            (status) => ({ json: status, text: formatWorkspace(status) }),
          ))
      );
    }
    case "mkdir": {
      const path = args[0];
      if (path === undefined) return usage("workspace mkdir needs a path");
      return (
        extra(1) ??
        (({ rpc }) =>
          Effect.map(call(rpc, WorkspaceChannels.createDirectory, { path: hostPath(io, path) }), (status) => ({ json: status, text: formatWorkspace(status) })))
      );
    }
    case "browse": {
      // A trailing slash lists a directory; anything else completes the last segment, as the add-project dialog does.
      const partial =
        args[0] === undefined
          ? `${io.cwd}/`
          : args[0].startsWith("~") || args[0].startsWith("/")
            ? args[0]
            : `${resolve(io.cwd, args[0])}${args[0].endsWith("/") ? "/" : ""}`;
      return (
        extra(1) ??
        (({ rpc }) => Effect.map(call(rpc, WorkspaceChannels.browse, { partialPath: partial }), (listing) => ({ json: listing, text: formatListing(listing) })))
      );
    }
    case "files": {
      // The words after `files` are one query, as typed after `@` in the composer.
      const query = args.join(" ");
      return ({ rpc }) =>
        Effect.map(
          call(rpc, FileChannels.search, { cwd: hostPath(io, options.path), query, ...(options.limit === undefined ? {} : { limit: options.limit }) }),
          (result) => ({ json: result, text: formatFiles(result) }),
        );
    }
    default:
      return usage(`Unknown workspace command "${sub}"`);
  }
};
