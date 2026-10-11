import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { resolvePaths } from "@lemma/host/paths";
import { CliError, ExitCode, usage } from "./command.ts";
import type { Io, Options, Output, Unattached } from "./command.ts";

/*
 * The CLI as a tool for writing plugins, against this checkout: `plugins new` makes a folder plugin to start from,
 * `plugins test` runs its tests (on Node's test runner, importing what the host would supply), `plugins check` starts
 * a host of its own with it and says what it does and what went wrong, and `dev` runs it in a host while it changes.
 */

/** The checkout this CLI runs from: its packages are what a plugin imports. */
const checkout = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const cliMain = fileURLToPath(new URL("./main.ts", import.meta.url));
/** Where `effect` is, as the CLI resolves it: pnpm keeps it beside the packages that use it, not at the checkout's root. */
const effectDir = (() => {
  let dir = dirname(fileURLToPath(import.meta.resolve("effect")));
  while (!existsSync(join(dir, "package.json")) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
})();

/** How a command runs another (`run` in cli.ts), with `io` changed: to read a host's answers as JSON. */
export type Runner = (argv: readonly string[], io: Io) => Promise<number>;

const fail = (code: string, message: string, exit: number = ExitCode.failed) => new CliError({ code, message, exit });

/** A plugin id: lowercase words, dot-separated (`notes`, `acme.review`). */
const ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;

/**
 * Each `@lemma/*` entry of the checkout, by import specifier, as the source file it resolves to (the `lemma-source`
 * export): what an editor type-checks a plugin's imports against, as the host runs them.
 */
export const checkoutModules = (): Record<string, string> => {
  const packages = [
    ...readdirSync(join(checkout, "packages")).map((name) => join(checkout, "packages", name)),
    ...readdirSync(join(checkout, "domains")).flatMap((domain) => {
      const dir = join(checkout, "domains", domain);
      return existsSync(join(dir, "README.md")) ? readdirSync(dir).map((name) => join(dir, name)) : [];
    }),
  ];
  const modules: Record<string, string> = {};
  for (const dir of packages) {
    let manifest: { readonly name?: string; readonly exports?: Record<string, unknown> };
    try {
      manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch {
      continue;
    }
    if (manifest.name?.startsWith("@lemma/") !== true || manifest.exports === undefined) continue;
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      const file = typeof target === "string" ? target : (target as Record<string, unknown>)["lemma-source"];
      if (typeof file !== "string") continue;
      modules[subpath === "." ? manifest.name : `${manifest.name}${subpath.slice(1)}`] = join(dir, file);
    }
  }
  return modules;
};

/** `effect`'s entries, each as the declarations beside the file it exports. */
const effectModules = (): Record<string, string[]> => {
  const { exports = {} } = JSON.parse(readFileSync(join(effectDir, "package.json"), "utf8")) as { readonly exports?: Record<string, unknown> };
  return Object.fromEntries(
    Object.entries(exports).flatMap(([subpath, target]) =>
      typeof target === "string" && target.endsWith(".js")
        ? [[subpath === "." ? "effect" : `effect${subpath.slice(1)}`, [join(effectDir, target.replace(/\.js$/, ".d.ts"))]]]
        : [],
    ),
  );
};

const scaffold = (id: string): Record<string, string> => {
  const tool = id.replace(/[^a-z0-9]+/g, "_");
  const modules = checkoutModules();
  return {
    "package.json": `${JSON.stringify({ name: id, version: "0.1.0", private: true, type: "module", lemma: { host: "./plugin.ts", web: "./web.js" } }, null, 2)}\n`,
    "plugin.ts": `import { Schema } from "effect";
import { definePlugin } from "@lemma/core/plain";
import { ToolResult, Tools } from "@lemma/tools";

/**
 * The host half of ${id}: a tool the model can call. Its imports are the host's own packages (effect, @lemma/core,
 * the domains' contracts), so it needs no install step.
 */
export default definePlugin({
  id: "${id}",
  setup: (_, { add }) => {
    add(Tools, {
      name: "${tool}",
      description: "Says hello to someone by name.",
      input: Schema.Struct({ name: Schema.String }),
      execute: ({ name }) => new ToolResult({ content: [{ type: "text", text: \`Hello, \${name}!\` }] }),
    });
  },
});
`,
    "web.js": `// The web half of ${id}: it runs in the web app while the host half does, and its default export receives the app's
// api: defineWebPlugin, the contracts, Solid, and html (Solid's JSX without a build step).
export default ({ defineWebPlugin, contracts: { Slots, SidebarFooter }, html }) =>
  defineWebPlugin({
    id: "${id}",
    requires: { slots: Slots },
    setup: ({ slots }) => {
      slots.add(SidebarFooter, { id: "${id}", order: 90, component: () => html\`<span class="muted small">${id}</span>\` });
    },
  });
`,
    "tests/plugin.test.ts": `import assert from "node:assert/strict";
import { test } from "node:test";
import { call, callTools, reply, testHost } from "@lemma/test-host";
import plugin from "../plugin.ts";

test("the model can call its tool, and reads what it says", async () => {
  const host = await testHost({ plugins: [plugin], model: [callTools(call("${tool}", { name: "Ada" })), reply("Done.")] });
  try {
    const turn = await host.prompt("say hello to Ada");
    const result = turn.requests[1]?.messages.find((message) => message.role === "toolResult");
    assert.deepEqual(result?.content, [{ type: "text", text: "Hello, Ada!" }]);
  } finally {
    await host.close();
  }
});
`,
    "tsconfig.json": `${JSON.stringify(
      {
        // This checkout's compiler settings and packages, as the host supplies them: \`lemma plugins new\` wrote these
        // for ${checkout}. The settings are the checkout's, as its sources are type-checked through \`paths\` with them.
        extends: join(checkout, "tsconfig.base.json"),
        compilerOptions: {
          typeRoots: [join(checkout, "node_modules/@types")],
          paths: {
            ...Object.fromEntries(Object.entries(modules).map(([specifier, file]) => [specifier, [file]])),
            ...effectModules(),
          },
        },
        include: ["*.ts", "tests"],
      },
      null,
      2,
    )}\n`,
    "README.md": `# ${id}

What it does, for whoever turns it on: here, a \`${tool}\` tool the model can call, and a line in the web app's
sidebar while it runs.

| File                   | What it is                                                        |
| ---------------------- | ----------------------------------------------------------------- |
| \`plugin.ts\`            | The host half: what the host runs (tools, hooks, a prompt section) |
| \`web.js\`               | The web half: what the web app runs (views, slots, parts)         |
| \`tests/plugin.test.ts\` | Its tests: real turns against a scripted model                    |

- \`lemma dev\` (in this folder): runs it in your host, and again on every change (\`--isolated\`: in a host of its own).
- \`lemma plugins test\`: runs its tests.
- \`lemma plugins check\`: starts a host of its own with it, and says what it does and what went wrong.

See [Writing plugins](${join(checkout, "docs/plugins.md")}).
`,
  };
};

/** `lemma plugins new <id>`: a folder plugin to start from, in `--path` or `./<id>`. */
export const newPlugin = (id: string | undefined, io: Io, options: Options): Unattached | CliError => {
  if (id === undefined) return usage("plugins new needs a plugin id");
  if (!ID.test(id)) return usage(`"${id}" is not a plugin id: lowercase words, dot-separated (notes, acme.review)`);
  const folder = resolve(io.cwd, options.path ?? id);
  return {
    unattached: Effect.tryPromise({
      try: async () => {
        if (existsSync(folder) && (await readdir(folder)).length > 0) throw fail("Exists", `${folder} is not empty`);
        const files = scaffold(id);
        for (const [name, text] of Object.entries(files)) {
          await mkdir(dirname(join(folder, name)), { recursive: true });
          await writeFile(join(folder, name), text);
        }
        const near = relative(io.cwd, folder);
        const where = near === "" ? "." : near.startsWith("..") ? folder : near;
        return {
          json: { id, folder, files: Object.keys(files) },
          text: [
            `made ${id} in ${where}: ${Object.keys(files).join(", ")}`,
            `  lemma dev ${where}            run it in your host, and again on every change`,
            `  lemma plugins test ${where}   run its tests`,
            `  lemma plugins check ${where}  start a host with it, and say what it does`,
          ].join("\n"),
        } satisfies Output;
      },
      catch: (error) => (error instanceof CliError ? error : fail("Failed", `Could not make ${folder}: ${String(error)}`)),
    }),
  };
};

/** Every test file under `folder`, but in node_modules. */
const testFiles = async (folder: string): Promise<string[]> => {
  const found: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.test\.(ts|js|mjs)$/.test(entry.name)) found.push(path);
    }
  };
  await walk(folder);
  return found.sort();
};

