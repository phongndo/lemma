import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { builtins, ExitCode, jsonByDefault, run, splitGlobals, VERSION } from "../src/cli.ts";
import { CliError } from "../src/command.ts";
import { formatQuestions } from "../src/format.ts";
import { toAnswer } from "../src/questions.ts";
import { invoke } from "./invoke.ts";

describe("global flags", () => {
  test("are read wherever they are before `--`, and the rest is the command line", () => {
    const split = splitGlobals(["sessions", "--json", "list", "-q", "--env=box", "--answer", "yes", "--fields", "id, title", "--all", "--", "--json"], {});
    expect(split).not.toBeInstanceOf(CliError);
    const { globals, rest } = split as Exclude<typeof split, CliError>;
    expect(rest).toEqual(["sessions", "list", "--all", "--", "--json"]);
    expect(globals).toMatchObject({ json: true, quiet: true, env: "box", answers: ["yes"], fields: ["id", "title"], help: false, version: false });
    expect(splitGlobals(["status", "-h"], {})).toMatchObject({ globals: { help: true }, rest: ["status"] });
    for (const argv of [["--json", "--text"], ["--env"], ["--questions", "maybe"], ["--fields"]])
      expect(splitGlobals(argv, {}), argv.join(" ")).toBeInstanceOf(CliError);
  });

  test("print JSON by default under an agent's shell or LEMMA_OUTPUT=json; --text and LEMMA_OUTPUT=text say otherwise", () => {
    expect(jsonByDefault({})).toBe(false);
    for (const name of ["LEMMA_AGENT", "CLAUDECODE", "GEMINI_CLI", "CODEX_SANDBOX", "CURSOR_AGENT"]) expect(jsonByDefault({ [name]: "1" }), name).toBe(true);
    expect(jsonByDefault({ CLAUDECODE: "0" })).toBe(false);
    expect(jsonByDefault({ CLAUDECODE: " " })).toBe(false);
    expect(jsonByDefault({ LEMMA_OUTPUT: "json" })).toBe(true);
    expect(jsonByDefault({ LEMMA_AGENT: "1", LEMMA_OUTPUT: "text" })).toBe(false);
    expect(splitGlobals(["status"], { CLAUDECODE: "1" })).toMatchObject({ globals: { json: true } });
    expect(splitGlobals(["status", "--text"], { CLAUDECODE: "1" })).toMatchObject({ globals: { json: false } });
  });
});

