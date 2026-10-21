import { Schema } from "effect";

/*
 * What a command takes on the command line, and how its words become its
 * input: the same spec and parser for the `lemma` command's own commands and
 * for those host plugins add (`CliCommands`), so every command reads its
 * arguments, prints its help, and completes alike.
 */

/** A positional argument, in order. Only the last may be `variadic`, taking the rest of the words. */
export const ArgSpec = Schema.Struct({
  /** Shown as `<name>` in usage; the key of `args` in the input. */
  name: Schema.String,
  description: Schema.String,
  /** Default false: an argument left out is absent from `args`. */
  required: Schema.optional(Schema.Boolean),
  /** The rest of the words, as an array (`required` asks for at least one). */
  variadic: Schema.optional(Schema.Boolean),
});
export type ArgSpec = typeof ArgSpec.Type;

/**
 * A flag, `--name`. `boolean` takes no value (`--name=false` turns one off);
 * `string` and `number` take one (`--name value` or `--name=value`);
 * `file` takes a path on the client's machine, which the client reads and
 * sends as `CliFile`, so a command on a host elsewhere receives its content.
 */
export const FlagSpec = Schema.Struct({
  type: Schema.Literals(["boolean", "string", "number", "file"]),
  description: Schema.String,
  /** A one-letter alias, `-f`. */
  short: Schema.optional(Schema.String),
  /** Repeatable: its values, in order, as an array (never for `boolean`). */
  multiple: Schema.optional(Schema.Boolean),
  /** The values a `string` flag accepts. */
  values: Schema.optional(Schema.Array(Schema.String)),
  /** How usage names its value: `--cwd <dir>`. Default: `value`. */
  placeholder: Schema.optional(Schema.String),
  /** The media types a `file` flag accepts, by its extension (`image/png`); any when absent. */
  accept: Schema.optional(Schema.Array(Schema.String)),
});
export type FlagSpec = typeof FlagSpec.Type;

/** A command as the command line knows it: where it is, what it takes, and how its help reads. */
export const CommandSpec = Schema.Struct({
  /** The words after `lemma` that name it: `["sessions", "list"]`. Lowercase, kebab-case words. */
  path: Schema.Array(Schema.String),
  /** One line, imperative or a noun phrase: what `lemma help` lists. */
  summary: Schema.String,
  /** More, for its own help: when to use it, what it prints. */
  description: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(ArgSpec)),
  flags: Schema.optional(Schema.Record(Schema.String, FlagSpec)),
  /** Whole command lines, `lemma …`, for its help. */
  examples: Schema.optional(Schema.Array(Schema.String)),
});
export type CommandSpec = typeof CommandSpec.Type;

/** A `file` flag's value as a command receives it: the client read it, so its content crosses whatever the host's machine is. */
export const CliFile = Schema.Struct({
  /** Its base name. */
  name: Schema.String,
  /** By its extension; absent when unknown. */
  mimeType: Schema.optional(Schema.String),
  /** Base64. */
  data: Schema.String,
});
export type CliFile = typeof CliFile.Type;

/** What a command line becomes: arguments by name, flags by name (as the spec spells them). */
export const CliInput = Schema.Struct({
  args: Schema.Record(Schema.String, Schema.Unknown),
  flags: Schema.Record(Schema.String, Schema.Unknown),
});
export type CliInput = typeof CliInput.Type;

/**
 * Flags the `lemma` command reads itself, whatever the command: a command
 * cannot declare them (`specProblem`), and the client takes them out before
 * the rest reach it. `--version` only means something on its own.
 */
export const GLOBAL_FLAGS: Readonly<Record<string, FlagSpec>> = {
  json: { type: "boolean", description: 'Print results as JSON (errors as {"error": {...}} on stderr); streams print one JSON value per line' },
  text: { type: "boolean", description: "Print results as text, though an agent runs the command (see LEMMA_OUTPUT)" },
  env: { type: "string", placeholder: "name", description: "The host to use: a saved environment, or local (see lemma env)" },
  profile: {
    type: "string",
    placeholder: "name",
    description: "The profile to use, a separate Lemma with its own home and host (see lemma profile); default is the home's own, as LEMMA_PROFILE says",
  },
  quiet: { type: "boolean", short: "q", description: "Print only the ids a command reports, one per line" },
  fields: { type: "string", placeholder: "a,b", description: "With JSON output, keep only these fields of each object in a list" },
  questions: {
    type: "string",
    values: ["ask", "ignore", "dismiss"],
    description:
      "What to do with questions the host asks while the command runs: ask at the terminal (default when there is one), leave them to another client, or dismiss them",
  },
  answer: { type: "string", multiple: true, placeholder: "value", description: "Answer the next question the command's work asks with this, in order" },
  help: { type: "boolean", short: "h", description: "Show help" },
  version: { type: "boolean", description: "Print the version" },
};

