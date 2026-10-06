import { readFile, readlink, realpath, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Effect, Either, ParseResult, Schema } from "effect";
import { applyEdits, modify, parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";
import { ConfigFile } from "@lemma/contracts";
import { isInside, kindOf, writeFileAtomic } from "@lemma/contracts/fs";
import type { ConfigScope, PluginChange, PluginRow } from "@lemma/contracts";
import { Diagnostic } from "@lemma/core";
import type { Composition, PluginEntry } from "@lemma/core";
import type { PathsService } from "./paths.ts";

import { HOST_PLUGIN_ID } from "./catalog.ts";

export { HOST_PLUGIN_ID };

export interface LoadedComposition {
  /** Always contains the `host` row carrying `paths`; the host plugin cannot be disabled by a file. */
  readonly composition: Composition;
  /** Errors (unreadable or invalid files) and warnings. Every message names the file. */
  readonly diagnostics: readonly Diagnostic[];
  /** The files consulted, in merge order (user first), and whether each existed. */
  readonly files: readonly { readonly path: string; readonly found: boolean }[];
  /** Whether the user file's `trustedProjects` covers `paths.cwd`. Only a trusted project's file and plugins load. */
  readonly trusted: boolean;
  /** Per plugin id, the file whose row sets `enabled` (the project's wins), so a change can target the file that decides. */
  readonly enabledIn: Readonly<Record<string, ConfigScope>>;
  /** Per plugin id, the file whose row sets `config`. */
  readonly configIn: Readonly<Record<string, ConfigScope>>;
  /** The `ui` section, merged the same way: rows for the web app's plugins. */
  readonly ui: MergedRows;
}

export interface MergedRows {
  readonly plugins: Readonly<Record<string, PluginRow>>;
  readonly enabledIn: Readonly<Record<string, ConfigScope>>;
  readonly configIn: Readonly<Record<string, ConfigScope>>;
}

/** Which part of a config file rows live in: the host's plugins, or the web app's. */
export type ConfigSection = "plugins" | "ui";

/** Project rows override user rows by plugin id: `enabled` and `config` are each taken from the project row when present. */
function mergeRows(files: readonly { readonly scope: ConfigScope; readonly rows: Readonly<Record<string, PluginRow>> }[]): MergedRows {
  const plugins: Record<string, PluginRow> = {};
  const enabledIn: Record<string, ConfigScope> = {};
  const configIn: Record<string, ConfigScope> = {};
  for (const { scope, rows } of files) {
    for (const [id, row] of Object.entries(rows)) {
      // JSON cannot express undefined, so decoded rows only carry the keys the file wrote.
      plugins[id] = { ...plugins[id], ...row };
      if (row.enabled !== undefined) enabledIn[id] = scope;
      if (row.config !== undefined) configIn[id] = scope;
    }
  }
  return { plugins, enabledIn, configIn };
}

/** `<cwd>/.lemma/plugins`: plugin files that load only in a trusted project. */
export const projectPluginsDir = (paths: PathsService): string => join(dirname(paths.projectConfig), "plugins");

/** A directory is trusted when it is, or is inside, an absolute entry of `trustedProjects`. */
export function isTrusted(cwd: string, trustedProjects: readonly string[]): boolean {
  return trustedProjects.some((entry) => isAbsolute(entry) && isInside(entry, cwd));
}

/**
 * Reads and merges the user and project config files. The project file is read
 * only when the user file trusts the project: a cloned repository must not be
 * able to run plugins, rebind the transport, or redirect provider keys just by
 * being the working directory. Project rows override
 * user rows by plugin id: `enabled` and `config` are each taken from the project
 * row when present, and a `config` object replaces the user's whole object.
 * Missing files are normal; malformed ones are reported and skipped, so the
 * result is usable for diagnostics even when it must not be applied.
 */
export function loadComposition(paths: PathsService): Effect.Effect<LoadedComposition> {
  return Effect.gen(function* () {
    const user = yield* readConfig(paths.userConfig);
    const trusted = isTrusted(paths.cwd, user.trustedProjects);
    const project = trusted ? yield* readConfig(paths.projectConfig) : yield* skipConfig(paths.projectConfig);
    const diagnostics = [...user.diagnostics, ...project.diagnostics];
    if (!trusted && (project.found || (yield* exists(projectPluginsDir(paths))))) {
      diagnostics.push(
        new Diagnostic({
          severity: "warning",
          message: `${dirname(paths.projectConfig)}: project config and plugins are ignored because ${paths.cwd} is not trusted`,
          suggestion: `If you trust this project, add "${paths.cwd}" to "trustedProjects" in ${paths.userConfig}`,
        }),
      );
    }
    if (project.trustedProjects.length > 0) {
      diagnostics.push(
        new Diagnostic({
          severity: "warning",
          message: `${paths.projectConfig}: "trustedProjects" is ignored; only ${paths.userConfig} can grant trust`,
          suggestion: `Remove "trustedProjects" from the project file`,
        }),
      );
    }
    for (const file of [user, project]) {
      if (file.plugins[HOST_PLUGIN_ID] !== undefined) {
        diagnostics.push(
          new Diagnostic({
            severity: "warning",
            pluginId: HOST_PLUGIN_ID,
            message: `${file.path}: the "${HOST_PLUGIN_ID}" row is ignored; the host plugin is always loaded with the resolved paths`,
            suggestion: `Remove the "${HOST_PLUGIN_ID}" row`,
          }),
        );
      }
    }
    const withoutHost = (rows: Readonly<Record<string, PluginRow>>) => Object.fromEntries(Object.entries(rows).filter(([id]) => id !== HOST_PLUGIN_ID));
    const merged = mergeRows([
      { scope: "user", rows: withoutHost(user.plugins) },
      { scope: "project", rows: withoutHost(project.plugins) },
    ]);
    const plugins: Record<string, PluginEntry> = { ...(merged.plugins as Record<string, PluginEntry>), [HOST_PLUGIN_ID]: { config: paths } };
    return {
      composition: { plugins },
      diagnostics,
      files: [
        { path: user.path, found: user.found },
        { path: project.path, found: project.found },
      ],
      trusted,
      enabledIn: merged.enabledIn,
      configIn: merged.configIn,
      ui: mergeRows([
        { scope: "user", rows: user.ui },
        { scope: "project", rows: project.ui },
      ]),
    };
  });
}

const FORMAT = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The config text with each plugin's row updated in place, keeping comments and
 * other rows. A key present in `row` is written, and a row left with no keys is
 * removed. In the user file `enabled: true` is the default, so it removes the
 * key; in the project file it is written out, because only an explicit `true`
 * overrides a user row that says `false`. `values` edits single keys of the
 * row's `config` (null removes one), dropping a `config` left empty. `add`
 * and `remove` edit list keys by their items' `id`. The text must be valid
 * JSONC (or empty); check with `parseConfig` first.
 */
export function patchConfig(
  text: string,
  rows: Readonly<Record<string, PluginChange>>,
  scope: ConfigScope = "user",
  section: ConfigSection = "plugins",
): string {
  let next = text;
  const rowOf = (id: string): Record<string, unknown> => {
    const current: unknown = parseJsonc(next, [], { allowTrailingComma: true })?.[section]?.[id];
    return isObject(current) ? { ...current } : {};
  };
  for (const [id, row] of Object.entries(rows)) {
    const edits: Record<string, unknown> = {};
    if (row.enabled !== undefined) edits.enabled = row.enabled && scope === "user" ? undefined : row.enabled;
    if (row.config !== undefined) edits.config = row.config;
    const before = rowOf(id);
    for (const [key, value] of Object.entries(edits)) {
      if (value === undefined && !(key in before)) continue;
      next = applyEdits(next, modify(next, [section, id, key], value, FORMAT));
    }
    if (row.values !== undefined) {
      if (!isObject(rowOf(id).config)) next = applyEdits(next, modify(next, [section, id, "config"], {}, FORMAT));
      for (const [key, value] of Object.entries(row.values)) {
        const config = rowOf(id).config;
        if (value === null && !(isObject(config) && key in config)) continue;
        next = applyEdits(next, modify(next, [section, id, "config", key], value === null ? undefined : value, FORMAT));
      }
      const config = rowOf(id).config;
      if (isObject(config) && Object.keys(config).length === 0) next = applyEdits(next, modify(next, [section, id, "config"], undefined, FORMAT));
    }
    const list = (key: string): unknown[] => {
      const config = rowOf(id).config;
      const value = isObject(config) ? config[key] : undefined;
      return Array.isArray(value) ? value : [];
    };
    const indexOf = (key: string, itemId: unknown) => list(key).findIndex((item) => isObject(item) && item.id === itemId);
    for (const [key, items] of Object.entries(row.add ?? {})) {
      if (!isObject(rowOf(id).config)) next = applyEdits(next, modify(next, [section, id, "config"], {}, FORMAT));
      if (!Array.isArray((rowOf(id).config as Record<string, unknown>)[key])) next = applyEdits(next, modify(next, [section, id, "config", key], [], FORMAT));
      for (const item of items) {
        const at = indexOf(key, item.id);
        next =
          at === -1
            ? applyEdits(next, modify(next, [section, id, "config", key, list(key).length], item, { ...FORMAT, isArrayInsertion: true }))
            : applyEdits(next, modify(next, [section, id, "config", key, at], item, FORMAT));
      }
    }
    for (const [key, ids] of Object.entries(row.remove ?? {})) {
      for (const itemId of ids) {
        const at = indexOf(key, itemId);
        if (at !== -1) next = applyEdits(next, modify(next, [section, id, "config", key, at], undefined, FORMAT));
      }
    }
    const rows: unknown = parseJsonc(next, [], { allowTrailingComma: true })?.[section];
    if (isObject(rows) && isObject(rows[id]) && Object.keys(rows[id]).length === 0) next = applyEdits(next, modify(next, [section, id], undefined, FORMAT));
  }
  return next;
}

/** The file's text, or undefined when it does not exist. */
export const readConfigText = (path: string): Effect.Effect<string | undefined, Diagnostic> =>
  Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: (cause) => cause as NodeJS.ErrnoException }).pipe(
    Effect.catchIf(
      (error) => error.code === "ENOENT",
      () => Effect.succeed(undefined),
    ),
    Effect.mapError(
      (error) => new Diagnostic({ severity: "error", message: `${path}: cannot read config: ${error.message}`, suggestion: "Fix the file's permissions" }),
    ),
  );