describe("without a host", () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "lemma-cli-"));
  });
  afterAll(() => rm(home, { recursive: true, force: true }));

  test("reports a missing host as unavailable; a plugin's command says only a running host has it", async () => {
    const result = await invoke(["status", "--json"], home);
    expect(result.code).toBe(ExitCode.unavailable);
    expect(JSON.parse(result.err).error.code).toBe("NoHost");
    const hosted = await invoke(["sessions", "list"], home);
    expect(hosted.code).toBe(ExitCode.unavailable);
    expect(hosted.err).toContain(`"lemma sessions list" is no command of lemma's own`);
    // A typo of one of lemma's own is said so.
    const typo = await invoke(["statsu"], home);
    expect([typo.code, typo.err]).toEqual([ExitCode.usage, expect.stringContaining('did you mean "lemma status"?')]);
  });

  test("under an agent, output and errors are JSON unless --text says otherwise; the process env is never read", async () => {
    const agent = { CLAUDECODE: "1" };
    expect(JSON.parse((await invoke(["status"], home, "/", agent)).err).error.code).toBe("NoHost");
    expect((await invoke(["status", "--text"], home, "/", agent)).err).toMatch(/^lemma: No running Lemma host/);
    // A command line that fails before its globals are read says so as they ask.
    expect((await invoke(["--text", "--questions", "bogus", "status"], home, "/", agent)).err).toMatch(/^lemma: --questions must be ask, ignore, or dismiss/);
    expect((await invoke(["status"], home, "/", { LEMMA_OUTPUT: "json" })).err).toMatch(/^\{"error":/);
    // `invoke` passes only LEMMA_HOME: whatever this test runs under (an agent, say), the output is text.
    expect((await invoke(["status"], home)).err).toMatch(/^lemma: /);
    expect(await invoke(["--version"], home)).toMatchObject({ code: ExitCode.ok, out: VERSION });
    expect(JSON.parse((await invoke(["--version"], home, "/", agent)).out)).toEqual({ version: VERSION });
  });

  test("an interrupted command exits 130", async () => {
    const interrupt = new AbortController();
    interrupt.abort();
    const code = await run(["status"], { env: { LEMMA_HOME: home }, cwd: "/", out: () => {}, err: () => {}, interrupt: interrupt.signal });
    expect(code).toBe(ExitCode.interrupted);
  });

  test("rejects bad usage of lemma's own commands before connecting", async () => {
    for (const argv of [
      ["--nope"],
      ["--json", "--text", "status"],
      ["--questions", "maybe", "status"],
      ["status", "extra"],
      ["token", "x"],
      ["answer", "q"],
      ["events", "x"],
      ["events", "--answer", "yes"],
      ["channels", "call"],
      ["channels", "open"],
      ["channels", "call", "ticker.quote", "{symbol: ACME}"],
      ["channels", "open", "ticker.prices", "{}", "x"],
      ["kernel", "nope"],
      ["env", "bogus"],
      ["env", "add"],
      ["env", "add", "box"],
      ["env", "use"],
      ["trust", "add", "a", "b"],
      ["config", "path", "x"],
      ["logs", "--lines", "many"],
      ["serve", "--port", "x"],
      ["completion"],
      ["completion", "tcsh"],
      ["help", "nope"],
      ["help", "status", "--all"],
    ]) {
      expect((await invoke(argv, home)).code, argv.join(" ")).toBe(ExitCode.usage);
    }
  });

  test("help lists lemma's own commands, and says the plugins' need a host; help --json describes each with a JSON Schema of its input", async () => {
    const text = await invoke(["--help"], home);
    expect(text.code).toBe(ExitCode.ok);
    expect(text.out).toContain("env add <name> <url>");
    expect(text.out).toContain("From the host's plugins: none answers now");
    expect((await invoke(["help", "env", "add"], home)).out).toContain("lemma env add <name> <url>");

    const help = JSON.parse((await invoke(["help", "--json"], home)).out) as {
      version: string;
      host: string | null;
      globalFlags: Record<string, unknown>;
      commands: { path: string[]; source: string; input: { type: string; properties: { args: { required: string[] }; flags: { properties: object } } } }[];
    };
    expect(help).toMatchObject({ version: VERSION, host: null });
    expect(Object.keys(help.globalFlags)).toEqual(expect.arrayContaining(["json", "text", "env", "quiet", "fields", "questions", "answer"]));
    expect(help.commands.map((command) => command.path.join(" "))).toEqual(builtins.map((command) => command.path.join(" ")));
    expect(help.commands.every((command) => command.source === "lemma" && command.input.type === "object")).toBe(true);
    const trust = help.commands.find((command) => command.path.join(" ") === "trust add")!;
    expect(trust.input.properties.args.required).toEqual([]);
    expect(JSON.parse((await invoke(["help", "logs", "--json"], home)).out).input.properties.flags.properties).toMatchObject({
      follow: { type: "boolean" },
      lines: { type: "number" },
    });
    // `status --help` is `help status`.
    expect((await invoke(["status", "--help"], home)).out).toBe((await invoke(["help", "status"], home)).out);
    // A plugin's command cannot be described without a host to ask.
    expect((await invoke(["help", "sessions"], home)).err).toContain("no host answers");
  });

  test("--quiet prints a command's ids, and --fields keeps those fields of each item", async () => {
    expect(await invoke(["env", "--quiet"], home)).toMatchObject({ code: ExitCode.ok, out: "local" });
    const doctor = JSON.parse((await invoke(["doctor", "--json", "--fields", "id,status"], home)).out) as object[];
    expect(doctor).toContainEqual({ id: "node", status: "ok" });
    expect(doctor.every((row) => Object.keys(row).join(",") === "id,status")).toBe(true);
    expect(JSON.parse((await invoke(["env", "--json", "--fields", "default"], home)).out)).toEqual({ default: "local" });
  });

  test("completion prints a shell's script, and completes words from lemma's own commands", async () => {
    expect((await invoke(["completion", "bash"], home)).out).toContain("complete -o default -F _lemma lemma");
    expect((await invoke(["__complete", "st"], home)).out.split("\n")).toEqual(["status", "stop"]);
    expect((await invoke(["__complete", "env", ""], home)).out.split("\n")).toEqual(["add", "remove", "use"]);
    expect((await invoke(["__complete", "logs", "--fo"], home)).out).toBe("--follow");
    expect((await invoke(["__complete", "--env", ""], home)).out).toBe("local");
    // Global flags before the word are left out of the command's.
    expect((await invoke(["__complete", "--json", "env", "u"], home)).out).toBe("use");
  });
});

