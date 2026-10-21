import { Cause, Duration, Effect, Exit } from "effect";
import type { Scope } from "effect";
import { closest, columns, GLOBAL_FLAGS, inputJsonSchema, parseInput, renderGlobalFlags, renderHelp, usageLine } from "@lemma/cli";
import type { CliCommandInfo, CommandSpec } from "@lemma/cli";
import { shellWord } from "@lemma/contracts";
import { readEnvironments } from "@lemma/contracts/discovery";
import packageJson from "../package.json" with { type: "json" };
import { hostCommands } from "./commands/host.ts";
import { lifecycleCommands } from "./commands/lifecycle.ts";
import { releaseCommands } from "./commands/release.ts";
import { setupCommands } from "./commands/setup.ts";
import { CliError, ExitCode, usage } from "./command.ts";
import type { Builtin, Connection, Failure, Globals, Io, Output, QuestionPolicy } from "./command.ts";
import { connect, homeOf, otherProtocol, toCliError } from "./connect.ts";
import { groupHelp, hostedCommand, leadingWords, listHosted, match } from "./hosted.ts";

export { ExitCode } from "./command.ts";

/** The `lemma` command's own commands, in the order `lemma help` lists their groups. */
export const builtins: readonly Builtin[] = [...lifecycleCommands, ...hostCommands, ...setupCommands, ...releaseCommands];

export const VERSION: string = packageJson.version;

/**
 * Variables an agent's shell sets, so a command it runs prints JSON unless
 * told otherwise (`--text`, `LEMMA_OUTPUT=text`): Lemma's own agent
 * (`LEMMA_AGENT`, which the host sets for its tools), Claude Code, Gemini CLI,
 * Codex, and Cursor's agent.
 */
const AGENT_VARIABLES = ["LEMMA_AGENT", "CLAUDECODE", "GEMINI_CLI", "CODEX_SANDBOX", "CURSOR_AGENT"];

/** Whether output is JSON by default here: `LEMMA_OUTPUT` says, else whether an agent runs the command. */
export const jsonByDefault = (env: Io["env"]): boolean => {
  const output = env.LEMMA_OUTPUT?.trim();
  if (output === "json") return true;
  if (output === "text") return false;
  return AGENT_VARIABLES.some((name) => (env[name] ?? "").trim() !== "" && env[name] !== "0");
};

const QUESTION_POLICIES = new Set(["ask", "ignore", "dismiss"]);

/** The global flags out of `argv`, wherever they are before `--`, and the rest: the command line itself. */
export const splitGlobals = (
  argv: readonly string[],
  env: Io["env"],
): { readonly globals: Globals & { readonly version: boolean }; readonly rest: readonly string[] } | CliError => {
  const rest: string[] = [];
  const values: Record<string, unknown> = { answer: [] as string[] };
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]!;
    if (word === "--") {
      rest.push(...argv.slice(i));
      break;
    }
    const short = /^-([hq])$/.exec(word)?.[1];
    const long = word.startsWith("--") ? word.slice(2).split("=")[0]! : undefined;
    const name = short === "h" ? "help" : short === "q" ? "quiet" : long !== undefined && Object.hasOwn(GLOBAL_FLAGS, long) ? long : undefined;
    if (name === undefined) {
      rest.push(word);
      continue;
    }
    const flag = GLOBAL_FLAGS[name]!;
    if (flag.type === "boolean") {
      values[name] = !word.endsWith("=false");
      continue;
    }
    const value = word.includes("=") ? word.slice(word.indexOf("=") + 1) : argv[++i];
    if (value === undefined) return usage(`--${name} needs a value`);
    if (flag.multiple === true) (values[name] as string[]).push(value);
    else values[name] = value;
  }
  const questions = values.questions as string | undefined;
  if (questions !== undefined && !QUESTION_POLICIES.has(questions)) return usage("--questions must be ask, ignore, or dismiss");
  if (values.json === true && values.text === true) return usage("Use either --json or --text");
  const fields =
    typeof values.fields === "string"
      ? values.fields
          .split(",")
          .map((field) => field.trim())
          .filter(Boolean)
      : undefined;
  return {
    globals: {
      json: values.json === true || (values.text !== true && jsonByDefault(env)),
      quiet: values.quiet === true,
      env: values.env as string | undefined,
      fields,
      questions: questions as QuestionPolicy | undefined,
      answers: values.answer as string[],
      help: values.help === true,
      version: values.version === true,
    },
    rest,
  };
};