/** Runs `node args` with the terminal's output, and resolves with its exit code; interrupting the effect stops it. */
const node = (args: readonly string[], env: NodeJS.ProcessEnv) =>
  Effect.callback<number>((resume) => {
    const child = spawn(process.execPath, [...args], { stdio: "inherit", env });
    child.on("exit", (code, signal) => resume(Effect.succeed(code ?? (signal === null ? 1 : ExitCode.interrupted))));
    child.on("error", () => resume(Effect.succeed(ExitCode.failed)));
    return Effect.sync(() => void child.kill("SIGTERM"));
  });

/** `lemma plugins test [folder]`: its tests, on Node's test runner, importing what the host supplies as the host does. */
export const testPlugin = (dir: string | undefined, io: Io): Unattached => {
  const folder = resolve(io.cwd, dir ?? ".");
  return {
    unattached: Effect.gen(function* () {
      const files = yield* Effect.promise(() => testFiles(folder));
      if (files.length === 0) return yield* fail("NoTests", `No tests in ${folder}: name a file *.test.ts`);
      const register = new URL("./register.ts", import.meta.url).href;
      const code = yield* node(["--conditions=lemma-source", "--import", register, "--test", ...files], { ...process.env, ...io.env });
      return {
        json: { files, exit: code },
        text: code === 0 ? `${files.length} test file${files.length === 1 ? "" : "s"} passed` : "tests failed",
        exit: code,
      };
    }),
  };
};

