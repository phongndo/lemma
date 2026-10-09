import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startLemma } from "../../../scripts/e2e.ts";
import type { Lemma } from "../../../scripts/e2e.ts";
import { ExitCode, run } from "../src/cli.ts";
import { invoke, printOnFailure } from "./invoke.ts";

describe("from another machine", () => {
  let lemma: Lemma;
  let home: string;
  // `other` stands for the client machine: a home with no local host, only what `lemma remote` writes.
  let other: string;
  let url: string;
  let token: string;
  // A host that does not answer: it hangs up on every connection, and holds its port so nothing else takes it.
  const deadEnd = createServer((socket) => socket.destroy());
  let dead: string;
  beforeAll(async () => {
    lemma = await startLemma("lemma-cli-remote-");
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
  const remoteFile = () => join(other, "remote.json");

  test("token prints the local host's token; remote set checks it against the host before saving it", async () => {
    expect(await invoke(["token"], home)).toMatchObject({ code: ExitCode.ok, out: token });

    const wrong = await invoke(["remote", "set", url, "--token", "wrong", "--json"], other);
    expect(wrong.code).toBe(ExitCode.unavailable);
    expect(JSON.parse(wrong.err).error).toMatchObject({ code: "Unauthorized" });
    // `--token=`: a token written before hosts stopped making ones that start with "-" would read as an option.
    const unreachable = await invoke(["remote", "set", dead, `--token=${token}`, "--json"], other);
    expect(unreachable.code).toBe(ExitCode.unavailable);
    expect(JSON.parse(unreachable.err).error).toMatchObject({ code: "Unreachable" });
    expect(existsSync(remoteFile())).toBe(false);

    const set = await invoke(["remote", "set", `${url}/`, `--token=${token}`, "--json"], other);
    expect(set.code).toBe(ExitCode.ok);
    expect(JSON.parse(set.out)).toMatchObject({ url, from: remoteFile(), info: { home } });
    expect(JSON.parse(await readFile(remoteFile(), "utf8"))).toEqual({ url, token });
    expect((await stat(remoteFile())).mode & 0o777).toBe(0o600);

    // The token can come from LEMMA_TOKEN, or be asked for without echoing it.
    expect((await invoke(["remote", "set", url], other, "/", { LEMMA_TOKEN: token })).code).toBe(ExitCode.ok);
    const asked: boolean[] = [];
    const code = await run(["remote", "set", url], {
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
    expect(JSON.parse(await readFile(remoteFile(), "utf8"))).toEqual({ url, token });
  });

  test("commands go to the host in remote.json; remote names it without the token", async () => {
    await writeFile(remoteFile(), JSON.stringify({ url, token }));
    const shown = await invoke(["remote"], other);
    expect(shown.out).toBe(`${url} (from ${remoteFile()})`);
    expect(JSON.parse((await invoke(["remote", "--json"], other)).out)).toEqual({ source: "remote", url, from: remoteFile(), tokenSet: true });

    const status = JSON.parse((await invoke(["status", "--json"], other)).out);
    expect(status).toMatchObject({ url, source: "remote", info: { home } });
    expect(status.pid).toBeUndefined();
    expect((await invoke(["status"], other)).out).toContain(`${url} (from ${remoteFile()}, transport`);
    const listed = JSON.parse((await invoke(["session", "list", "--all", "--json"], other)).out);
    expect(listed).toEqual(JSON.parse((await invoke(["session", "list", "--all", "--json"], home)).out));
    const opened = new URL(JSON.parse((await invoke(["open", "--json"], other)).out).url);
    expect([opened.origin, opened.searchParams.get("token")]).toEqual([url, token]);
    // `token` is about this machine's host, and there is none here.
    expect(JSON.parse((await invoke(["token", "--json"], other)).err).error.code).toBe("NoHost");
  });

  test("LEMMA_URL and LEMMA_TOKEN override remote.json", async () => {
    await writeFile(remoteFile(), JSON.stringify({ url: dead, token }));
    const env = { LEMMA_URL: url, LEMMA_TOKEN: token };
    expect(JSON.parse((await invoke(["remote", "--json"], other, "/", env)).out)).toMatchObject({ source: "env", url, from: "LEMMA_URL" });
    expect(JSON.parse((await invoke(["status", "--json"], other, "/", env)).out)).toMatchObject({ url, source: "env", info: { home } });
    const wrong = await invoke(["status", "--json"], other, "/", { ...env, LEMMA_TOKEN: "wrong" });
    expect(JSON.parse(wrong.err).error).toMatchObject({ code: "Unauthorized" });
    expect(JSON.parse(wrong.err).error.message).toContain("LEMMA_TOKEN");
  });

  test("a remote host that does not answer is NoHost, naming its URL and the way back", async () => {
    await writeFile(remoteFile(), JSON.stringify({ url: dead, token }));
    // A command that watches the host fails as one that makes a call does: at once, saying the same.
    for (const command of [["status"], ["events"]]) {
      const down = await invoke([...command, "--json"], other);
      expect(down.code).toBe(ExitCode.unavailable);
      const error = JSON.parse(down.err).error;
      expect(error.code).toBe("NoHost");
      expect(error.message).toContain(dead);
      expect(error.message).toContain("lemma remote clear");
    }

    await writeFile(remoteFile(), JSON.stringify({ url, token: "stale" }));
    for (const command of [["status"], ["events"]]) {
      const stale = JSON.parse((await invoke([...command, "--json"], other)).err).error;
      expect(stale.code).toBe("Unauthorized");
      expect(stale.message).toContain(remoteFile());
    }

    // An unusable file is an error, never a silent fallback to the local host.
    await writeFile(remoteFile(), "{");
    expect(JSON.parse((await invoke(["status", "--json"], other)).err).error.message).toContain(`Cannot use ${remoteFile()}`);
  });

  test("remote clear removes remote.json: back to the local host", async () => {
    await writeFile(remoteFile(), JSON.stringify({ url, token }));
    expect(JSON.parse((await invoke(["remote", "clear", "--json"], other)).out)).toEqual({ removed: true, from: remoteFile() });
    expect(existsSync(remoteFile())).toBe(false);
    expect(JSON.parse((await invoke(["remote", "clear", "--json"], other)).out)).toEqual({ removed: false, from: remoteFile() });
    expect(JSON.parse((await invoke(["status", "--json"], other)).err).error.code).toBe("NoHost");
  });
});