const WORD = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * Why `value` is not a well-formed command spec, or `undefined` when it is:
 * what `CliCommands` checks of every item, since a plugin file may have no
 * types.
 */
export const specProblem = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) return "a command is an object";
  const spec = value as Partial<CommandSpec>;
  if (!Array.isArray(spec.path) || spec.path.length === 0 || !spec.path.every((word) => typeof word === "string" && WORD.test(word)))
    return "its `path` must be one or more lowercase words (`sessions`, `list`)";
  const name = spec.path.join(" ");
  if (typeof spec.summary !== "string" || spec.summary === "") return `"${name}" needs a summary`;
  const args = spec.args ?? [];
  const names = new Set<string>();
  for (const [index, arg] of args.entries()) {
    if (typeof arg?.name !== "string" || arg.name === "") return `"${name}": every argument needs a name`;
    if (names.has(arg.name)) return `"${name}": two arguments are named "${arg.name}"`;
    names.add(arg.name);
    if (arg.variadic === true && index !== args.length - 1) return `"${name}": only its last argument may be variadic`;
    const before = args[index - 1];
    if (arg.required === true && before !== undefined && before.required !== true) return `"${name}": a required argument cannot follow an optional one`;
  }
  const shorts = new Set<string>();
  for (const [flag, declared] of Object.entries(spec.flags ?? {})) {
    if (!WORD.test(flag)) return `"${name}": the flag "${flag}" must be a lowercase word`;
    if (Object.hasOwn(GLOBAL_FLAGS, flag)) return `"${name}": --${flag} is the lemma command's own`;
    if (!["boolean", "string", "number", "file"].includes(declared?.type as string)) return `"${name}": --${flag} needs a type`;
    if (declared.type === "boolean" && declared.multiple === true) return `"${name}": --${flag} is a boolean, which cannot repeat`;
    if (declared.short !== undefined) {
      if (!/^[a-zA-Z]$/.test(declared.short)) return `"${name}": -${declared.short} must be one letter`;
      if (declared.short === "h" || declared.short === "q" || shorts.has(declared.short)) return `"${name}": -${declared.short} is taken`;
      shorts.add(declared.short);
    }
  }
  return undefined;
};

/** A usage error: what was wrong with the words, for the person to fix. */
export interface ParseFailure {
  readonly error: string;
}

const flagByShort = (flags: Readonly<Record<string, FlagSpec>>, letter: string): string | undefined =>
  Object.entries(flags).find(([, flag]) => flag.short === letter)?.[0];

/** The candidate closest to `word` by edit distance, when close enough to be a typo of it. */
export const closest = (word: string, candidates: Iterable<string>): string | undefined => {
  let best: string | undefined;
  let distance = Math.max(2, Math.floor(word.length / 3)) + 1;
  for (const candidate of candidates) {
    const d = editDistance(word, candidate);
    if (d < distance) {
      best = candidate;
      distance = d;
    }
  }
  return best;
};

const editDistance = (a: string, b: string): number => {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
};

/**
 * A raw flag value as the spec reads it: a number from its text, a string
 * checked against its `values`. A `file` flag's value stays the path; the
 * client reads it (`CliFile`).
 */
const valueOf = (flag: string, spec: FlagSpec, raw: string): unknown | ParseFailure => {
  if (spec.type === "number") {
    const value = Number(raw);
    return raw.trim() === "" || !Number.isFinite(value) ? { error: `--${flag} must be a number, not "${raw}"` } : value;
  }
  if (spec.values !== undefined && !spec.values.includes(raw)) return { error: `--${flag} must be one of ${spec.values.join(", ")}, not "${raw}"` };
  return raw;
};

const failure = (value: unknown): value is ParseFailure => typeof value === "object" && value !== null && "error" in value;

/**
 * The input `words` give `spec` (the words after its path): flags anywhere
 * before `--`, `--name value`, `--name=value`, `-x value`, `-x` for a boolean,
 * and the rest positional, in order. A boolean flag is false unless given; a
 * repeatable one is an array, empty unless given; any other flag left out is
 * absent. A usage error says what was wrong.
 */