/** A host of its own, in `home`, until the scope closes: its output lines, and how it ended if it did. */
const hostIn = (home: string, env: Readonly<Record<string, string | undefined>>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const lines: string[] = [];
      let ended: number | undefined;
      const child: ChildProcess = spawn(process.execPath, ["--conditions=lemma-source", cliMain, "serve", "--no-open"], {
        env: { ...process.env, ...env, LEMMA_HOME: home, LEMMA_URL: undefined, LEMMA_TOKEN: undefined } as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const hear = (chunk: Buffer) => lines.push(...String(chunk).split("\n").filter(Boolean));
      child.stdout?.on("data", hear);
      child.stderr?.on("data", hear);
      child.on("exit", (code) => {
        ended = code ?? 1;
      });
      return { child, lines, ended: () => ended };
    }),
    ({ child }) =>
      Effect.promise(
        () =>
          new Promise<void>((done) => {
            if (child.exitCode !== null || child.signalCode !== null) return done();
            child.once("exit", () => done());
            child.kill("SIGTERM");
          }),
      ),
  );

/** Waits for a host started with `hostIn` to say where it serves, or to end. */
const started = (host: { readonly lines: readonly string[]; readonly ended: () => number | undefined }) =>
  Effect.gen(function* () {
    for (let waited = 0; waited < 600; waited++) {
      if (host.lines.some((line) => line.startsWith("lemma: open "))) return true;
      if (host.ended() !== undefined) return false;
      yield* Effect.sleep("50 millis");
    }
    return false;
  });

/** Links `folder` into `home`'s plugins directory, until the scope closes; refuses to replace what is there. */
const linked = (folder: string, home: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const dir = join(home, "plugins");
        await mkdir(dir, { recursive: true });
        const link = join(dir, basename(folder));
        const there = await lstat(link).catch(() => undefined);
        if (there !== undefined) {
          const points = there.isSymbolicLink() ? resolve(dir, await readlink(link)) : undefined;
          if (points !== folder) throw fail("Exists", `${link} is there already; move it, or name the folder otherwise`);
          return { link, ours: false };
        }
        await symlink(folder, link, "dir");
        return { link, ours: true };
      },
      catch: (error) => (error instanceof CliError ? error : fail("Failed", `Could not link ${folder}: ${String(error)}`)),
    }),
    ({ link, ours }) => (ours ? Effect.promise(() => rm(link, { force: true })) : Effect.void),
  );