export interface ConfigUpdate {
  /** What the file holds now. */
  readonly text: string;
  /** What it held before; undefined when it did not exist. */
  readonly previous: string | undefined;
  /** Puts the file back as it was (removing it if it did not exist). Never fails; a file that cannot be restored is left as written. */
  readonly restore: Effect.Effect<void>;
}

/**
 * Where a config file's text goes: the file a link at `path` points to (a
 * config kept in a dotfiles repository stays linked), with the mode it has
 * (0600 for a new one: rows may hold provider settings).
 */
const destination = async (path: string): Promise<{ readonly file: string; readonly mode: number }> => {
  // A link to a file not made yet (`realpath` fails) still names it: write there, so the link stays.
  const file = await realpath(path).catch(() =>
    readlink(path).then(
      (target) => resolve(dirname(path), target),
      () => path,
    ),
  );
  const mode = await stat(file).then(
    (info) => info.mode & 0o777,
    () => 0o600,
  );
  return { file, mode };
};

/**
 * Writes the file whole or not at all (a crash mid-write cannot leave a
 * truncated config, which the host would refuse to start with), creating its
 * directory as `mkdir` would.
 */
const writeConfig = async (path: string, text: string): Promise<void> => {
  const { file, mode } = await destination(path);
  await writeFileAtomic(file, text, { mode, dirMode: 0o777, sync: true });
};