describe("the config files", () => {
  let home: string;
  let project: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "lemma-cli-config-"));
    project = await mkdtemp(join(tmpdir(), "lemma-cli-project-"));
    return async () => {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    };
  });
  const userConfig = () => join(home, "config.jsonc");

  test("trust add and trust remove edit trustedProjects in the user's file, keeping its comments", async () => {
    await writeFile(
      userConfig(),
      `{
  // Turned off while I try another.
  "plugins": { "tools.bash": { "enabled": false } },
}
`,
    );
    expect(JSON.parse((await invoke(["trust", "--json"], home, project)).out)).toEqual({ trustedProjects: [], here: { cwd: project, trusted: false } });
    expect(JSON.parse((await invoke(["trust", "add", "--json"], home, project)).out)).toEqual({ trusted: project });
    const trusted = await readFile(userConfig(), "utf8");
    expect(trusted).toContain("// Turned off while I try another.");
    expect(parse(trusted)).toEqual({ plugins: { "tools.bash": { enabled: false } }, trustedProjects: [project] });
    expect((await invoke(["trust", "-q"], home, project)).out).toBe(project);
    // A directory inside a trusted one is trusted already.
    await mkdir(join(project, "sub"));
    expect(JSON.parse((await invoke(["trust", "add", "sub", "--json"], home, project)).out)).toEqual({ trusted: join(project, "sub"), unchanged: true });
    expect(JSON.parse((await invoke(["config", "path", "--json"], home, join(project, "sub"))).out)).toMatchObject({ trusted: true, home });

    expect(JSON.parse((await invoke(["trust", "remove", project, "--json"], home)).out)).toEqual({ removed: true, path: project });
    const after = await readFile(userConfig(), "utf8");
    expect(after).toContain("// Turned off while I try another.");
    expect(parse(after)).toEqual({ plugins: { "tools.bash": { enabled: false } } });
    expect(JSON.parse((await invoke(["trust", "remove", project, "--json"], home)).out)).toEqual({ removed: false, path: project });
  });

  test("trust add writes a user config where there is none", async () => {
    expect((await invoke(["trust", "add", project], home)).code).toBe(ExitCode.ok);
    expect(JSON.parse(await readFile(userConfig(), "utf8"))).toEqual({ trustedProjects: [project] });
  });

  test("config lists each setting, and with --show-origin the file it comes from; a project's file counts only once trusted", async () => {
    await writeFile(userConfig(), JSON.stringify({ plugins: { "agent.loop": { config: { maxSteps: 50 } } } }));
    await mkdir(join(project, ".lemma"));
    const projectConfig = join(project, ".lemma", "config.jsonc");
    await writeFile(projectConfig, JSON.stringify({ plugins: { "tools.bash": { enabled: false } } }));

    const untrusted = await invoke(["config"], home, project);
    expect(untrusted.out).toMatch(/^plugins\.agent\.loop\.config\.maxSteps +50$/m);
    expect(untrusted.out).toContain(`${projectConfig} is ignored: this project is not trusted (lemma trust add)`);
    expect(untrusted.out).not.toContain("tools.bash");

    await invoke(["trust", "add"], home, project);
    const shown = await invoke(["config", "--show-origin"], home, project);
    expect(shown.out).toMatch(new RegExp(`^plugins\\.agent\\.loop\\.config\\.maxSteps +50 +user: ${userConfig()}$`, "m"));
    expect(shown.out).toMatch(new RegExp(`^plugins\\.tools\\.bash\\.enabled +false +project: ${projectConfig}$`, "m"));
    const json = JSON.parse((await invoke(["config", "--json"], home, project)).out);
    expect(json).toMatchObject({ trusted: true, files: { user: userConfig(), project: projectConfig }, problems: [] });
    expect(json.settings).toContainEqual({ key: "plugins.tools.bash.enabled", value: false, scope: "project", file: projectConfig });
  });

  test("doctor fails on a problem, naming what to do; warnings alone pass", async () => {
    // No host and no web app are warnings: the setup is fine.
    const fine = await invoke(["doctor", "--json"], home);
    expect(fine.code).toBe(ExitCode.ok);
    const checks = JSON.parse(fine.out) as { id: string; status: string; fix?: string }[];
    expect(checks.find((check) => check.id === "host")).toMatchObject({ status: "warn", fix: expect.stringContaining("lemma serve") });

    await writeFile(userConfig(), "{ plugins: ");
    const broken = await invoke(["doctor"], home);
    expect(broken.code).toBe(ExitCode.failed);
    expect(broken.out).toMatch(/^FAIL +User config +.*config\.jsonc: /m);
    expect(broken.out).toContain("→ Fix it; lemma serve --safe starts without it meanwhile");

    await rm(userConfig());
    // An environment it does not have is a failure too: commands would go nowhere.
    const unknown = JSON.parse((await invoke(["doctor", "--env", "nope", "--json"], home)).out) as { id: string; status: string }[];
    expect(unknown.find((check) => check.id === "host")).toMatchObject({ status: "fail" });
  });
});