/** A home of its own, removed when the scope closes; its config serves on a free port. */
const tempHome = Effect.acquireRelease(
  Effect.promise(async () => {
    const home = await mkdtemp(join(tmpdir(), "lemma-dev-"));
    await writeFile(join(home, "config.jsonc"), `${JSON.stringify({ plugins: { "transport.server": { config: { port: 0 } } } }, null, 2)}\n`);
    return home;
  }),
  (home) => Effect.promise(() => rm(home, { recursive: true, force: true })),
);

/** The plugins `folder` makes, by what a host lists from it, with what each does. */
interface Checked {
  readonly id: string;
  readonly state: string;
  readonly fault?: string;
  readonly provides: readonly string[];
  readonly requires: readonly string[];
  readonly hooks: readonly string[];
  readonly adds: readonly string[];
  readonly warnings: readonly string[];
}

/** Runs `argv` against the host in `home` and reads its JSON answer. */
const ask = (run: Runner, io: Io, home: string, argv: readonly string[]) =>
  Effect.promise(async () => {
    let out = "";
    let err = "";
    const code = await run([...argv, "--json"], {
      ...io,
      env: { ...io.env, LEMMA_HOME: home, LEMMA_URL: undefined, LEMMA_TOKEN: undefined },
      out: (text) => void (out += `${text}\n`),
      err: (text) => void (err += `${text}\n`),
    });
    return code === 0 ? (JSON.parse(out) as unknown) : { error: err.trim() };
  });

/** `lemma plugins check [folder]`: a host of its own with the plugin in it, then what it made of it, and stopped. */
export const checkPlugin = (dir: string | undefined, io: Io, run: Runner): Unattached => {
  const folder = resolve(io.cwd, dir ?? ".");
  return {
    unattached: Effect.gen(function* () {
      if (!existsSync(join(folder, "package.json")) && !existsSync(folder)) return yield* fail("NotFound", `${folder} does not exist`);
      const home = yield* tempHome;
      yield* linked(folder, home);
      const host = yield* hostIn(home, io.env);
      if (!(yield* started(host))) {
        // What it says to do about it, but its advice to start without plugin files, which is no help here.
        const said = host.lines.filter((line) => !line.startsWith("lemma: --safe"));
        return {
          json: { started: false, output: said },
          text: ["The host did not start with it:", ...said.map((line) => `  ${line}`)].join("\n"),
          exit: ExitCode.failed,
        };
      }
      const plugins = (yield* ask(run, io, home, ["plugins"])) as readonly {
        readonly id: string;
        readonly source: string;
        readonly state?: string;
        readonly enabled: boolean;
        readonly fault?: { readonly message: string };
        readonly provides: readonly string[];
        readonly requires: readonly string[];
        readonly hooks?: readonly { readonly name: string }[];
        readonly contributes?: readonly { readonly name: string; readonly keys: readonly string[] }[];
      }[];
      const own = plugins.filter((plugin) => plugin.source === "user");
      const checked: Checked[] = own.map((plugin) => ({
        id: plugin.id,
        state: plugin.state ?? (plugin.enabled ? "not loaded" : "off"),
        ...(plugin.fault === undefined ? {} : { fault: plugin.fault.message }),
        provides: plugin.provides,
        requires: plugin.requires,
        hooks: (plugin.hooks ?? []).map((hook) => hook.name),
        adds: (plugin.contributes ?? []).map((contribution) => `${contribution.name}: ${contribution.keys.join(", ")}`),
        warnings: host.lines
          .filter((line) => line.includes(`[${plugin.id}]`) || line.includes(`"${plugin.id}"`))
          .filter((line) => /warning|error|fail/.test(line)),
      }));
      const manifest = JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as { readonly lemma?: { readonly web?: string } };
      const web = manifest.lemma?.web;
      const problems = [
        ...(own.length === 0 ? [`No host half loaded from ${folder}: see the host's output below`] : []),
        ...(web !== undefined && !existsSync(join(folder, web)) ? [`Its web half ${web} does not exist`] : []),
        ...(web !== undefined && own.length > 0 && !own.some((plugin) => plugin.id === basename(folder))
          ? [
              `Its folder is named ${basename(folder)}, its plugin ${own.map((plugin) => plugin.id).join(", ")}: name the folder for its plugin, so the host knows its web half's id`,
            ]
          : []),
        ...checked.flatMap((plugin) =>
          plugin.state === "active" ? [] : [`${plugin.id} is ${plugin.state}${plugin.fault === undefined ? "" : `: ${plugin.fault}`}`],
        ),
      ];
      const text = [
        ...checked.flatMap((plugin) => [
          `${plugin.id}: ${plugin.state}`,
          ...(plugin.provides.length === 0 ? [] : [`  provides ${plugin.provides.join(", ")}`]),
          ...(plugin.requires.length === 0 ? [] : [`  requires ${plugin.requires.join(", ")}`]),
          ...(plugin.hooks.length === 0 ? [] : [`  handles ${plugin.hooks.join(", ")}`]),
          ...plugin.adds.map((added) => `  adds ${added}`),
          ...plugin.warnings.map((line) => `  ${line}`),
        ]),
        ...(web === undefined ? [] : [`web half: ${web}`]),
        ...(problems.length === 0 ? ["no problems found"] : ["problems:", ...problems.map((problem) => `  ${problem}`)]),
        ...(own.length === 0 ? host.lines.map((line) => `  ${line}`) : []),
      ].join("\n");
      return { json: { plugins: checked, web, problems }, text, ...(problems.length === 0 ? {} : { exit: ExitCode.failed }) } satisfies Output;
    }),
  };
};