/** Keeps `fields` of each object in a list (or of the object itself): `--fields`. */
const project = (value: unknown, fields: readonly string[] | undefined): unknown => {
  if (fields === undefined) return value;
  const pick = (item: unknown) =>
    typeof item === "object" && item !== null && !Array.isArray(item)
      ? Object.fromEntries(fields.filter((field) => field in item).map((field) => [field, (item as Record<string, unknown>)[field]]))
      : item;
  return Array.isArray(value) ? value.map(pick) : pick(value);
};

const report = (io: Io, json: boolean, error: CliError): number => {
  if (json) {
    io.err(
      JSON.stringify({
        error: {
          code: error.code,
          message: error.message,
          ...(error.subject === undefined ? {} : { subject: error.subject }),
          ...(error.rerun === undefined ? {} : { rerun: error.rerun }),
        },
      }),
    );
  } else {
    io.err(`lemma: ${error.message}`);
    if (error.rerun !== undefined)
      io.err(`lemma: it may still be running: run \`lemma ${error.rerun.map(shellWord).join(" ")}\` to rejoin it rather than start it twice`);
  }
  return error.exit;
};

// ------------------------------------------------------------------ help

/** What a host's plugins add, if one answers soon: help lists them without waiting on a host that is slow or gone. */
const hostedSoon = (io: Io, globals: Globals): Effect.Effect<{ readonly name: string; readonly commands: readonly CliCommandInfo[] } | undefined> =>
  Effect.scoped(
    Effect.gen(function* () {
      const connection = yield* connect(io, globals);
      const host = yield* connection.host({ answers: false });
      const commands = yield* listHosted(host);
      return commands === undefined ? undefined : { name: connection.target.name, commands };
    }),
  ).pipe(
    Effect.timeoutOrElse({ duration: Duration.millis(1_500), orElse: () => Effect.succeed(undefined) }),
    Effect.orElseSucceed(() => undefined),
  );

const listing = (commands: readonly CommandSpec[]) =>
  columns(
    commands.map((command) => [
      usageLine(command)
        .replace(/^lemma /, "")
        .replace(/ \[options\]$/, ""),
      command.summary,
    ]),
  );

const topHelp = (hosted: { readonly name: string; readonly commands: readonly CliCommandInfo[] } | undefined): string => {
  const groups = new Map<string, Builtin[]>();
  for (const command of builtins) groups.set(command.group, [...(groups.get(command.group) ?? []), command]);
  return [
    "Usage: lemma <command> [options]",
    "",
    "Start and keep hosts, set them up, look inside them, and use what their plugins add. A command goes to the host --env names, else LEMMA_URL, LEMMA_ENV, the default environment (lemma env), else this machine's.",
    ...[...groups].flatMap(([group, commands]) => ["", group, listing(commands)]),
    "",
    hosted === undefined
      ? "From the host's plugins: none answers now. Start one (lemma serve) to see the commands its plugins add: sessions, run, models, login, workspace, …"
      : `From the plugins of the host ${hosted.name}\n${listing(hosted.commands)}`,
    "",
    "Global options",
    renderGlobalFlags(),
    "",
    "Exit codes: 0 ok, 1 the host refused or failed the request (or the work it ran failed), 2 usage error, 3 no host, or it could not be reached, the connection was lost, or it is still starting, 130 interrupted (Ctrl+C).",
    "`lemma help <command>` shows one's options; `lemma help --json` every command, with a JSON Schema of what it takes.",
  ].join("\n");
};

const describe = (command: CommandSpec, source: string) => ({
  path: command.path,
  summary: command.summary,
  ...(command.description === undefined ? {} : { description: command.description }),
  ...(command.args === undefined ? {} : { args: command.args }),
  ...(command.flags === undefined ? {} : { flags: command.flags }),
  ...(command.examples === undefined ? {} : { examples: command.examples }),
  source,
  input: inputJsonSchema(command),
});

