import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { Deferred, Effect } from "effect";
import type { Scope } from "effect";
import { CliChannels, closest, parseInput, renderHelp } from "@lemma/cli";
import type { CliCommandInfo, CliElement, CliFile, CliInput, FlagSpec } from "@lemma/cli";
import { appUrl } from "@lemma/contracts";
import { dropped } from "@lemma/client";
import type { Host } from "@lemma/client";
import { callOn, following, ofChannel, reconnecting } from "./channels.ts";
import { CliError, ExitCode, usage } from "./command.ts";
import type { Connection, Failure, Globals, Io, Output, Target } from "./command.ts";
import { homeOf } from "./connect.ts";
import { openPage, openWebPath } from "./open.ts";
import { answering, hearing, hostEvents, questionHandler } from "./questions.ts";

/*
 * The commands host plugins add (`CliCommands`): listed by the host
 * (`cli.commands`), parsed here with their spec, and run there (`cli.run`),
 * this command printing what they send. A run outlives a dropped connection
 * on the host for a while, so this command rejoins it where it left off.
 */

/** The commands the host's plugins add, or undefined when nothing serves them (`cli.registry` is off). */
export const listHosted = (host: Host): Effect.Effect<readonly CliCommandInfo[] | undefined, Failure> =>
  callOn(host, CliChannels.commands, undefined).pipe(
    Effect.catch((error) => (ofChannel(error, CliChannels.commands.id, "NotFound") ? Effect.succeed(undefined) : Effect.fail(error))),
  );

/** The command `words` begin with: the one whose path is the longest prefix of them. */
export const match = <C extends { readonly path: readonly string[] }>(commands: readonly C[], words: readonly string[]): C | undefined => {
  let found: C | undefined;
  for (const command of commands) {
    if (command.path.length > words.length || !command.path.every((word, i) => words[i] === word)) continue;
    if (found === undefined || command.path.length > found.path.length) found = command;
  }
  return found;
};

/** The leading words of `argv` that could name a command: those before the first flag. */
export const leadingWords = (argv: readonly string[]): readonly string[] => {
  const words: string[] = [];
  for (const word of argv) {
    if (word.startsWith("-")) break;
    words.push(word);
  }
  return words;
};

const MIME: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
};

/** A `file` flag's path, read here, so the host receives its content wherever it runs. */
const readFlagFile = (io: Io, flag: string, spec: FlagSpec, path: string): Effect.Effect<CliFile, CliError> =>
  Effect.gen(function* () {
    const file = resolve(io.cwd, path);
    const mimeType = MIME[extname(file).toLowerCase()];
    if (spec.accept !== undefined && (mimeType === undefined || !spec.accept.includes(mimeType)))
      return yield* usage(`--${flag} ${path}: it must be ${spec.accept.join(", ")}`);
    const data = yield* Effect.tryPromise({
      try: () => readFile(file),
      catch: () => new CliError({ code: "NotFound", message: `Cannot read ${path}`, subject: path, exit: ExitCode.failed }),
    });
    return { name: basename(file), ...(mimeType === undefined ? {} : { mimeType }), data: data.toString("base64") };
  });

/** The input `words` give `command`, with its `file` flags read. */
const inputOf = (io: Io, command: CliCommandInfo, words: readonly string[]): Effect.Effect<CliInput, CliError> =>
  Effect.gen(function* () {
    const parsed = parseInput(command, words);
    if ("error" in parsed) return yield* usage(parsed.error);
    const flags: Record<string, unknown> = { ...parsed.flags };
    for (const [name, spec] of Object.entries(command.flags ?? {})) {
      if (spec.type !== "file" || flags[name] === undefined) continue;
      const value = flags[name];
      flags[name] = Array.isArray(value)
        ? yield* Effect.forEach(value as string[], (path) => readFlagFile(io, name, spec, path))
        : yield* readFlagFile(io, name, spec, value as string);
    }
    return { args: parsed.args, flags };
  });

/** What a stream's end means for a command that rejoins its run: undefined to go on (it reopens), else how it ends. */
type Ending = { readonly kind: "done" } | { readonly kind: "failed"; readonly error: Failure };

/**
 * Runs `command` on the host with `words` (after its path), printing what it
 * sends, and returns its result. Its questions, and those of the origins it
 * names (`answer`), are answered per the policy; a dropped connection is
 * reconnected (`reconnecting`) and the run rejoined where this command left
 * it; Ctrl+C cancels it on the host.
 */