/**
 * `lemma dev <folder> [--isolated]`: the plugin in a host until Ctrl-C, which reloads it on every change. Linked
 * into the home's plugins directory: a host running there loads it at once; with none, or `--isolated` (a home of its
 * own: no sessions, providers, or config of yours), one runs here. Ctrl-C unlinks it.
 */
export const devPlugin = (dir: string | undefined, io: Io, options: { readonly isolated: boolean }, run: Runner): Unattached => {
  const folder = resolve(io.cwd, dir ?? ".");
  return {
    unattached: Effect.gen(function* () {
      if (!existsSync(folder)) return yield* fail("NotFound", `${folder} does not exist`);
      const home = options.isolated ? yield* tempHome : resolvePaths({ env: io.env, cwd: io.cwd }).home;
      const { link } = yield* linked(folder, home);
      const running = !options.isolated && (yield* Effect.promise(() => run(["status", "--json"], { ...io, out: () => {}, err: () => {} }))) === 0;
      if (running) {
        io.err(`lemma: linked ${folder} as ${link}; the running host loads it now and on every change. Ctrl-C unlinks it.`);
        yield* Effect.sleep("1 second");
        const shown = (yield* ask(run, io, home, ["plugins"])) as readonly { readonly id: string; readonly source: string; readonly state?: string }[];
        for (const plugin of shown.filter((candidate) => candidate.source === "user")) io.err(`lemma: ${plugin.id} is ${plugin.state ?? "not loaded"}`);
        return yield* Effect.never;
      }
      io.err(`lemma: linked ${folder} as ${link}; running a host${options.isolated ? " in a home of its own" : ""} until Ctrl-C.`);
      const host = yield* hostIn(home, io.env);
      // Its output, as it comes.
      let shownLines = 0;
      for (;;) {
        for (; shownLines < host.lines.length; shownLines++) io.err(host.lines[shownLines]!);
        if (host.ended() !== undefined) return { json: { exit: host.ended() }, text: "the host stopped", exit: host.ended()! } satisfies Output;
        yield* Effect.sleep("100 millis");
      }
    }),
  };
};