/** `lemma help [command…]`: the commands, or one's help; with `--json`, all of them as data for an agent. */
const help = (io: Io, globals: Globals, words: readonly string[]): Effect.Effect<Output, Failure> =>
  Effect.gen(function* () {
    const builtin = words.length === 0 ? undefined : match(builtins, words);
    if (builtin !== undefined && builtin.path.length === words.length) return { json: describe(builtin, "lemma"), text: renderHelp(builtin) };
    const hosted = yield* hostedSoon(io, globals);
    if (words.length === 0)
      return {
        json: {
          version: VERSION,
          globalFlags: GLOBAL_FLAGS,
          exitCodes: ExitCode,
          host: hosted === undefined ? null : hosted.name,
          commands: [...builtins.map((command) => describe(command, "lemma")), ...(hosted?.commands ?? []).map((command) => describe(command, command.source))],
        },
        text: topHelp(hosted),
      };
    const found = hosted === undefined ? undefined : match(hosted.commands, words);
    if (found !== undefined && found.path.length === words.length) return { json: describe(found, found.source), text: renderHelp(found) };
    const group = [...builtins, ...(hosted?.commands ?? [])].filter((command) => command.path[0] === words[0]);
    if (words.length === 1 && group.length > 0)
      return {
        json: group.map((command) => describe(command, "source" in command ? (command.source as string) : "lemma")),
        text: groupHelp(words[0]!, group as CliCommandInfo[]),
      };
    const all = [...builtins, ...(hosted?.commands ?? [])].map((command) => command.path.join(" "));
    const near = closest(words.join(" "), all);
    return yield* usage(
      `No command "${words.join(" ")}"${near === undefined ? "" : `; did you mean "${near}"?`}${hosted === undefined ? " (no host answers to say what its plugins add)" : ""}`,
    );
  });

// ------------------------------------------------------------------ completion

const COMPLETIONS: Readonly<Record<string, string>> = {
  bash: `# lemma completion for bash: source <(lemma completion bash)
_lemma() {
  local IFS=$'\\n'
  COMPREPLY=($(lemma __complete "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null))
}
complete -o default -F _lemma lemma
`,
  zsh: `#compdef lemma
# lemma completion for zsh: source <(lemma completion zsh)
_lemma() {
  local -a candidates
  candidates=("\${(@f)$(lemma __complete "\${words[@]:1:CURRENT-1}" 2>/dev/null)}")
  compadd -a candidates
}
compdef _lemma lemma
`,
  fish: `# lemma completion for fish: lemma completion fish | source
complete -c lemma -f -a '(lemma __complete (commandline -opc)[2..-1] (commandline -ct) 2>/dev/null)'
`,
};

/**
 * What `words`' last word can be: a command's next word, a flag, or a flag's
 * value. The host's plugins' commands come in when one answers soon.
 */
const complete = (io: Io, globals: Globals, words: readonly string[]): Effect.Effect<readonly string[]> =>
  Effect.gen(function* () {
    const current = words.at(-1) ?? "";
    const before = words.slice(0, -1);
    const previous = before.at(-1);
    if (previous === "--env") {
      const file = yield* readEnvironments(homeOf(io)).pipe(Effect.orElseSucceed(() => ({ environments: {} })));
      return ["local", ...Object.keys(file.environments)].filter((name) => name.startsWith(current));
    }
    const hosted = yield* hostedSoon(io, globals);
    const commands: readonly CommandSpec[] = [...builtins, ...(hosted?.commands ?? [])];
    const path = leadingWords(before);
    const command = match(commands, path);
    if (previous?.startsWith("--") === true && command !== undefined) {
      const flag = command.flags?.[previous.slice(2)];
      if (flag?.values !== undefined) return flag.values.filter((value) => value.startsWith(current));
    }
    if (current.startsWith("-"))
      return [...Object.keys(command?.flags ?? {}), ...Object.keys(GLOBAL_FLAGS)].map((name) => `--${name}`).filter((flag) => flag.startsWith(current));
    if (path.length < before.length) return [];
    const next = new Set(
      commands
        .filter((candidate) => candidate.path.length > path.length && path.every((word, i) => candidate.path[i] === word))
        .map((candidate) => candidate.path[path.length]!),
    );
    if (path.length === 0) for (const word of ["help", "completion"]) next.add(word);
    return [...next].filter((word) => word.startsWith(current)).sort();
  });

// ------------------------------------------------------------------ run