/** Applies `patchConfig` to the file at `path`, creating it and its directory if needed. */
export function updateConfig(
  path: string,
  rows: Readonly<Record<string, PluginChange>>,
  scope: ConfigScope = "user",
  section: ConfigSection = "plugins",
): Effect.Effect<ConfigUpdate, Diagnostic> {
  return Effect.gen(function* () {
    const previous = yield* readConfigText(path);
    if (previous !== undefined && previous.trim() !== "") yield* parseConfig(path, previous);
    const text = patchConfig(previous ?? "", rows, scope, section);
    yield* Effect.tryPromise({
      try: () => writeConfig(path, text),
      catch: (cause) =>
        new Diagnostic({
          severity: "error",
          message: `${path}: cannot write config: ${cause instanceof Error ? cause.message : String(cause)}`,
          suggestion: "Fix the directory's permissions",
        }),
    });
    return {
      text,
      previous,
      // A file this made goes again (through a link, the file it points to, so the link stays); one it changed is put back.
      restore: Effect.tryPromise(async () => (previous === undefined ? unlink((await destination(path)).file) : writeConfig(path, previous))).pipe(
        Effect.ignore,
      ),
    };
  });
}

interface ReadConfig {
  readonly path: string;
  readonly found: boolean;
  readonly plugins: NonNullable<ConfigFile["plugins"]>;
  readonly ui: NonNullable<ConfigFile["ui"]>;
  readonly trustedProjects: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

const exists = (path: string): Effect.Effect<boolean> => Effect.promise(async () => (await kindOf(path)) !== undefined);

/** An untrusted project's file: only whether it exists, never its contents. */
const skipConfig = (path: string): Effect.Effect<ReadConfig> =>
  Effect.map(exists(path), (found) => ({ path, found, plugins: {}, ui: {}, trustedProjects: [], diagnostics: [] }));

const readConfig = (path: string): Effect.Effect<ReadConfig> =>
  Effect.gen(function* () {
    const empty = (found: boolean, diagnostics: readonly Diagnostic[] = []): ReadConfig => ({
      path,
      found,
      plugins: {},
      ui: {},
      trustedProjects: [],
      diagnostics,
    });
    const text = yield* Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: (cause) => cause as NodeJS.ErrnoException }).pipe(Effect.either);
    if (Either.isLeft(text)) {
      if (text.left.code === "ENOENT") return empty(false);
      return empty(true, [
        new Diagnostic({
          severity: "error",
          message: `${path}: cannot read config: ${text.left.message}`,
          suggestion: "Fix the file's permissions or remove it",
        }),
      ]);
    }
    const parsed = parseConfig(path, text.right);
    if (Either.isLeft(parsed)) return empty(true, [parsed.left]);
    return {
      path,
      found: true,
      plugins: parsed.right.plugins ?? {},
      ui: parsed.right.ui ?? {},
      trustedProjects: parsed.right.trustedProjects ?? [],
      diagnostics: [],
    };
  });

