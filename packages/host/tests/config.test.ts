import { describe, expect, test } from "vitest";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { parse as parseJsonc } from "jsonc-parser";
import { isTrusted, loadComposition, patchConfig, projectPluginsDir, updateConfig } from "../src/config.ts";
import { buildKind, defaultRoot, homeForTools, otherHomeProblem, resolvePaths } from "../src/paths.ts";
import type { PathsService } from "../src/paths.ts";

async function withPaths<A>(body: (paths: PathsService) => Promise<A>): Promise<A> {
  const root = await mkdtemp(join(tmpdir(), "lemma-host-"));
  try {
    const paths = resolvePaths({ env: { LEMMA_HOME: join(root, "home") }, cwd: join(root, "project") });
    await mkdir(paths.home, { recursive: true });
    await mkdir(join(paths.cwd, ".lemma"), { recursive: true });
    return await body(paths);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("resolvePaths", () => {
  test("defaults to ~/.lemma and derives every location", () => {
    const paths = resolvePaths({ env: { HOME: "/home/me" }, cwd: "/work/app", kind: "release" });
    expect(paths).toEqual({
      home: "/home/me/.lemma",
      root: "/home/me/.lemma",
      userConfig: "/home/me/.lemma/config.jsonc",
      projectConfig: "/work/app/.lemma/config.jsonc",
      cwd: "/work/app",
    });
  });

  test("run from a checkout, as these tests are, defaults to ~/.lemma-dev", () => {
    expect(buildKind).toBe("checkout");
    expect(resolvePaths({ env: { HOME: "/home/me" }, cwd: "/work/app" }).root).toBe("/home/me/.lemma-dev");
    expect(resolvePaths({ env: { HOME: "/home/me", LEMMA_PROFILE: "desk" }, cwd: "/work/app" }).home).toBe("/home/me/.lemma-dev/profiles/desk");
  });

  test("LEMMA_HOME overrides the home directory", () => {
    const paths = resolvePaths({ env: { HOME: "/home/me", LEMMA_HOME: "/var/lemma" }, cwd: "/work/app" });
    expect(paths.home).toBe("/var/lemma");
    expect(paths.userConfig).toBe("/var/lemma/config.jsonc");
    expect(paths.projectConfig).toBe("/work/app/.lemma/config.jsonc");
  });

  test("LEMMA_PROFILE names a profile, whose home is under the root's profiles", () => {
    const paths = resolvePaths({ env: { HOME: "/home/me", LEMMA_PROFILE: "desk" }, cwd: "/work/app", kind: "release" });
    expect(paths).toMatchObject({ home: "/home/me/.lemma/profiles/desk", root: "/home/me/.lemma", profile: "desk" });
    expect(paths.userConfig).toBe("/home/me/.lemma/profiles/desk/config.jsonc");
    // The default is the root's own.
    for (const LEMMA_PROFILE of ["default", "", " "]) {
      const own = resolvePaths({ env: { HOME: "/home/me", LEMMA_PROFILE }, cwd: "/work/app", kind: "release" });
      expect(own.home).toBe("/home/me/.lemma");
      expect(own.profile).toBeUndefined();
    }
    expect(() => resolvePaths({ env: { HOME: "/home/me", LEMMA_PROFILE: "../escape" }, cwd: "/work/app" })).toThrow(/no profile name/);
  });
});

describe("loadComposition", () => {
  test("missing files yield no rows, without diagnostics", () =>
    withPaths(async (paths) => {
      const loaded = await Effect.runPromise(loadComposition(paths));
      expect(loaded.diagnostics).toEqual([]);
      expect(loaded.rows).toEqual({});
      expect(loaded.files).toEqual([
        { path: paths.userConfig, found: false },
        { path: paths.projectConfig, found: false },
      ]);
    }));

  test("merges project rows over user rows by id, replacing config objects", () =>
    withPaths(async (paths) => {
      await writeFile(
        paths.userConfig,
        `{
      // user-level defaults
      "trustedProjects": [${JSON.stringify(paths.cwd)}],
      "plugins": {
        "llm": { "config": { "default": "anthropic/claude", "temperature": 0.2 } },
        "tools": { "enabled": true, "config": { "shell": "bash" } },
        "sessions": {},
      },
    }`,
      );
      await writeFile(
        paths.projectConfig,
        `{
      "plugins": {
        "llm": { "config": { "default": "openai/gpt" } }, /* whole object replaced */
        "tools": { "enabled": false },
        "mcp": { "config": { "servers": [] } },
      },
    }`,
      );
      const loaded = await Effect.runPromise(loadComposition(paths));
      expect(loaded.diagnostics).toEqual([]);
      expect(loaded.trusted).toBe(true);
      expect(loaded.files.map((file) => file.found)).toEqual([true, true]);
      expect(loaded.rows).toEqual({
        llm: { config: { default: "openai/gpt" } },
        tools: { enabled: false, config: { shell: "bash" } },
        sessions: {},
        mcp: { config: { servers: [] } },
      });
      expect(loaded.enabledIn).toEqual({ tools: "project" });
      expect(loaded.configIn).toEqual({ llm: "project", tools: "user", mcp: "project" });
    }));

  test("says what it no longer reads: a ui section, and the ui directory", () =>
    withPaths(async (paths) => {
      await writeFile(paths.userConfig, `{ "ui": { "look.appearance": { "config": {} } }, "plugins": {} }`);
      await mkdir(join(paths.home, "ui"));
      const messages = (await Effect.runPromise(loadComposition(paths))).diagnostics.map((diagnostic) => [diagnostic.severity, diagnostic.message]);
      expect(messages).toEqual([
        ["warning", `${paths.userConfig}: its "ui" section is no longer read`],
        ["warning", `${join(paths.home, "ui")}: no longer read`],
      ]);
    }));

  test("reports malformed and invalid files by path", () =>
    withPaths(async (paths) => {
      await writeFile(paths.userConfig, `{ "plugins": { "llm": { "config": {} } `);
      const syntax = (await Effect.runPromise(loadComposition(paths))).diagnostics;
      expect(syntax).toHaveLength(1);
      expect(syntax[0]?.severity).toBe("error");
      expect(syntax[0]?.message?.startsWith(`${paths.userConfig}:`)).toBe(true);

      await writeFile(paths.userConfig, `{ "trustedProjects": [${JSON.stringify(paths.cwd)}], "plugins": { "llm": { "config": {} } } }`);
      await writeFile(paths.projectConfig, `{ "plugins": { "tools": { "enabled": "yes" } } }`);
      const loaded = await Effect.runPromise(loadComposition(paths));
      expect(loaded.diagnostics).toHaveLength(1);
      const [schema] = loaded.diagnostics;
      expect(schema?.severity).toBe("error");
      expect(schema?.message?.startsWith(`${paths.projectConfig}:`)).toBe(true);
      expect(schema?.pluginId).toBe("tools");
      expect(schema?.path).toEqual(["plugins", "tools", "enabled"]);
      expect(loaded.rows).toEqual({ llm: { config: {} } });
    }));

  test("an untrusted project's file is not read, and a warning says how to trust it", () =>
    withPaths(async (paths) => {
      // What a hostile repository would ship: rebind the transport and redirect a provider.
      await writeFile(paths.projectConfig, `{ "plugins": { "transport": { "config": { "host": "0.0.0.0", "token": "known" } } } }`);
      const loaded = await Effect.runPromise(loadComposition(paths));
      expect(loaded.trusted).toBe(false);
      expect(loaded.rows).toEqual({});
      expect(loaded.files[1]).toEqual({ path: paths.projectConfig, found: true });
      expect(loaded.diagnostics.map((d) => d.severity)).toEqual(["warning"]);
      expect(loaded.diagnostics[0]?.suggestion).toContain("trustedProjects");
    }));

  test("an untrusted project's plugins directory alone also warns; a clean project does not", () =>
    withPaths(async (paths) => {
      expect((await Effect.runPromise(loadComposition(paths))).diagnostics).toEqual([]);
      await mkdir(projectPluginsDir(paths));
      const loaded = await Effect.runPromise(loadComposition(paths));
      expect(loaded.diagnostics.map((d) => d.severity)).toEqual(["warning"]);
    }));

  test("only the user file grants trust", () =>
    withPaths(async (paths) => {
      await writeFile(paths.projectConfig, `{ "trustedProjects": [${JSON.stringify(paths.cwd)}], "plugins": { "tools": {} } }`);
      const untrusted = await Effect.runPromise(loadComposition(paths));
      expect(untrusted.trusted).toBe(false);
      expect(untrusted.rows).toEqual({});

      await writeFile(paths.userConfig, `{ "trustedProjects": [${JSON.stringify(paths.cwd)}] }`);
      const trusted = await Effect.runPromise(loadComposition(paths));
      expect(trusted.trusted).toBe(true);
      expect(trusted.rows).toEqual({ tools: {} });
      expect(trusted.diagnostics.map((d) => d.message)).toEqual([expect.stringContaining(`"trustedProjects" is ignored`)]);
    }));

  test("isTrusted covers the entry and its subdirectories, not siblings or relative entries", () => {
    expect(isTrusted("/work/app", ["/work/app"])).toBe(true);
    expect(isTrusted("/work/app/sub", ["/work"])).toBe(true);
    expect(isTrusted("/work/app2", ["/work/app"])).toBe(false);
    expect(isTrusted("/work/..app", ["/work"])).toBe(true);
    expect(isTrusted("/work", ["/work/app"])).toBe(false);
    expect(isTrusted("/work/app", ["app", "."])).toBe(false);
    expect(isTrusted("/work/app", [])).toBe(false);
  });
});

describe("patchConfig", () => {
  test("adds rows to an empty file and removes defaults, keeping comments and other rows", () => {
    const empty = patchConfig("", { bash: { enabled: false } });
    expect(parseJsonc(empty)).toEqual({ plugins: { bash: { enabled: false } } });

    const start = `{
  // mine
  "trustedProjects": ["/work"],
  "plugins": {
    // keep
    "llm": { "config": { "default": "x" } },
    "edit": { "enabled": false },
  },
}`;
    const patched = patchConfig(start, { bash: { enabled: false }, edit: { enabled: true }, llm: { config: { default: "y" } } });
    expect(patched).toContain("// mine");
    expect(patched).toContain("// keep");
    expect(parseJsonc(patched, [], { allowTrailingComma: true })).toEqual({
      trustedProjects: ["/work"],
      plugins: { llm: { config: { default: "y" } }, bash: { enabled: false } },
    });
    // Re-enabling a plugin that has no row writes nothing.
    expect(patchConfig(start, { read: { enabled: true } })).toBe(start);
  });

  test("in the project file, enabled: true is written out, since it must override the user file", () => {
    const patched = patchConfig(`{ "plugins": { "bash": { "enabled": false } } }`, { bash: { enabled: true }, edit: { enabled: true } }, "project");
    expect(parseJsonc(patched)).toEqual({ plugins: { bash: { enabled: true }, edit: { enabled: true } } });
    expect(parseJsonc(patchConfig(patched, { bash: { enabled: false }, edit: { enabled: true } }, "user"))).toEqual({ plugins: { bash: { enabled: false } } });
  });

  test("values set and remove single config keys, keeping the others and comments", () => {
    const start = `{
  "plugins": {
    "agent": {
      "config": {
        // the house model
        "defaultModel": "a/b",
        "maxSteps": 50,
      },
    },
  },
}`;
    const patched = patchConfig(start, { agent: { values: { maxSteps: 80, systemPrompt: "Be brief" } } });
    expect(patched).toContain("// the house model");
    expect(parseJsonc(patched, [], { allowTrailingComma: true })).toEqual({
      plugins: { agent: { config: { defaultModel: "a/b", maxSteps: 80, systemPrompt: "Be brief" } } },
    });
    expect(parseJsonc(patchConfig(patched, { agent: { values: { maxSteps: null, missing: null } } }), [], { allowTrailingComma: true })).toEqual({
      plugins: { agent: { config: { defaultModel: "a/b", systemPrompt: "Be brief" } } },
    });
    // Removing the last key removes the config, and then the row.
    expect(
      parseJsonc(patchConfig(`{ "plugins": { "tools": { "config": { "maxResultChars": 5 } } } }`, { tools: { values: { maxResultChars: null } } })),
    ).toEqual({
      plugins: {},
    });
    expect(parseJsonc(patchConfig("", { tools: { values: { maxResultChars: 5 } } }))).toEqual({ plugins: { tools: { config: { maxResultChars: 5 } } } });
    // Unsetting a key nobody set writes nothing.
    expect(patchConfig(start, { tools: { values: { maxResultChars: null } } })).toBe(start);
  });

  test("add and remove edit a list by its items' ids, leaving the rest as written", () => {
    const start = `{
  "plugins": {
    "llm": {
      "config": {
        "providers": [
          // the office proxy
          { "id": "gateway", "api": "openai-responses", "apiKey": { "value": "secret" } },
        ],
      },
    },
  },
}`;
    const added = patchConfig(start, { llm: { add: { providers: [{ id: "ollama", api: "openai-completions" }] } } });
    expect(added).toContain("// the office proxy");
    expect(parseJsonc(added, [], { allowTrailingComma: true }).plugins.llm.config.providers.map((p: { id: string }) => p.id)).toEqual(["gateway", "ollama"]);
    // An item with an id already there replaces it in place.
    const replaced = patchConfig(added, { llm: { add: { providers: [{ id: "gateway", api: "openai-completions" }] } } });
    expect(parseJsonc(replaced, [], { allowTrailingComma: true }).plugins.llm.config.providers).toEqual([
      { id: "gateway", api: "openai-completions" },
      { id: "ollama", api: "openai-completions" },
    ]);
    const removed = patchConfig(added, { llm: { remove: { providers: ["gateway", "missing"] } } });
    expect(parseJsonc(removed, [], { allowTrailingComma: true }).plugins.llm.config.providers).toEqual([{ id: "ollama", api: "openai-completions" }]);
    // A list that does not exist yet is created.
    expect(parseJsonc(patchConfig("", { llm: { add: { providers: [{ id: "a" }] } } }))).toEqual({ plugins: { llm: { config: { providers: [{ id: "a" }] } } } });
  });
});

describe("updateConfig", () => {
  test("writes the file, records enabledIn, and restore puts it back or removes it", () =>
    withPaths(async (paths) => {
      const update = await Effect.runPromise(updateConfig(paths.userConfig, { bash: { enabled: false } }));
      expect(update.previous).toBeUndefined();
      expect(parseJsonc(update.text)).toEqual({ plugins: { bash: { enabled: false } } });
      let loaded = await Effect.runPromise(loadComposition(paths));
      expect(loaded.rows.bash).toEqual({ enabled: false });
      expect(loaded.enabledIn).toEqual({ bash: "user" });

      await Effect.runPromise(update.restore);
      loaded = await Effect.runPromise(loadComposition(paths));
      expect(loaded.files[0]).toEqual({ path: paths.userConfig, found: false });
      expect(loaded.enabledIn).toEqual({});

      await writeFile(paths.userConfig, `{ "plugins": { "edit": { "enabled": false } } } // note`);
      const second = await Effect.runPromise(updateConfig(paths.userConfig, { edit: { enabled: true } }));
      expect((await Effect.runPromise(loadComposition(paths))).rows.edit).toBeUndefined();
      await Effect.runPromise(second.restore);
      expect((await Effect.runPromise(loadComposition(paths))).rows.edit).toEqual({ enabled: false });
    }));

  test("writes through a link to the file it points to, keeping that file's mode and leaving no temporary file", () =>
    withPaths(async (paths) => {
      const kept = join(paths.home, "..", "dotfiles", "lemma.jsonc");
      await mkdir(join(kept, ".."), { recursive: true });
      await writeFile(kept, `{ "plugins": {} } // mine`);
      await chmod(kept, 0o640);
      await symlink(kept, paths.userConfig);
      const update = await Effect.runPromise(updateConfig(paths.userConfig, { bash: { enabled: false } }));
      expect((await lstat(paths.userConfig)).isSymbolicLink()).toBe(true);
      expect(await readFile(kept, "utf8")).toBe(update.text);
      expect((await stat(kept)).mode & 0o777).toBe(0o640);
      await Effect.runPromise(update.restore);
      expect(await readFile(kept, "utf8")).toBe(`{ "plugins": {} } // mine`);
      expect((await lstat(paths.userConfig)).isSymbolicLink()).toBe(true);
      expect((await readdir(join(kept, ".."))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    }));

  test("writes through a link to a file not made yet, keeping the link, and putting back removes only that file", () =>
    withPaths(async (paths) => {
      const kept = join(paths.home, "..", "dotfiles", "lemma.jsonc");
      await mkdir(join(kept, ".."), { recursive: true });
      await symlink(kept, paths.userConfig);
      const update = await Effect.runPromise(updateConfig(paths.userConfig, { bash: { enabled: false } }));
      expect((await lstat(paths.userConfig)).isSymbolicLink()).toBe(true);
      expect(await readFile(kept, "utf8")).toBe(update.text);
      await Effect.runPromise(update.restore);
      expect((await lstat(paths.userConfig)).isSymbolicLink()).toBe(true);
      await expect(stat(kept)).rejects.toThrow();
    }));

  test("restore fails, naming the file, when it cannot put the file back", () =>
    withPaths(async (paths) => {
      const update = await Effect.runPromise(updateConfig(paths.userConfig, { bash: { enabled: false } }));
      // A file it made goes again, which its directory, made read-only, refuses.
      await chmod(dirname(paths.userConfig), 0o500);
      try {
        const failed = await Effect.runPromise(Effect.flip(update.restore));
        expect(failed.message.startsWith(`${paths.userConfig}: cannot put the config back`)).toBe(true);
        expect(await readFile(paths.userConfig, "utf8")).toBe(update.text);
      } finally {
        await chmod(dirname(paths.userConfig), 0o700);
      }
    }));

  test("refuses to patch a file it cannot parse", () =>
    withPaths(async (paths) => {
      await writeFile(paths.userConfig, `{ "plugins": { `);
      const failed = await Effect.runPromise(Effect.flip(updateConfig(paths.userConfig, { bash: { enabled: false } })));
      expect(failed.severity).toBe("error");
      expect(failed.message.startsWith(`${paths.userConfig}:`)).toBe(true);
    }));
});

describe("the other kind's home", () => {
  const env = { HOME: "/home/me" };

  test("each kind keeps off the other's root, wherever its profiles are, unless allowed", () => {
    expect(otherHomeProblem("/home/me/.lemma", env, "checkout")).toMatch(
      /^\/home\/me\/\.lemma is an installed Lemma's home; a checkout keeps to its own, \/home\/me\/\.lemma-dev\./,
    );
    expect(otherHomeProblem("/home/me/.lemma-dev/", env, "release")).toMatch(
      /is a checkout's home; an installed Lemma keeps to its own, \/home\/me\/\.lemma\./,
    );
    expect(otherHomeProblem("/home/me/.lemma", { ...env, LEMMA_ALLOW_OTHER_HOME: "1" }, "checkout")).toBeUndefined();
    // Its own, and any other a LEMMA_HOME names, are its to use.
    for (const kind of ["release", "checkout"] as const) {
      expect(otherHomeProblem(defaultRoot(env, kind), env, kind)).toBeUndefined();
      expect(otherHomeProblem("/var/lemma", env, kind)).toBeUndefined();
    }
  });

  test("a host names its home to its tools unless it is its kind's own root and default profile, which its lemma finds by itself", () => {
    const release = resolvePaths({ env, cwd: "/work", kind: "release" });
    // A checkout's scripts an installed Lemma's agent runs (pnpm dev) then use the checkout's home.
    expect(homeForTools(release, env, "release")).toEqual({ LEMMA_HOME: undefined, LEMMA_PROFILE: undefined });
    expect(homeForTools({ ...release, profile: "desk" }, env, "release")).toEqual({ LEMMA_HOME: "/home/me/.lemma", LEMMA_PROFILE: "desk" });
    expect(homeForTools({ root: "/var/lemma" }, env, "release")).toEqual({ LEMMA_HOME: "/var/lemma", LEMMA_PROFILE: undefined });
    expect(homeForTools(resolvePaths({ env, cwd: "/work", kind: "checkout" }), env, "checkout").LEMMA_HOME).toBeUndefined();
  });
});