/** Runs one command line and returns the exit code. */
export async function run(argv: readonly string[], io: Io): Promise<number> {
  if (argv[0] === "__complete") {
    // The words as typed: a global flag among them is completed (`--env <name>`), not read. Those before the last pick the host.
    const words = argv.slice(1);
    const split = splitGlobals(words.slice(0, -1), io.env);
    const done = split instanceof CliError ? undefined : split;
    const globals = done?.globals ?? (splitGlobals([], io.env) as Exclude<typeof split, CliError>).globals;
    const line = [...(done?.rest ?? words.slice(0, -1)), words.at(-1) ?? ""];
    for (const candidate of await Effect.runPromise(complete(io, globals, line))) io.out(candidate);
    return ExitCode.ok;
  }
  const split = splitGlobals(argv, io.env);
  // For an error splitGlobals gives before it decides: --json or --text as given (the later, when both are the error), else the environment.
  const asked = argv.filter((word) => word === "--json" || word === "--text").at(-1);
  const wantsJson = asked === undefined ? jsonByDefault(io.env) : asked === "--json";
  if (split instanceof CliError) return report(io, wantsJson, split);
  const { globals, rest } = split;
  const words = leadingWords(rest);
  if (globals.version && words.length === 0) {
    io.out(globals.json ? JSON.stringify({ version: VERSION }) : VERSION);
    return ExitCode.ok;
  }

  // The connection a command makes on first use, and the target it found: one per command line.
  let connection: Connection | undefined;
  const connectOnce: Effect.Effect<Connection, Failure, Scope.Scope> = Effect.suspend(() =>
    connection !== undefined ? Effect.succeed(connection) : Effect.tap(connect(io, globals), (made) => Effect.sync(() => (connection = made))),
  );

  const program: Effect.Effect<Output | undefined, Failure, Scope.Scope> = Effect.gen(function* () {
    if (words.length === 0) return globals.help || rest.length === 0 ? yield* help(io, globals, []) : yield* usage(`"${rest[0]}" is no command`);
    if (words[0] === "help") {
      if (words.length !== rest.length) return yield* usage("help takes command words only");
      return yield* help(io, globals, words.slice(1));
    }
    if (words[0] === "completion") {
      const shell = words[1];
      const script = shell === undefined ? undefined : COMPLETIONS[shell];
      if (script === undefined) return yield* usage(`completion takes a shell: ${Object.keys(COMPLETIONS).join(", ")}`);
      io.write?.(script);
      return undefined;
    }
    const builtin = match(builtins, words);
    if (builtin !== undefined) {
      if (globals.help) return { json: describe(builtin, "lemma"), text: renderHelp(builtin) };
      const input = parseInput(builtin, rest.slice(builtin.path.length));
      if ("error" in input) {
        // A word the builtin takes no argument for may name a plugin's command under it (`lemma plugins` is one, `lemma env` another).
        return yield* usage(input.error);
      }
      return yield* builtin.run({ args: input.args, flags: input.flags, io, globals, connect: connectOnce, rerun: run });
    }
    const near = closest(
      words[0]!,
      builtins.map((command) => command.path[0]!),
    );
    return yield* Effect.flatMap(
      connectOnce.pipe(
        Effect.catch((error) =>
          // Not one of lemma's own, and no host to ask for its plugins': a typo of one of lemma's is said so.
          error instanceof CliError && error.code === "NoHost" && near !== undefined && near !== words[0]
            ? Effect.fail(usage(`Unknown command "${words[0]}"; did you mean "lemma ${near}"?`))
            : Effect.fail(
                error instanceof CliError && error.code === "NoHost"
                  ? new CliError({
                      ...error,
                      message: `"lemma ${words.join(" ")}" is no command of lemma's own, so it is a plugin's, which only a running host has. ${error.message}`,
                    })
                  : error,
              ),
        ),
      ),
      (made) => hostedCommand(made, io, globals, rest, builtins),
    );
  });

  const guarded = program.pipe(
    // A reply the RPC client cannot read (from a host on another protocol) is a defect: reported, not thrown.
    Effect.catchDefect((defect) =>
      Effect.fail(
        new CliError({
          code: "Unexpected",
          message: `The host's reply could not be read: ${defect instanceof Error ? defect.message : String(defect)}`,
          exit: ExitCode.failed,
        }),
      ),
    ),
    Effect.mapError((error) => toCliError(error, connection?.target)),
    Effect.catch((error) =>
      connection !== undefined && (error.code === "Unreachable" || error.code === "NoHost" || error.code === "Unexpected")
        ? Effect.flatMap(otherProtocol(connection.target), (other) => Effect.fail(other ?? error))
        : Effect.fail(error),
    ),
  );
  const exit = await Effect.runPromiseExit(Effect.scoped(guarded).pipe(Effect.result), io.interrupt === undefined ? undefined : { signal: io.interrupt });
  if (Exit.isFailure(exit)) {
    if (Cause.hasInterruptsOnly(exit.cause)) return ExitCode.interrupted;
    throw Cause.squash(exit.cause);
  }
  const result = exit.value;
  if (result._tag === "Failure") return report(io, globals.json, result.failure);
  const output = result.success;
  if (output === undefined) return ExitCode.ok;
  if (globals.quiet) {
    for (const id of output.ids ?? []) io.out(id);
  } else if (globals.json) io.out(JSON.stringify(project(output.json, globals.fields), null, output.compact ? undefined : 2));
  else if (output.text !== "") io.out(output.text);
  return output.exit ?? ExitCode.ok;
}