export const parseInput = (spec: Pick<CommandSpec, "path" | "args" | "flags">, words: readonly string[]): CliInput | ParseFailure => {
  const flagSpecs = spec.flags ?? {};
  const flags: Record<string, unknown> = {};
  for (const [name, flag] of Object.entries(flagSpecs)) {
    if (flag.type === "boolean") flags[name] = false;
    else if (flag.multiple === true) flags[name] = [];
  }
  const positionals: string[] = [];
  const set = (name: string, flag: FlagSpec, raw: string): ParseFailure | undefined => {
    const value = valueOf(name, flag, raw);
    if (failure(value)) return value;
    if (flag.multiple === true) (flags[name] as unknown[]).push(value);
    else flags[name] = value;
    return undefined;
  };
  const unknown = (written: string): ParseFailure => {
    const name = written.replace(/^-+/, "").split("=")[0]!;
    const near = closest(name, Object.keys(flagSpecs));
    return { error: `Unknown option ${written.split("=")[0]} for "lemma ${spec.path.join(" ")}"${near === undefined ? "" : `; did you mean --${near}?`}` };
  };
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word === "--") {
      positionals.push(...words.slice(i + 1));
      break;
    }
    if (word.startsWith("--") && word.length > 2) {
      const [name, inline] = splitOnce(word.slice(2), "=");
      const flag = flagSpecs[name];
      if (flag === undefined) return unknown(word);
      if (flag.type === "boolean") {
        if (inline === undefined) flags[name] = true;
        else if (/^(true|false)$/.test(inline)) flags[name] = inline === "true";
        else return { error: `--${name} takes no value, or true or false` };
        continue;
      }
      const raw = inline ?? words[++i];
      if (raw === undefined) return { error: `--${name} needs a value` };
      const problem = set(name, flag, raw);
      if (problem !== undefined) return problem;
      continue;
    }
    if (word.startsWith("-") && word.length > 1 && !/^-\d/.test(word)) {
      // `-abc` is three booleans, the last of which may take the next word.
      const letters = word.slice(1);
      for (let j = 0; j < letters.length; j++) {
        const name = flagByShort(flagSpecs, letters[j]!);
        if (name === undefined) return unknown(`-${letters[j]}`);
        const flag = flagSpecs[name]!;
        if (flag.type === "boolean") {
          flags[name] = true;
          continue;
        }
        const rest = letters.slice(j + 1);
        const raw = rest !== "" ? rest : words[++i];
        if (raw === undefined) return { error: `-${letters[j]} needs a value` };
        const problem = set(name, flag, raw);
        if (problem !== undefined) return problem;
        break;
      }
      continue;
    }
    positionals.push(word);
  }
  const args: Record<string, unknown> = {};
  const argSpecs = spec.args ?? [];
  for (const [index, arg] of argSpecs.entries()) {
    if (arg.variadic === true) {
      const rest = positionals.slice(index);
      if (arg.required === true && rest.length === 0) return { error: `"lemma ${spec.path.join(" ")}" needs <${arg.name}>` };
      args[arg.name] = rest;
      positionals.length = index;
      break;
    }
    const value = positionals[index];
    if (value === undefined) {
      if (arg.required === true) return { error: `"lemma ${spec.path.join(" ")}" needs <${arg.name}>` };
      continue;
    }
    args[arg.name] = value;
  }
  const taken = argSpecs.some((arg) => arg.variadic === true) ? positionals.length : argSpecs.length;
  if (positionals.length > taken) return { error: `Unexpected argument "${positionals[taken]}" for "lemma ${spec.path.join(" ")}"` };
  return { args, flags };
};

const splitOnce = (text: string, separator: string): [string, string | undefined] => {
  const at = text.indexOf(separator);
  return at === -1 ? [text, undefined] : [text.slice(0, at), text.slice(at + 1)];
};

/**
 * Whether `input` is what `spec` would parse to, as a host checks what a
 * client sends (a client may skip the parser): the arguments and flags it
 * declares, of their types, and nothing else. A usage error, or undefined.
 */
export const inputProblem = (spec: Pick<CommandSpec, "path" | "args" | "flags">, input: CliInput): string | undefined => {
  const name = `"lemma ${spec.path.join(" ")}"`;
  const argSpecs = spec.args ?? [];
  for (const key of Object.keys(input.args)) if (!argSpecs.some((arg) => arg.name === key)) return `${name} takes no argument <${key}>`;
  for (const arg of argSpecs) {
    const value = input.args[arg.name];
    if (value === undefined) {
      if (arg.required === true) return `${name} needs <${arg.name}>`;
      continue;
    }
    if (arg.variadic === true ? !(Array.isArray(value) && value.every((item) => typeof item === "string")) : typeof value !== "string")
      return `${name}: <${arg.name}> must be ${arg.variadic === true ? "a list of words" : "a word"}`;
  }
  const flagSpecs = spec.flags ?? {};
  for (const key of Object.keys(input.flags)) if (!Object.hasOwn(flagSpecs, key)) return `${name} takes no --${key}`;
  for (const [key, flag] of Object.entries(flagSpecs)) {
    const value = input.flags[key];
    if (value === undefined) continue;
    const one = (item: unknown): boolean => {
      switch (flag.type) {
        case "boolean":
          return typeof item === "boolean";
        case "number":
          return typeof item === "number" && Number.isFinite(item);
        case "string":
          return typeof item === "string" && (flag.values === undefined || flag.values.includes(item));
        case "file":
          return Schema.is(CliFile)(item);
      }
    };
    if (flag.multiple === true ? !(Array.isArray(value) && value.every(one)) : !one(value)) return `${name}: --${key} has the wrong kind of value`;
  }
  return undefined;
};

