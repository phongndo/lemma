import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { startLemma } from "../../../scripts/e2e.ts";
import type { Lemma } from "../../../scripts/e2e.ts";
import { ExitCode, run } from "../src/cli.ts";
import { invoke, printOnFailure } from "./invoke.ts";

describe("environments: hosts on other machines", () => {
  let lemma: Lemma;
  let home: string;
  // `other` stands for the client machine: a home with no local host, only what `lemma env` writes.
  let other: string;
  let url: string;
  let token: string;
  // A host that does not answer: it hangs up on every connection, and holds its port so nothing else takes it.
  const deadEnd = createServer((socket) => socket.destroy());
  let dead: string;
  beforeAll(async () => {
    lemma = await startLemma("lemma-cli-env-");
    home = lemma.home;
    other = await mkdtemp(join(tmpdir(), "lemma-cli-client-"));
    ({ url, token } = JSON.parse(await readFile(join(home, "transport.json"), "utf8")));
    await new Promise<void>((resolve) => deadEnd.listen(0, "127.0.0.1", resolve));
    dead = `http://127.0.0.1:${(deadEnd.address() as AddressInfo).port}`;
  }, 30_000);
  afterAll(async () => {
    deadEnd.close();
    await lemma?.stop();
    if (other !== undefined) await rm(other, { recursive: true, force: true });
  });
  printOnFailure(() => lemma?.output());
  const file = () => join(other, "environments.json");
  const saved = async () => JSON.parse(await readFile(file(), "utf8")) as { default?: string; environments: Record<string, { url: string; token: string }> };
  beforeEach(() => rm(file(), { force: true }));

  test("token prints the local host's token; env add checks it against the host before saving it", async () => {
    expect(await invoke(["token"], home)).toMatchObject({ code: ExitCode.ok, out: token });

    const wrong = await invoke(["env", "add", "box", url, "--token", "wrong", "--json"], other);
    expect(wrong.code).toBe(ExitCode.unavailable);
    expect(JSON.parse(wrong.err).error).toMatchObject({ code: "Unauthorized" });
    // `--token=`: a token that starts with "-" would read as an option.
    const unreachable = await invoke(["env", "add", "box", dead, `--token=${token}`, "--json"], other);
    expect(unreachable.code).toBe(ExitCode.unavailable);
    expect(JSON.parse(unreachable.err).error).toMatchObject({ code: "Unreachable" });
    expect(existsSync(file())).toBe(false);

    const added = await invoke(["env", "add", "box", `${url}/`, `--token=${token}`, "--json"], other);
    expect(added.code).toBe(ExitCode.ok);
    expect(JSON.parse(added.out)).toEqual({ name: "box", url, default: "local", home });
    expect(await saved()).toEqual({ environments: { box: { url, token } } });
    expect((await stat(file())).mode & 0o777).toBe(0o600);

    // The token can come from LEMMA_TOKEN, or be asked for without echoing it; --use makes it the default.
    expect((await invoke(["env", "add", "lab", url], other, "/", { LEMMA_TOKEN: token })).code).toBe(ExitCode.ok);
    const asked: boolean[] = [];
    const code = await run(["env", "add", "desk", url, "--use"], {
      env: { LEMMA_HOME: other },
      cwd: "/",
      out: () => {},
      err: () => {},
      ask: async (_question, secret) => {
        asked.push(secret);
        return `${token}\n`;
      },
    });
    expect([code, asked]).toEqual([ExitCode.ok, [true]]);
    expect(await saved()).toEqual({ default: "desk", environments: { box: { url, token }, lab: { url, token }, desk: { url, token } } });

    // Names and URLs it cannot use, and no token with no terminal to ask at.
    for (const argv of [
      ["env", "add", "local", url, "--token", token],
      ["env", "add", "Box", url, "--token", token],
      ["env", "add", "box", "https://box.example.ts.net/lemma", "--token", token],
      ["env", "add", "box", "ftp://box.example.ts.net", "--token", token],
      ["env", "add", "box", url],
    ])
      expect((await invoke(argv, other)).code, argv.join(" ")).toBe(ExitCode.usage);
  });

  test("env lists local and the saved ones, which answers, and the default; env use and env remove change them", async () => {
    await writeFile(file(), JSON.stringify({ environments: { box: { url, token }, gone: { url: dead, token } } }));
    const listed = JSON.parse((await invoke(["env", "--json"], other)).out);
    expect(listed).toEqual({
      default: "local",
      environments: [
        { name: "local", url: null, state: "not running", default: true },
        { name: "box", url, state: "up", default: false },
        { name: "gone", url: dead, state: "down", default: false },
      ],
    });
    expect((await invoke(["env", "-q"], other)).out.split("\n")).toEqual(["local", "box", "gone"]);

    // Commands go to the local host, which runs nowhere here, until another is the default.
    expect(JSON.parse((await invoke(["status", "--json"], other)).err).error.code).toBe("NoHost");
    expect(JSON.parse((await invoke(["env", "use", "box", "--json"], other)).out)).toEqual({ default: "box" });
    expect((await saved()).default).toBe("box");
    const status = JSON.parse((await invoke(["status", "--json"], other)).out);
    expect(status).toMatchObject({ environment: "box", url, source: "saved", info: { home } });
    expect(status.pid).toBeUndefined();
    expect((await invoke(["status"], other)).out).toContain(`box (${url}, from ${file()})`);
    expect(JSON.parse((await invoke(["sessions", "list", "--all", "--json"], other)).out)).toEqual(
      JSON.parse((await invoke(["sessions", "list", "--all", "--json"], home)).out),
    );
    const opened = new URL(JSON.parse((await invoke(["open", "--json"], other)).out).url);
    expect([opened.origin, opened.searchParams.get("token")]).toEqual([url, token]);
    // `token` is about this machine's host, and there is none here.
    expect(JSON.parse((await invoke(["token", "--json"], other)).err).error.code).toBe("NoHost");

    expect((await invoke(["env", "use", "nope", "--json"], other)).code).toBe(ExitCode.failed);
    // Removing the default goes back to local.
    expect(JSON.parse((await invoke(["env", "remove", "box", "--json"], other)).out)).toEqual({ removed: true, name: "box" });
    expect(await saved()).toEqual({ environments: { gone: { url: dead, token } } });
    expect(JSON.parse((await invoke(["env", "remove", "box", "--json"], other)).out)).toEqual({ removed: false, name: "box" });
    expect(JSON.parse((await invoke(["env", "use", "local", "--json"], other)).out)).toEqual({ default: "local" });
  });

  test("--env picks one for a command, over LEMMA_ENV, which is over the default; local is this machine's", async () => {
    await writeFile(file(), JSON.stringify({ default: "gone", environments: { box: { url, token }, gone: { url: dead, token } } }));
    expect(JSON.parse((await invoke(["status", "--json"], other, "/", { LEMMA_ENV: "box" })).out)).toMatchObject({ environment: "box" });
    expect(JSON.parse((await invoke(["status", "--env", "box", "--json"], other, "/", { LEMMA_ENV: "gone" })).out)).toMatchObject({ environment: "box" });
    // The flag may come anywhere before `--`.
    expect(JSON.parse((await invoke(["--env=box", "status", "--json"], other)).out)).toMatchObject({ environment: "box", source: "saved" });
    expect(JSON.parse((await invoke(["status", "--env", "local", "--json"], other)).err).error.code).toBe("NoHost");
    const listed = JSON.parse((await invoke(["env", "--json"], other, "/", { LEMMA_ENV: "box" })).out);
    expect(listed).toMatchObject({ default: "gone", overriddenBy: "LEMMA_ENV=box" });

    // One it does not have is said so, never a fallback to another host.
    for (const [argv, env] of [
      [["status", "--env", "nope", "--json"], {}],
      [["status", "--json"], { LEMMA_ENV: "nope" }],
    ] as const) {
      const unknown = await invoke(argv, other, "/", env);
      expect(unknown.code).toBe(ExitCode.unavailable);
      expect(JSON.parse(unknown.err).error).toMatchObject({ code: "UnknownEnvironment", message: expect.stringContaining('No environment "nope"') });
    }
    // Commands that act on this machine's host refuse another.
    expect((await invoke(["stop", "--env", "box"], other)).code).toBe(ExitCode.usage);
  });

  test("LEMMA_URL and LEMMA_TOKEN override the environments, unless --env names one", async () => {
    await writeFile(file(), JSON.stringify({ default: "gone", environments: { box: { url, token }, gone: { url: dead, token } } }));
    const env = { LEMMA_URL: url, LEMMA_TOKEN: token };
    expect(JSON.parse((await invoke(["status", "--json"], other, "/", env)).out)).toMatchObject({
      url,
      source: "env",
      environment: "LEMMA_URL",
      info: { home },
    });
    expect(JSON.parse((await invoke(["env", "--json"], other, "/", env)).out)).toMatchObject({ overriddenBy: "LEMMA_URL" });
    const wrong = await invoke(["status", "--json"], other, "/", { ...env, LEMMA_TOKEN: "wrong" });
    expect(JSON.parse(wrong.err).error).toMatchObject({ code: "Unauthorized", message: expect.stringContaining("LEMMA_TOKEN") });
    expect(JSON.parse((await invoke(["status", "--env", "box", "--json"], other, "/", { ...env, LEMMA_TOKEN: "wrong" })).out)).toMatchObject({
      environment: "box",
    });
    // LEMMA_URL names the host only together with its token, and only as a base URL.
    expect((await invoke(["status"], other, "/", { LEMMA_URL: url })).code).toBe(ExitCode.usage);
    expect((await invoke(["status"], other, "/", { LEMMA_URL: "box", LEMMA_TOKEN: token })).code).toBe(ExitCode.usage);
  });

  test("an environment that does not answer is NoHost, naming its URL and the way back; a stale token, where it came from", async () => {
    await writeFile(file(), JSON.stringify({ default: "gone", environments: { gone: { url: dead, token }, stale: { url, token: "stale" } } }));
    // A command that watches the host, or runs a plugin's command, fails as one that makes a call does: at once, saying the same.
    for (const command of [["status"], ["events"], ["sessions", "list"]]) {
      const down = await invoke([...command, "--json"], other);
      expect(down.code, command.join(" ")).toBe(ExitCode.unavailable);
      const error = JSON.parse(down.err).error;
      expect(error.code).toBe("NoHost");
      expect(error.message).toContain(dead);
      expect(error.message).toContain("lemma env use local");
    }
    for (const command of [["status"], ["events"]]) {
      const stale = JSON.parse((await invoke([...command, "--env", "stale", "--json"], other)).err).error;
      expect(stale.code).toBe("Unauthorized");
      expect(stale.message).toContain("lemma env add stale");
    }

    // An unusable file is an error, never a silent fallback to the local host.
    await writeFile(file(), "{");
    const broken = await invoke(["status", "--json"], other);
    expect(broken.code).toBe(ExitCode.unavailable);
    expect(JSON.parse(broken.err).error.message).toContain(`Cannot use ${file()}`);
  });
});