export const runHosted = (
  connection: Connection,
  host: Host,
  events: Parameters<typeof hostEvents>[0],
  io: Io,
  globals: Globals,
  command: CliCommandInfo,
  words: readonly string[],
): Effect.Effect<Output | undefined, Failure, Scope.Scope> =>
  Effect.gen(function* () {
    const input = yield* inputOf(io, command, words);
    const origin = `cli:${randomUUID()}`;
    const origins = new Set([origin]);
    const questions = yield* questionHandler(host, io, globals, (asked) => asked !== undefined && origins.has(asked));
    yield* hostEvents(events, questions);

    let invocation: string | undefined;
    let received = 0;
    let rerun: readonly string[] | undefined;
    let streamed = false;
    let result: Extract<CliElement, { type: "result" }> | undefined;
    let midLine = false;
    const ended = yield* Deferred.make<Ending>();
    // A prompt to open a page closes when the command ends.
    const prompts = new AbortController();
    yield* Effect.addFinalizer(() => Effect.sync(() => prompts.abort()));

    const payload = () => ({
      path: command.path,
      input,
      cwd: io.cwd,
      json: globals.json,
      ...(io.columns === undefined ? {} : { columns: io.columns }),
      origin,
      ...(invocation === undefined ? {} : { resume: { invocation, received } }),
    });

    const onElement = (element: CliElement) => {
      received++;
      switch (element.type) {
        case "started":
          invocation = element.invocation;
          return;
        case "text":
          if (element.err === true) (io.errWrite ?? ((text: string) => io.err(text.replace(/\n$/, ""))))(element.text);
          else {
            io.write?.(element.text);
            midLine = !element.text.endsWith("\n") && element.text !== "";
            streamed = true;
          }
          return;
        case "json":
          io.out(JSON.stringify(element.value));
          streamed = true;
          return;
        case "open":
          if (element.path !== undefined) {
            if (!openWebPath(io, homeOf(io), connection.target, element.path)) io.err(appUrl(connection.target.url, element.path, connection.target.token));
          } else openPage(io, element.url, element.prompt, answering(io, globals), prompts.signal);
          return;
        case "answer":
          origins.add(element.origin);
          return;
        case "rerun":
          // On the same host: a line without `--env` could go to another.
          rerun = [...(globals.env === undefined ? [] : ["--env", globals.env]), ...element.args];
          return;
        case "result":
          result = element;
          return;
      }
    };

    yield* following(host, CliChannels.run, payload, onElement, (error) => {
      // Dropped with the connection: reopened on the next one, where the run is rejoined from what was received.
      if (error !== undefined && dropped(error) && invocation !== undefined) return true;
      const ending: Ending = error === undefined ? { kind: "done" } : { kind: "failed", error: error as Failure };
      Effect.runSync(Deferred.succeed(ended, ending));
      return false;
    });

    // Ctrl+C: cancel it on the host, which otherwise runs it on for a while for this command to rejoin.
    yield* Effect.addFinalizer((exit) =>
      exit._tag === "Failure" && invocation !== undefined && result === undefined
        ? callOn(host, CliChannels.cancel, { invocation }).pipe(Effect.timeout("2 seconds"), Effect.ignore)
        : Effect.void,
    );

    const ending = yield* reconnecting(host, io, Deferred.await(ended)).pipe(
      Effect.mapError((error) => (rerun === undefined || !(error instanceof CliError) ? error : new CliError({ ...error, rerun }))),
    );
    if (midLine) io.write?.("\n");
    if (ending.kind === "failed") {
      const error = ending.error;
      if (ofChannel(error, CliChannels.run.id, "NotFound"))
        return yield* new CliError({
          code: "NotFound",
          message: "Nothing serves the commands plugins add (cli.registry is off): see `lemma plugins`",
          exit: ExitCode.failed,
        });
      if (rerun !== undefined && !(error instanceof CliError))
        return yield* new CliError({
          code: "code" in error && typeof error.code === "string" ? error.code : "Failed",
          message: error.message,
          ...("subject" in error && typeof error.subject === "string" ? { subject: error.subject } : {}),
          exit: "code" in error && error.code === "Withdrawn" ? ExitCode.unavailable : ExitCode.failed,
          rerun,
        });
      return yield* Effect.fail(error);
    }
    if (result === undefined)
      return yield* new CliError({ code: "Unexpected", message: `"lemma ${command.path.join(" ")}" ended without a result`, exit: ExitCode.failed });
    return {
      json: result.json ?? null,
      text: result.text ?? "",
      compact: globals.json && streamed,
      ...(result.failed === true ? { exit: ExitCode.failed } : {}),
      ...(result.ids === undefined ? {} : { ids: result.ids }),
    } satisfies Output;
  });

/**
 * A host command line: found among what the host's plugins add, its help, or
 * run. `words` is the whole command line but the global flags.
 */
export const hostedCommand = (
  connection: Connection,
  io: Io,
  globals: Globals,
  argv: readonly string[],
  others: readonly { readonly path: readonly string[] }[],
): Effect.Effect<Output | undefined, Failure, Scope.Scope> =>
  Effect.gen(function* () {
    const answers = answering(io, globals);
    const { host, events } = yield* hearing(connection, answers);
    const commands = yield* listHosted(host);
    const words = leadingWords(argv);
    const command = commands === undefined ? undefined : match(commands, words);
    if (command === undefined) {
      const all = [...others, ...(commands ?? [])].map((candidate) => candidate.path.join(" "));
      const near = closest(words.join(" "), all) ?? closest(words[0] ?? "", all);
      const group = commands?.filter((candidate) => candidate.path[0] === words[0]) ?? [];
      if (words.length === 1 && group.length > 0)
        return { json: group, text: groupHelp(words[0]!, group), ids: group.map((candidate) => candidate.path.join(" ")) } satisfies Output;
      return yield* new CliError({
        code: "UnknownCommand",
        message: `Unknown command "${words.join(" ")}"${near === undefined ? "" : `; did you mean "lemma ${near}"?`}${commands === undefined ? " (nothing on the host serves plugins' commands: cli.registry is off)" : ""}\nRun \`lemma --help\` for usage.`,
        exit: ExitCode.usage,
      });
    }
    if (globals.help) return { json: command, text: renderHelp(command) };
    return yield* runHosted(connection, host, events, io, globals, command, argv.slice(command.path.length));
  });

/** The commands under a word that is not a command itself: `lemma sessions`. */
export const groupHelp = (word: string, commands: readonly CliCommandInfo[]): string =>
  [
    `lemma ${word} <command>`,
    "",
    ...commands.map((command) => `  ${command.path.join(" ").padEnd(28)}  ${command.summary}`),
    "",
    `Run \`lemma ${word} <command> --help\` for one's options.`,
  ].join("\n");

export type { Target };