/** `<name>`, `[name]`, `<name…>`, or `[name…]`. */
const argUsage = (arg: ArgSpec): string => {
  const inner = `${arg.name}${arg.variadic === true ? "…" : ""}`;
  return arg.required === true ? `<${inner}>` : `[${inner}]`;
};

const flagUsage = (name: string, flag: FlagSpec): string =>
  `${flag.short === undefined ? "    " : `-${flag.short}, `}--${name}${flag.type === "boolean" ? "" : ` <${flag.placeholder ?? (flag.type === "file" ? "file" : flag.type === "number" ? "n" : "value")}>`}`;

/** Two columns: each name padded to the longest, then its text. */
export const columns = (rows: readonly (readonly [string, string])[], indent = "  "): string => {
  const width = Math.max(0, ...rows.map(([name]) => name.length));
  return rows.map(([name, text]) => `${indent}${name.padEnd(width)}  ${text}`.trimEnd()).join("\n");
};

/** The one line of usage: `lemma sessions show <id> [options]`. */
export const usageLine = (spec: Pick<CommandSpec, "path" | "args" | "flags">): string =>
  ["lemma", ...spec.path, ...(spec.args ?? []).map(argUsage), ...(Object.keys(spec.flags ?? {}).length > 0 ? ["[options]"] : [])].join(" ");

/** A command's own help: its usage, what it does, its arguments and options, examples, and where it comes from. */
export const renderHelp = (spec: CommandSpec & { readonly source?: string }): string => {
  const sections = [`Usage: ${usageLine(spec)}`, spec.summary];
  if (spec.description !== undefined) sections.push(spec.description);
  if ((spec.args ?? []).length > 0) sections.push(`Arguments:\n${columns((spec.args ?? []).map((arg) => [argUsage(arg), arg.description]))}`);
  const flags = Object.entries(spec.flags ?? {});
  if (flags.length > 0)
    sections.push(
      `Options:\n${columns(
        flags.map(([name, flag]) => [
          flagUsage(name, flag),
          `${flag.description}${flag.values === undefined ? "" : ` (${flag.values.join(", ")})`}${flag.multiple === true ? " (repeatable)" : ""}`,
        ]),
      )}`,
    );
  if ((spec.examples ?? []).length > 0) sections.push(`Examples:\n${(spec.examples ?? []).map((example) => `  ${example}`).join("\n")}`);
  sections.push(
    `Global options (any command): ${Object.keys(GLOBAL_FLAGS)
      .map((name) => `--${name}`)
      .join(", ")}; see lemma help.`,
  );
  if (spec.source !== undefined) sections.push(`Added by the plugin ${spec.source}.`);
  return sections.join("\n\n");
};

/** The global options' help. */
export const renderGlobalFlags = (): string =>
  columns(Object.entries(GLOBAL_FLAGS).map(([name, flag]) => [flagUsage(name, flag), `${flag.description}${flag.multiple === true ? " (repeatable)" : ""}`]));

/**
 * A JSON Schema (draft 2020-12) of what a command takes, `{ args, flags }`,
 * as `lemma help --json` shows it: an agent can build a call from it.
 */
export const inputJsonSchema = (spec: Pick<CommandSpec, "args" | "flags">): Record<string, unknown> => {
  const flagSchema = (flag: FlagSpec): Record<string, unknown> => {
    const one: Record<string, unknown> =
      flag.type === "boolean"
        ? { type: "boolean" }
        : flag.type === "number"
          ? { type: "number" }
          : flag.type === "file"
            ? { type: "string", description: "A path on the client's machine", ...(flag.accept === undefined ? {} : { contentMediaType: flag.accept }) }
            : { type: "string", ...(flag.values === undefined ? {} : { enum: flag.values }) };
    return flag.multiple === true ? { type: "array", items: one, description: flag.description } : { ...one, description: flag.description };
  };
  const args = spec.args ?? [];
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      args: {
        type: "object",
        properties: Object.fromEntries(
          args.map((arg) => [
            arg.name,
            arg.variadic === true
              ? { type: "array", items: { type: "string" }, description: arg.description }
              : { type: "string", description: arg.description },
          ]),
        ),
        required: args.filter((arg) => arg.required === true).map((arg) => arg.name),
        additionalProperties: false,
      },
      flags: {
        type: "object",
        properties: Object.fromEntries(Object.entries(spec.flags ?? {}).map(([name, flag]) => [name, flagSchema(flag)])),
        additionalProperties: false,
      },
    },
  };
};