describe("questions", () => {
  test("answers are checked against the question", () => {
    const select = {
      type: "select" as const,
      id: "q",
      title: "Pick",
      options: [
        { value: "api_key", label: "API key" },
        { value: "oauth", label: "Subscription" },
      ],
    };
    expect(toAnswer(select, "oauth")).toEqual({ type: "select", value: "oauth" });
    expect(toAnswer(select, "api key")).toEqual({ type: "select", value: "api_key" });
    expect(toAnswer(select, "2")).toEqual({ type: "select", value: "oauth" });
    expect(toAnswer(select, "other")).toContain("Choose one of");
    expect(toAnswer({ type: "confirm", id: "c", title: "Go?" }, "Yes")).toEqual({ type: "confirm", value: true });
    expect(toAnswer({ type: "confirm", id: "c", title: "Go?" }, "maybe")).toContain("yes or no");
    expect(toAnswer({ type: "ask", id: "a", title: "Key" }, " sk ")).toEqual({ type: "ask", value: " sk " });
  });

  test("open questions show what they are about before their choices", () => {
    const approval = {
      type: "select" as const,
      id: "q1",
      title: "Run this command?",
      detail: "rm -rf build\nls",
      options: [
        { value: "once", label: "Allow once" },
        { value: "deny", label: "Deny" },
      ],
    };
    expect(formatQuestions([approval])).toBe("q1  select  Run this command?\n    rm -rf build\n    ls\n    1. once (Allow once)\n    2. deny (Deny)");
  });
});
