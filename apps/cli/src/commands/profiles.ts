import { Effect } from "effect";
import { table } from "@lemma/cli";
import { DEFAULT_PROFILE, isDefaultProfile, profileNameProblem, profileOf } from "@lemma/contracts/profiles";
import { buildKind, KINDS } from "@lemma/host/paths";
import { profileTitle } from "@lemma/profiles";
import { createProfile, listProfiles, portOf, readTitle, removeProfile } from "@lemma/profiles/local";
import { CliError, defineBuiltin, ExitCode, usage } from "../command.ts";
import type { Builtin } from "../command.ts";
import { confirm } from "../confirm.ts";
import { rootOf } from "../connect.ts";
import { stopHost } from "./lifecycle.ts";

/*
 * Profiles (docs/configuration.md#profiles). These read and write the profiles' folders and need no host running
 * (`profile remove` stops the profile's own first); `--profile <name>` (or `LEMMA_PROFILE`) points every other command
 * at one.
 */

const PROFILES = "Profiles: separate Lemmas on this machine (--profile picks one)";

const profileList = defineBuiltin({
  path: ["profile"],
  group: PROFILES,
  summary: "The profiles on this machine: the default (the home's own) and those made, each with its port and whether its host runs",
  description:
    "A profile is a separate Lemma, a home and a host of its own, sharing nothing with another. --profile <name> (or LEMMA_PROFILE) points any command at one, as `lemma --profile desk serve` starts its host; --profile core is the default.",
  run: ({ io }) =>
    Effect.gen(function* () {
      const using = profileOf(io.env) ?? DEFAULT_PROFILE;
      const profiles = yield* listProfiles(rootOf(io));
      const titles = yield* Effect.forEach(profiles, (profile) => readTitle(profile.home), { concurrency: "unbounded" });
      const rows = profiles.map((profile, index) => ({
        name: profile.name,
        title: profileTitle({
          name: profile.name,
          default: profile.name === DEFAULT_PROFILE,
          ...(titles[index] === undefined ? {} : { title: titles[index] }),
        }),
        home: profile.home,
        port: portOf(profile) ?? null,
        url: profile.running?.url ?? null,
        running: profile.running !== undefined,
        using: profile.name === using,
      }));
      return {
        json: { profiles: rows, using },
        text: [
          table([
            ["", "name", "shown as", "state", "home"],
            ...rows.map((row) => [
              row.using ? "*" : "",
              row.name,
              row.title,
              row.url === null ? `not running${row.port === null ? "" : ` (port ${row.port})`}` : row.url,
              row.home,
            ]),
          ]),
          "",
          rows.length === 1
            ? `Only the default, ${rows[0]?.title ?? "Core"}. \`lemma profile create <name>\` makes another.`
            : "* the one commands use here. --profile <name> picks another for a command.",
        ].join("\n"),
        ids: rows.map((row) => row.name),
      };
    }),
});

const profileCreate = defineBuiltin({
  path: ["profile", "create"],
  group: PROFILES,
  summary: "Make a profile: an empty home of its own, as Lemma is when first installed, with a port of its own",
  args: [{ name: "name", description: "What to call it: lowercase letters, digits, - and _", required: true }],
  examples: ["lemma profile create research", "lemma --profile research serve"],
  run: ({ io, args }) =>
    Effect.gen(function* () {
      const made = yield* createProfile(rootOf(io), args.name, undefined, KINDS[buildKind].port + 1).pipe(
        Effect.mapError((error) =>
          error.reason === "Name" ? usage(error.message) : new CliError({ code: error.reason, message: error.message, exit: ExitCode.failed }),
        ),
      );
      return {
        json: made,
        text: [
          `Made the profile "${made.name}" in ${made.home}${made.port === undefined ? "" : `, on port ${made.port}`}.`,
          `Start its host with \`lemma --profile ${made.name} serve\`, or open it from a web app's profile menu or the desktop app, which start it.`,
          ...(made.port === undefined
            ? []
            : [
                `To reach it from another machine, serve that port there as you serve the default's: \`tailscale serve --bg --https=${made.port} ${made.port}\`.`,
              ]),
        ].join("\n"),
        ids: [made.name],
      };
    }),
});

const profileRemove = defineBuiltin({
  path: ["profile", "remove"],
  group: PROFILES,
  summary: "Delete a profile and everything in its home: its threads, config, plugins, and logins",
  description:
    "Its host, if one runs, is stopped first, whatever it is doing and whoever started it, as Settings › Profiles does. It asks at a terminal, and otherwise refuses unless --force. A user service for it (lemma --profile <name> service) is not removed: uninstall that first.",
  args: [{ name: "name", description: "The profile's name", required: true }],
  flags: { force: { type: "boolean", description: "Stop its host and delete it without asking" } },
  run: ({ io, args, flags }) =>
    Effect.gen(function* () {
      if (isDefaultProfile(args.name)) return yield* usage(`"${args.name}" is the default profile, the home itself (${rootOf(io)}), which is never removed`);
      const problem = profileNameProblem(args.name);
      if (problem !== undefined) return yield* usage(problem);
      const profile = (yield* listProfiles(rootOf(io))).find((candidate) => candidate.name === args.name);
      if (profile === undefined) return { json: { removed: false, name: args.name }, text: `No profile "${args.name}"` };
      const doing = profile.running === undefined ? "Delete" : `Stop its host (pid ${profile.running.pid}) and delete`;
      if (
        !flags.force &&
        !(yield* confirm(io, `${doing} the profile "${args.name}" and everything in ${profile.home}: its threads, config, plugins, and logins?`))
      )
        return yield* new CliError({
          code: "NotConfirmed",
          message: `Nothing was deleted; --force deletes "${args.name}" without asking`,
          exit: ExitCode.failed,
        });
      if (profile.running !== undefined) yield* stopHost({ ...io, env: { ...io.env, LEMMA_PROFILE: args.name } }, profile.running, true);
      yield* removeProfile(rootOf(io), args.name).pipe(
        Effect.mapError(
          (error) => new CliError({ code: error.reason === "Write" ? "WriteFailed" : error.reason, message: error.message, exit: ExitCode.failed }),
        ),
      );
      return { json: { removed: true, name: args.name, home: profile.home }, text: `Deleted the profile "${args.name}" (${profile.home})` };
    }),
});

export const profileCommands: readonly Builtin[] = [profileList, profileCreate, profileRemove];
