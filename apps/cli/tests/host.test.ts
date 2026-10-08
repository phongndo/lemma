import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { settled, startLemma } from "../../../scripts/e2e.ts";
import type { Lemma } from "../../../scripts/e2e.ts";
import { ExitCode, run } from "../src/cli.ts";
import { invoke, printOnFailure } from "./invoke.ts";

describe("against a running host", () => {
  let lemma: Lemma;
  let home: string;
  beforeAll(async () => {
    lemma = await startLemma("lemma-cli-");
    home = lemma.home;
  }, 30_000);
  afterAll(() => lemma?.stop());
  printOnFailure(() => lemma?.output());

  test("status reports the composition", async () => {
    const result = await invoke(["status", "--json"], home);
    expect(result.code).toBe(ExitCode.ok);
    const status = JSON.parse(result.out);
    expect(status.info.home).toBe(home);
    // What the host provides itself is no plugin's: it has no row.
    expect(status.info.runtime).toEqual(["lemma/Paths", "lemma/HostControl", "lemma/Interaction", "lemma/api@2"]);
    expect(status.plugins.map((plugin: { id: string }) => plugin.id)).toContain("agent");
    expect(status.plugins.map((plugin: { id: string }) => plugin.id)).not.toContain("interaction");
    expect(status.plugins.every((plugin: { state: string }) => plugin.state === "active")).toBe(true);
    expect(status.running).toEqual([]);
  });

  test("lists providers, models, and open questions", async () => {
    expect(JSON.parse((await invoke(["models", "--json"], home)).out).map((model: { ref: string }) => model.ref)).toEqual(["mock/scripted"]);
    expect(JSON.parse((await invoke(["providers", "--json"], home)).out).some((provider: { id: string }) => provider.id === "mock")).toBe(true);
    expect(await invoke(["questions"], home)).toMatchObject({ code: ExitCode.ok, out: "No open questions." });
    expect((await invoke(["answer", "nope", "yes", "--json"], home)).code).toBe(ExitCode.failed);
  });

  test("session list is scoped to a directory unless --all", async () => {
    const empty = await mkdtemp(join(tmpdir(), "lemma-cli-empty-"));
    try {
      expect(await invoke(["session", "list"], home, empty)).toMatchObject({ code: ExitCode.ok, out: `No sessions in ${empty}.` });
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
    expect(JSON.parse((await invoke(["session", "list", "--all", "--json"], home)).out)).toBeInstanceOf(Array);
  });

  test("open prints the web app's address for a session, with the token", async () => {
    const session = JSON.parse((await invoke(["session", "new", "--json"], home)).out).id as string;
    const { url } = JSON.parse((await invoke(["open", session, "trajectory", "--json"], home)).out) as { url: string };
    const address = new URL(url);
    expect(address.pathname).toBe(`/threads/${encodeURIComponent(session)}/trajectory`);
    expect(address.searchParams.get("token")).toBeTruthy();
    expect(new URL(JSON.parse((await invoke(["open", "--json"], home)).out).url).pathname).toBe("/");
    expect(JSON.parse((await invoke(["open", "missing", "--json"], home)).err).error).toMatchObject({ code: "NotFound" });
  });

  test("a domain error keeps the host's code", async () => {
    const result = await invoke(["session", "show", "missing", "--json"], home);
    expect(result.code).toBe(ExitCode.failed);
    expect(JSON.parse(result.err).error).toMatchObject({ code: "NotFound", subject: "missing" });
  });

  test("restart and reload go through the host", async () => {
    expect(JSON.parse((await invoke(["plugins", "restart", "project-context", "--json"], home)).out)).toEqual({ restarted: "project-context" });
    expect(JSON.parse((await invoke(["plugins", "restart", "project-context", "--force", "--json"], home)).out)).toEqual({ restarted: "project-context" });
    expect(await invoke(["reload"], home)).toMatchObject({ code: ExitCode.ok, out: "nothing changed" });
  });

  test("disable and enable write the config that decides, refuse locked plugins, and undo rejected changes", async () => {
    const userConfig = join(home, "config.jsonc");
    const projectConfig = join(home, ".lemma", "config.jsonc");
    const original = await readFile(userConfig, "utf8");
    const rows = async (path: string) => JSON.parse(await readFile(path, "utf8")).plugins;
    const find = async (id: string) => JSON.parse((await invoke(["plugins", "--json"], home)).out).find((plugin: { id: string }) => plugin.id === id);
    try {
      const off = await invoke(["plugins", "disable", "project-context", "--json"], home);
      expect(off.code).toBe(ExitCode.ok);
      expect(JSON.parse(off.out)).toMatchObject({ disabled: "project-context", stopped: ["project-context"] });
      expect((await rows(userConfig))["project-context"]).toEqual({ enabled: false });
      expect(await find("project-context")).toMatchObject({ enabled: false, state: "disabled", scope: "user", source: "bundled" });
      // Only what the host pins is locked: the transport needs nothing but the runtime, which no plugin provides.
      expect((await find("llm")).locked).toBeUndefined();
      expect((await invoke(["plugins"], home)).out).toContain("off in the user config");

      // The pinned plugin refuses, and the file is left as it was; nor can it be restarted by force while it runs.
      const pinned = await invoke(["plugins", "disable", "transport", "--json"], home);
      expect(pinned.code).toBe(ExitCode.failed);
      expect(JSON.parse(pinned.err).error).toMatchObject({ code: "ReloadError", subject: "transport" });
      expect((await rows(userConfig)).transport).toEqual({ config: { port: 0 } });
      const forced = await invoke(["plugins", "restart", "transport", "--force", "--json"], home);
      expect(forced.code).toBe(ExitCode.failed);
      expect(JSON.parse(forced.err).error).toMatchObject({ code: "ReloadError", subject: "transport" });
      expect(JSON.parse(forced.err).error.message).toContain("cannot be restarted while running");

      // Any other plugin restarts by force and turns off, what needs it with it, while the transport serves on.
      expect(JSON.parse((await invoke(["plugins", "restart", "llm", "--force", "--json"], home)).out)).toEqual({ restarted: "llm" });
      const llmOff = await invoke(["plugins", "disable", "llm", "--json"], home);
      expect(llmOff.code).toBe(ExitCode.ok);
      expect(JSON.parse(llmOff.out)).toMatchObject({ disabled: "llm", stopped: expect.arrayContaining(["llm", "agent"]) });
      expect((await rows(userConfig)).llm.enabled).toBe(false);
      expect(await find("agent")).toMatchObject({ enabled: true, state: "disabled", haltedBy: "llm" });
      // With no agent, nothing serves `agent.running`: the host still answers, unsure what runs.
      expect(await invoke(["status"], home)).toMatchObject({ code: ExitCode.ok, out: expect.stringMatching(/\nrunning +unknown: no agent runs/) });
      const llmOn = await invoke(["plugins", "enable", "llm", "--json"], home);
      expect(JSON.parse(llmOn.out)).toMatchObject({ enabled: "llm", started: expect.arrayContaining(["llm", "agent"]) });
      expect((await rows(userConfig)).llm.enabled).toBeUndefined();

      // The project file is only written for a trusted project.
      const untrusted = await invoke(["plugins", "disable", "bash", "--project", "--json"], home);
      expect(untrusted.code).toBe(ExitCode.failed);
      expect(JSON.parse(untrusted.err).error.message).toContain("not a trusted project");
      expect(existsSync(projectConfig)).toBe(false);

      // Trusted: a project row overrides the user row, so enabling there writes an explicit true.
      await writeFile(userConfig, JSON.stringify({ ...JSON.parse(await readFile(userConfig, "utf8")), trustedProjects: [home] }));
      expect(await invoke(["reload"], home)).toMatchObject({ code: ExitCode.ok });
      expect(JSON.parse((await invoke(["plugins", "disable", "bash", "--json"], home)).out)).toMatchObject({ stopped: ["bash"] });
      const overridden = await invoke(["plugins", "enable", "bash", "--project", "--json"], home);
      expect(JSON.parse(overridden.out)).toMatchObject({ enabled: "bash", started: ["bash"] });
      expect((await rows(projectConfig)).bash).toEqual({ enabled: true });
      expect(await find("bash")).toMatchObject({ enabled: true, state: "active", scope: "project" });

      const on = await invoke(["plugins", "enable", "project-context", "--json"], home);
      expect(JSON.parse(on.out)).toMatchObject({ enabled: "project-context", started: ["project-context"] });
      expect((await rows(userConfig))["project-context"]).toBeUndefined();
    } finally {
      await rm(join(home, ".lemma"), { recursive: true, force: true });
      await writeFile(userConfig, original);
      await invoke(["reload"], home);
    }
  });

  test("plugins show prints a plugin's wiring: who provides, who uses, and the hooks and events it takes part in", async () => {
    const shown = await invoke(["plugins", "show", "agent"], home);
    expect(shown.code).toBe(ExitCode.ok);
    // Clients reach it through its channels: no plugin needs it.
    expect(shown.out).toContain("Agent  used by no plugin");
    expect(shown.out).toContain("Llm  from llm");
    expect(shown.out).toContain("HostControl  from the host");
    // What a plugin adds to other plugins' registries: bash its tool.
    expect((await invoke(["plugins", "show", "bash"], home)).out).toContain("Contributes\n  lemma/tools  bash");
    const transport = JSON.parse((await invoke(["plugins", "show", "transport", "--json"], home)).out);
    // It observes the runtime's events only: each subsystem streams its own.
    expect([...transport.observes].sort()).toEqual(["lemma/notice", "lemma/plugins.changed", "lemma/ui.changed"]);
    expect(transport.hooks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "lemma/interaction.request" })]));
    expect(JSON.parse((await invoke(["plugins", "show", "nope", "--json"], home)).err).error.code).toBe("NotFound");
  });

  test("kernel shows the host as its core runs it: capabilities, hook chains, registries, and events", async () => {
    const capabilities = await invoke(["kernel"], home);
    expect(capabilities.code).toBe(ExitCode.ok);
    expect(capabilities.out).toMatch(/lemma\/Agent\s+agent \(active\)/);
    expect(capabilities.out).toMatch(/lemma\/HostControl\s+the host\s+.*transport/);
    expect(capabilities.out).toMatch(/lemma\/Interaction\s+the host\s+\S/);
    expect(capabilities.out).not.toContain("NOTHING");
    const hooks = JSON.parse((await invoke(["kernel", "hooks", "--json"], home)).out);
    expect(hooks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "lemma/interaction.request" })]));
    const registries = (await invoke(["kernel", "registries"], home)).out;
    expect(registries).toMatch(/lemma\/tools {2}\(\d+ items\)/);
    expect(registries).toMatch(/\n {2}bash +1 +bash/);
    expect((await invoke(["kernel", "events"], home)).out).toMatch(/lemma\/notice\s+transport/);
    expect((await invoke(["kernel", "nope"], home)).code).toBe(ExitCode.usage);
    expect((await invoke(["kernel", "toString"], home)).code).toBe(ExitCode.usage);
  });

  test("inspectors lists what host plugins let you look into, and prints one as tables", async () => {
    const listed = await invoke(["inspectors"], home);
    expect(listed.out).toMatch(/tools\.registered\s+Tools\s+tools/);
    expect(listed.out).toMatch(/agent\.turns\s+Running turns\s+agent/);
    const tools = await invoke(["inspectors", "tools.registered"], home);
    expect(tools.out).toMatch(/^tools\nname\s+plugin\s+description\n/);
    expect(tools.out).toMatch(/\nbash\s+bash\s+/);
    expect(JSON.parse((await invoke(["inspectors", "agent.turns", "--json"], home)).out)).toEqual([]);
    expect(JSON.parse((await invoke(["inspectors", "nope", "--json"], home)).err).error.code).toBe("NotFound");
  });

  test("channels lists what host plugins serve; an unknown one is NotFound, for a call and a stream alike", async () => {
    // The bundled subsystems serve theirs; a plugin file's are below, and examples/ticker uses one in a real host.
    const text = (await invoke(["channels"], home)).out;
    expect(text).toMatch(/^sessions\.list +call +List sessions +sessions /m);
    expect(text).toMatch(/\nllm\.login\s+call\s+Log in\s+llm\s+Runs a provider's login flow/);
    expect(text).toMatch(/\ncommands\.run\s+call\s+Run command\s+commands\s+Runs a command/);
    const listed = JSON.parse((await invoke(["channels", "--json"], home)).out) as { id: string; source: string }[];
    const servedBy = (source: string) => listed.filter((channel) => channel.source === source).map((channel) => channel.id);
    expect(servedBy("sessions")).toContain("sessions.list");
    expect(servedBy("llm")).toEqual([
      "llm.providers",
      "llm.models",
      "llm.login",
      "llm.cancel-login",
      "llm.logout",
      "llm.add-custom",
      "llm.remove-custom",
      "llm.set-logo",
      "llm.changes",
    ]);
    expect(servedBy("commands")).toEqual(["commands.list", "commands.run", "commands.changes"]);
    expect(servedBy("workspace")).toEqual([
      "workspace.status",
      "workspace.browse",
      "workspace.create-directory",
      "workspace.create-worktree",
      "workspace.branches",
      "workspace.checkout",
      "files.search",
    ]);
    for (const sub of ["call", "open"]) {
      const result = await invoke(["channels", sub, "nope.nothing", "{}", "--json"], home);
      expect(result.code).toBe(ExitCode.failed);
      expect(JSON.parse(result.err).error).toMatchObject({ code: "NotFound", subject: "nope.nothing" });
    }
  });

  test("plugins config shows a plugin's fields and sets or unsets one in the file that sets its config", async () => {
    const userConfig = join(home, "config.jsonc");
    const original = await readFile(userConfig, "utf8");
    const config = async (id: string) => JSON.parse((await invoke(["plugins", "config", id, "--json"], home)).out);
    // A restarted transport writes transport.json again: until the new one answers, calls may reach neither.
    const startedAt = async () => (JSON.parse(await readFile(join(home, "transport.json"), "utf8")) as { startedAt: number }).startedAt;
    const restarted = (before: number) =>
      settled(async () => ((await startedAt()) !== before && (await invoke(["status"], home)).code === ExitCode.ok) || undefined);
    try {
      const agent = await config("agent");
      expect(agent.fields.find((field: { key: string }) => field.key === "maxSteps")).toMatchObject({ type: "integer", default: 200 });
      expect(agent.values.maxSteps).toBe(200);
      expect((await invoke(["plugins", "config", "agent"], home)).out).toContain("Model calls allowed in one turn");

      // Applied at once: the transport needs nothing the agent provides, so it serves on.
      const before = await startedAt();
      const set = await invoke(["plugins", "config", "agent", "maxSteps", "80", "--json"], home);
      expect(set.code).toBe(ExitCode.ok);
      expect(JSON.parse(set.out)).toMatchObject({ id: "agent", key: "maxSteps", value: 80, scope: "user", restarted: expect.arrayContaining(["agent"]) });
      expect(JSON.parse(set.out).deferred).toBeUndefined();
      expect(JSON.parse(await readFile(userConfig, "utf8")).plugins.agent).toEqual({ config: { maxSteps: 80 } });
      const maxSteps = async () => (await config("agent")).values.maxSteps as number;
      expect(await maxSteps()).toBe(80);
      expect(await startedAt()).toBe(before);

      const wrong = await invoke(["plugins", "config", "agent", "maxSteps", "1.5", "--json"], home);
      expect(wrong.code).toBe(ExitCode.failed);
      expect(JSON.parse(wrong.err).error).toMatchObject({ code: "Usage", message: "maxSteps must be a whole number" });
      const unknown = await invoke(["plugins", "config", "agent", "speed", "9", "--json"], home);
      expect(JSON.parse(unknown.err).error.message).toContain("its fields are defaultModel, systemPrompt, cli, maxSteps");

      await invoke(["plugins", "config", "agent", "maxSteps", "--unset"], home);
      expect(JSON.parse(await readFile(userConfig, "utf8")).plugins.agent).toBeUndefined();
      expect(await maxSteps()).toBe(200);

      // A change to the transport itself is written and answered, then applied, restarting the transport serving it.
      const beforeTransport = await startedAt();
      const grace = await invoke(["plugins", "config", "transport", "interactionGraceMs", "20000"], home);
      expect(grace).toMatchObject({
        code: ExitCode.ok,
        out: "set transport.interactionGraceMs = 20000 in the user config: applying: the host restarts the transport, so clients reconnect",
      });
      expect(await restarted(beforeTransport)).toBe(true);
      expect((await config("transport")).values.interactionGraceMs).toBe(20000);
      const beforeUnset = await startedAt();
      await invoke(["plugins", "config", "transport", "interactionGraceMs", "--unset"], home);
      expect(await restarted(beforeUnset)).toBe(true);
      // The transport's token is secret: clients learn only whether it is set.
      const transport = await config("transport");
      expect(transport.fields.find((field: { key: string }) => field.key === "token")).toMatchObject({ secret: true });
      expect(transport.values.token).toBeUndefined();
      expect(transport.values.port).toBe(0);
    } finally {
      await writeFile(userConfig, original);
      await settled(async () => (await invoke(["reload"], home)).code === ExitCode.ok || undefined);
    }
  });

  test("ui lists and writes the web app's rows, and finds UI files as they appear", async () => {
    const userConfig = join(home, "config.jsonc");
    const original = await readFile(userConfig, "utf8");
    const ui = async () => JSON.parse((await invoke(["ui", "--json"], home)).out);
    try {
      expect(await ui()).toEqual({ plugins: {}, enabledIn: {}, configIn: {}, files: [] });
      expect((await invoke(["ui", "disable", "composer"], home)).out).toBe("disabled composer in the user config; open web apps apply it");
      await invoke(["ui", "config", "theme", "accent", "red"], home);
      await invoke(["ui", "config", "theme", "scale", "1.2"], home);
      expect(JSON.parse(await readFile(userConfig, "utf8")).ui).toEqual({ composer: { enabled: false }, theme: { config: { accent: "red", scale: 1.2 } } });
      expect(await ui()).toMatchObject({ enabledIn: { composer: "user" }, configIn: { theme: "user" } });
      await invoke(["ui", "enable", "composer"], home);
      await invoke(["ui", "config", "theme", "accent", "--unset"], home);
      expect(JSON.parse(await readFile(userConfig, "utf8")).ui).toEqual({ theme: { config: { scale: 1.2 } } });

      await mkdir(join(home, "ui"), { recursive: true });
      await writeFile(join(home, "ui", "theme.css"), ":root { --accent: red; }");
      const files = await settled(
        async () => (await ui()).files as { name: string; kind: string; url: string }[],
        (found) => found.length > 0,
        5_000,
      );
      expect(files).toMatchObject([{ name: "theme.css", kind: "style" }]);
      expect((await invoke(["ui"], home)).out).toContain("user/theme.css");
    } finally {
      await rm(join(home, "ui"), { recursive: true, force: true });
      await writeFile(userConfig, original);
      await invoke(["reload"], home);
    }
  });

  test("do lists the commands plugins registered and runs one, answering its questions", async () => {
    const listed = JSON.parse((await invoke(["do", "--json"], home)).out).map((command: { id: string }) => command.id);
    expect(listed).toEqual(expect.arrayContaining(["host.reload", "host.restart-plugin", "llm.logout", "workspace.checkout", "workspace.new-branch"]));
    expect(await invoke(["do", "host.reload"], home)).toMatchObject({ code: ExitCode.ok, out: "Config reloaded; nothing changed" });

    const repo = await mkdtemp(join(tmpdir(), "lemma-cli-repo-"));
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
      expect(await invoke(["do", "workspace.new-branch", "--answer", "topic"], home, repo)).toMatchObject({
        code: ExitCode.ok,
        out: "Created and switched to topic",
      });
      const dismissed = await invoke(["do", "workspace.checkout", "--questions", "dismiss", "--json"], home, repo);
      expect(dismissed.code).toBe(ExitCode.failed);
      expect(JSON.parse(dismissed.err.split("\n").at(-1)!).error).toMatchObject({ code: "Cancelled", subject: "workspace.checkout" });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
    expect(JSON.parse((await invoke(["do", "nope", "--json"], home)).err).error).toMatchObject({ code: "NotFound", subject: "nope" });
  }, 30_000);

  test("workspace files finds a project's files by a fuzzy query", async () => {
    const repo = await realpath(await mkdtemp(join(tmpdir(), "lemma-cli-files-")));
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
      await mkdir(join(repo, "src", "components"), { recursive: true });
      await writeFile(join(repo, "src", "components", "Composer.tsx"), "");
      await writeFile(join(repo, "README.md"), "");
      const found = JSON.parse((await invoke(["workspace", "files", "src", "compoesr", "--json"], home, repo)).out);
      expect(found).toMatchObject({ root: repo, truncated: false });
      expect(found.entries[0]).toEqual({ path: "src/components/Composer.tsx", kind: "file" });
      expect((await invoke(["workspace", "files", "--limit", "1", "--path", repo], home)).out.split("\n")).toHaveLength(2);
      expect(JSON.parse((await invoke(["workspace", "files", "--json", "--path", join(repo, "missing")], home)).err).error).toMatchObject({
        code: "NotFound",
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("a rejected token fails instead of waiting", async () => {
    const other = await mkdtemp(join(tmpdir(), "lemma-cli-"));
    try {
      const discovery = JSON.parse(await readFile(join(home, "transport.json"), "utf8"));
      await writeFile(join(other, "transport.json"), JSON.stringify({ ...discovery, token: "wrong" }));
      const result = await invoke(["status", "--json"], other);
      expect(result.code).toBe(ExitCode.unavailable);
      expect(JSON.parse(result.err).error.code).toBe("Unauthorized");
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});

describe("channels served by a plugin file", () => {
  let lemma: Lemma;
  let home: string;
  const cliMain = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  beforeAll(async () => {
    lemma = await startLemma("lemma-cli-channels-", {
      prepare: async (home) => {
        await mkdir(join(home, "plugins"));
        // Its stream sends 4 KB at a time, as fast as it is pulled, and its stats say how much it has sent.
        await writeFile(
          join(home, "plugins", "bulk.ts"),
          `import { Effect, Layer, Schema, Stream } from "effect";
import { definePlugin, PluginContext } from "@lemma/core";
import { Channels, serveChannel } from "@lemma/contracts";
let emitted = 0;
let active = 0;
export default definePlugin({
  id: "bulk",
  layer: Layer.effectDiscard(Effect.gen(function* () {
    const owner = yield* PluginContext;
    yield* owner.add(Channels, serveChannel({ kind: "call", id: "bulk.stats", payload: Schema.Void, success: Schema.Struct({ emitted: Schema.Number, active: Schema.Number }) }, () => ({ emitted, active })));
    yield* owner.add(Channels, serveChannel({ kind: "call", id: "bulk.nothing", payload: Schema.Void, success: Schema.Void }, () => undefined));
    yield* owner.add(Channels, serveChannel({ kind: "call", id: "bulk.empty", payload: Schema.Void, success: Schema.Struct({}) }, () => ({})));
    yield* owner.add(Channels, serveChannel({ kind: "stream", id: "bulk.chunks", payload: Schema.Number, success: Schema.String }, (count) =>
      Stream.fromEffectRepeat(Effect.sync(() => { emitted++; return "x".repeat(4096); })).pipe(
        Stream.take(count),
        Stream.onStart(Effect.sync(() => { active++; })),
        Stream.ensuring(Effect.sync(() => { active--; })),
      ),
    ));
  })),
});
`,
        );
      },
    });
    home = lemma.home;
  }, 30_000);
  afterAll(() => lemma?.stop());
  printOnFailure(() => lemma?.output());

  test("channels lists, calls, and opens them, and prints a call with no result, or an empty one, as something", async () => {
    const listed = JSON.parse((await invoke(["channels", "--json"], home)).out) as { id: string; source: string }[];
    expect(listed.filter((channel) => channel.source === "bulk").map((channel) => channel.id)).toEqual([
      "bulk.stats",
      "bulk.nothing",
      "bulk.empty",
      "bulk.chunks",
    ]);
    expect(await invoke(["channels", "call", "bulk.nothing"], home)).toMatchObject({ code: ExitCode.ok, out: "called bulk.nothing: no result" });
    expect(await invoke(["channels", "call", "bulk.nothing", "--json"], home)).toMatchObject({ code: ExitCode.ok, out: "null" });
    expect(await invoke(["channels", "call", "bulk.empty"], home)).toMatchObject({ code: ExitCode.ok, out: "{}" });
    expect(await invoke(["channels", "call", "bulk.empty", "--json"], home)).toMatchObject({ code: ExitCode.ok, out: "{}" });
    const opened = await invoke(["channels", "open", "bulk.chunks", "3"], home);
    expect(opened.code).toBe(ExitCode.ok);
    expect(opened.out.split("\n").map((line) => (JSON.parse(line) as string).length)).toEqual([4096, 4096, 4096]);
  });
  /** What the bulk plugin has produced, and how many of its streams run now. */
  const stats = async () => JSON.parse((await invoke(["channels", "call", "bulk.stats", "--json"], home)).out) as { emitted: number; active: number };
  const until = async (done: (now: { emitted: number; active: number }) => boolean) => {
    if ((await settled(stats, done)) === undefined) throw new Error("timed out");
  };
  test("channels open prints at stdout's pace and in order, while the host's stream goes on: what stdout has not taken waits in the command", async () => {
    const lines: string[] = [];
    let release: () => void = () => {};
    let waited = 0;
    const before = (await stats()).emitted;
    const done = run(["channels", "open", "bulk.chunks", "200"], {
      env: { LEMMA_HOME: home },
      cwd: home,
      out: (text) => void lines.push(text),
      err: () => {},
      // Behind after the first line, until released.
      drained: () => (waited++ === 0 ? new Promise<void>((resolve) => (release = resolve)) : undefined),
    });
    await until(() => lines.length === 1);
    // The connection is never held back for stdout (see `makeHostRpc` in @lemma/client): the host sends all 200.
    await until(({ emitted, active }) => emitted - before === 200 && active === 0);
    expect(lines).toHaveLength(1);
    release();
    expect(await done).toBe(ExitCode.ok);
    expect(lines).toHaveLength(200);
  }, 30_000);

  test("Ctrl+C, SIGKILL, and `| head -n 1` stop a stream on the host", async () => {
    for (const signal of ["SIGKILL", "SIGINT"] as const) {
      const opened = spawn(process.execPath, ["--conditions=lemma-source", cliMain, "channels", "open", "bulk.chunks", "100000"], {
        env: { ...process.env, LEMMA_HOME: home },
        stdio: ["ignore", "pipe", "ignore"],
      });
      opened.stdout!.resume();
      await until(({ active }) => active === 1);
      opened.kill(signal);
      await new Promise((resolve) => opened.once("exit", resolve));
      await until(({ active }) => active === 0);
    }

    const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
    const piped = spawn(
      "bash",
      ["-o", "pipefail", "-c", `${quote(process.execPath)} --conditions=lemma-source ${quote(cliMain)} channels open bulk.chunks 100000 | head -n 1 | wc -c`],
      { env: { ...process.env, LEMMA_HOME: home }, stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    piped.stdout!.on("data", (chunk: Buffer) => (out += chunk.toString()));
    expect(await new Promise((resolve) => piped.once("exit", resolve))).toBe(0);
    // One line of a 4 KB JSON string and its newline.
    expect(out.trim()).toBe(String(4096 + 2 + 1));
    await until(({ active }) => active === 0);
  }, 60_000);
});

describe("a change a plugin's own call asks for", () => {
  let lemma: Lemma;
  let home: string;
  /**
   * Its own calls change its config, restart it, and reload the host, each answering whether the change was deferred
   * (`set` with the value it still serves); its streams change its config, or reload the host, and stay open. `edition`
   * (its version too) tells its file's versions apart, and `activation` counts its starts from one file.
   */
  const selfconf = (edition: number) => `import { Effect, Schema, Stream } from "effect";
import { definePlugin } from "@lemma/core";
import { Channels, HostControl, serveChannel } from "@lemma/contracts";
let activations = 0;
const answer = (deferred) => ({ deferred: deferred === true });
const Answer = Schema.Struct({ deferred: Schema.Boolean });
export default definePlugin({
  id: "selfconf",
  version: "${edition}",
  config: { value: 0 },
  requires: { host: HostControl },
  setup: function* ({ host }, owner) {
    const activation = ++activations;
    yield* owner.add(Channels, serveChannel({ kind: "call", id: "selfconf.value", payload: Schema.Void, success: Schema.Number }, () => owner.config.value));
    yield* owner.add(Channels, serveChannel({ kind: "call", id: "selfconf.edition", payload: Schema.Void, success: Schema.Number }, () => ${edition}));
    yield* owner.add(Channels, serveChannel({ kind: "call", id: "selfconf.activation", payload: Schema.Void, success: Schema.Number }, () => activation));
    yield* owner.add(Channels, serveChannel(
      { kind: "call", id: "selfconf.set", payload: Schema.Number, success: Schema.Struct({ deferred: Schema.Boolean, value: Schema.Number }) },
      (value) => Effect.map(host.configure({ selfconf: { config: { value } } }), (report) => ({ ...answer(report.deferred), value: owner.config.value })).pipe(Effect.orDie),
    ));
    yield* owner.add(Channels, serveChannel({ kind: "call", id: "selfconf.restart", payload: Schema.Void, success: Answer }, () =>
      Effect.map(host.restart("selfconf", { force: true }), (report) => answer(report.deferred)).pipe(Effect.orDie),
    ));
    yield* owner.add(Channels, serveChannel({ kind: "call", id: "selfconf.reload", payload: Schema.Void, success: Answer }, () =>
      Effect.map(host.reload, (report) => answer(report.deferred)).pipe(Effect.orDie),
    ));
    yield* owner.add(Channels, serveChannel({ kind: "stream", id: "selfconf.watch", payload: Schema.Number, success: Answer }, (value) =>
      Stream.concat(Stream.fromEffect(Effect.map(host.configure({ selfconf: { config: { value } } }), (report) => answer(report.deferred)).pipe(Effect.orDie)), Stream.never),
    ));
    yield* owner.add(Channels, serveChannel({ kind: "stream", id: "selfconf.reloading", payload: Schema.Void, success: Answer }, () =>
      Stream.concat(Stream.fromEffect(Effect.map(host.reload, (report) => answer(report.deferred)).pipe(Effect.orDie)), Stream.never),
    ));
  },
});
`;
  /** What clients last heard of selfconf: its version in the last plugin list published. */
  const heard = `import { Effect, Schema } from "effect";
import { definePlugin } from "@lemma/core";
import { Channels, PluginsChanged, serveChannel } from "@lemma/contracts";
export default definePlugin({
  id: "heard",
  setup: function* (_, owner) {
    let version = null;
    yield* owner.observe(PluginsChanged, ({ plugins }) => Effect.sync(() => {
      version = plugins.find((plugin) => plugin.id === "selfconf")?.version ?? null;
    }));
    yield* owner.add(Channels, serveChannel({ kind: "call", id: "heard.selfconf", payload: Schema.Void, success: Schema.NullOr(Schema.String) }, () => version));
  },
});
`;
  beforeAll(async () => {
    lemma = await startLemma("lemma-cli-self-", {
      prepare: async (home) => {
        await mkdir(join(home, "plugins"));
        await writeFile(join(home, "plugins", "selfconf.ts"), selfconf(1));
        await writeFile(join(home, "plugins", "heard.ts"), heard);
      },
    });
    home = lemma.home;
  }, 30_000);
  afterAll(() => lemma?.stop());
  printOnFailure(() => lemma?.output());

  /** Calls one of the plugin file's channels; it fails while the plugin is being replaced. */
  const call = async (id: string, payload?: unknown) => {
    const result = await invoke(["channels", "call", id, ...(payload === undefined ? [] : [JSON.stringify(payload)]), "--json"], home);
    if (result.code !== ExitCode.ok) throw new Error(result.err);
    return JSON.parse(result.out) as unknown;
  };

  // Waiting on its own plugin's reload, a call would last the dispose deadline (10 seconds), then fail Withdrawn.
  test("is answered deferred at once, and applies once the call has ended", async () => {
    const started = Date.now();
    expect(await call("selfconf.set", 7)).toEqual({ deferred: true, value: 0 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(
      await settled(
        () => call("selfconf.value"),
        (now) => now === 7,
      ),
    ).toBe(7);
  });

  test("a restart, or a reload, that restarts the plugin whose call asks for it is answered deferred at once, and applies once the call has ended", async () => {
    const activation = (await call("selfconf.activation")) as number;
    const restarting = Date.now();
    expect(await call("selfconf.restart")).toEqual({ deferred: true });
    expect(Date.now() - restarting).toBeLessThan(5_000);
    expect(
      await settled(
        () => call("selfconf.activation"),
        (now) => now === activation + 1,
      ),
    ).toBe(activation + 1);

    // An edited plugin file is a new definition, which a reload replaces the running one with; the host does not watch it.
    await writeFile(join(home, "plugins", "selfconf.ts"), selfconf(2));
    const reloading = Date.now();
    expect(await call("selfconf.reload")).toEqual({ deferred: true });
    expect(Date.now() - reloading).toBeLessThan(5_000);
    expect(
      await settled(
        () => call("selfconf.edition"),
        (now) => now === 2,
      ),
    ).toBe(2);
  });

  // A stream ends as soon as its plugin leaves, so it holds nothing up: deferred, the change would wait until its client closed it.
  test("a change a stream asks for applies at once, ending the stream Withdrawn, and clients hear it", async () => {
    const opened = await invoke(["channels", "open", "selfconf.watch", "9", "--json"], home);
    expect(opened.code).toBe(ExitCode.failed);
    expect(JSON.parse(opened.err).error).toMatchObject({ code: "Withdrawn", subject: "selfconf.watch" });
    expect(
      await settled(
        () => call("selfconf.value"),
        (now) => now === 9,
      ),
    ).toBe(9);

    // Ended midway through the reload it asked for, which still runs to its end and publishes the new plugin list.
    await writeFile(join(home, "plugins", "selfconf.ts"), selfconf(3));
    const reloaded = await invoke(["channels", "open", "selfconf.reloading", "--json"], home);
    expect(reloaded.code).toBe(ExitCode.failed);
    expect(JSON.parse(reloaded.err).error).toMatchObject({ code: "Withdrawn", subject: "selfconf.reloading" });
    expect(
      await settled(
        () => call("heard.selfconf"),
        (now) => now === "3",
      ),
    ).toBe("3");
  });

  // The general rule through a bundled plugin: llm's own call changes llm's config, which restarts llm alone.
  test("llm.add-custom answers at once with the new provider's id, listed once llm has reloaded", async () => {
    const started = Date.now();
    const spec = { name: "Local", api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", models: ["m"] };
    const added = await invoke(["channels", "call", "llm.add-custom", JSON.stringify({ spec }), "--json"], home);
    expect(added.code).toBe(ExitCode.ok);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(JSON.parse(added.out)).toBe("local");
    const listed = async () => (JSON.parse((await invoke(["providers", "--json"], home)).out) as { id: string }[]).some((provider) => provider.id === "local");
    expect(await settled(listed, (found) => found)).toBe(true);
  });
});