/** JSONC with comments and trailing commas; anything else the parser recovers from is still an error here. */
export function parseConfig(path: string, text: string): Either.Either<ConfigFile, Diagnostic> {
  const errors: ParseError[] = [];
  const value: unknown = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) {
    const first = errors[0]!;
    const { line, column } = position(text, first.offset);
    return Either.left(
      new Diagnostic({
        severity: "error",
        message: `${path}:${line}:${column}: ${printParseErrorCode(first.error)}`,
        suggestion: "Fix the JSONC syntax (comments and trailing commas are allowed)",
      }),
    );
  }
  const decoded = Schema.decodeUnknownEither(ConfigFile)(value);
  if (Either.isLeft(decoded)) {
    const issue = ParseResult.ArrayFormatter.formatErrorSync(decoded.left)[0];
    const at = issue?.path.filter((segment): segment is string | number => typeof segment !== "symbol") ?? [];
    return Either.left(
      new Diagnostic({
        severity: "error",
        ...(typeof at[1] === "string" ? { pluginId: at[1] } : {}),
        path: at,
        message: `${path}: invalid config at ${at.length ? at.join(".") : "root"}: ${issue?.message ?? ParseResult.TreeFormatter.formatErrorSync(decoded.left)}`,
        suggestion: `Expected { "trustedProjects"?: string[], "plugins"?: { "<id>": { "enabled"?: boolean, "config"?: unknown } }, "ui"?: { "<id>": { … } } }`,
      }),
    );
  }
  return Either.right(decoded.right);
}

function position(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - before.lastIndexOf("\n");
  return { line, column };
}
