import { readFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { settled, startLemma } from "../../../scripts/e2e.ts";
import type { Lemma } from "../../../scripts/e2e.ts";
import { ExitCode, run } from "../src/cli.ts";
import { invoke, printOnFailure } from "./invoke.ts";

/** A TCP proxy to the host that can be cut (every socket destroyed, new ones refused) and restored. */
const proxy = async (target: number) => {
  const sockets = new Set<Socket>();
  let down = false;
  const server = createServer((client) => {
    if (down) return void client.destroy();
    const upstream = createConnection(target, "127.0.0.1");
    sockets.add(client);
    sockets.add(upstream);
    client.pipe(upstream);
    upstream.pipe(client);
    const end = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on("error", end).on("close", end);
    upstream.on("error", end).on("close", end);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    cut: () => {
      down = true;
      for (const socket of sockets) socket.destroy();
    },
    restore: () => {
      down = false;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

const lost = "lemma: lost the connection to the host; reconnecting…";
const back = "lemma: reconnected to the host";

// A real host, reached through a proxy the test cuts while a turn runs: the agent goes on meanwhile.
describe("a run across a cut connection", () => {
  let lemma: Lemma;
  let home: string;
  let env: Record<string, string>;
  let link: Awaited<ReturnType<typeof proxy>>;
  beforeAll(async () => {
    lemma = await startLemma("lemma-cli-reconnect-");
    home = lemma.home;
    const discovery = JSON.parse(await readFile(join(home, "transport.json"), "utf8")) as { url: string; token: string };
    link = await proxy(Number(new URL(discovery.url).port));
    env = { LEMMA_HOME: home, LEMMA_URL: `http://127.0.0.1:${link.port}`, LEMMA_TOKEN: discovery.token };
  }, 30_000);
  afterAll(async () => {
    await link?.close();
    await lemma?.stop();
  });
  printOnFailure(() => lemma?.output());

  /** Resolves once the session's turn has ended, as the host has it (asked directly, not through the proxy). */
  const over = async (session: string) => {
    const ended = await settled(async () => !(JSON.parse((await invoke(["status", "--json"], home)).out).running as string[]).includes(session) || undefined);
    if (ended === undefined) throw new Error(`the turn in ${session} did not end`);
  };

  /** The log events with the prompt's message: one, however often it was sent. */
  const placed = async (session: string, requestId: string) => {
    const { branch } = JSON.parse((await invoke(["session", "show", session, "--json"], home)).out) as {
      branch: { data: { type: string; requestId?: string } }[];
    };
    return branch.filter((event) => event.data.type === "message" && event.data.requestId === requestId).length;
  };

  for (const json of [false, true]) {
    test(`--follow${json ? " --json" : ""} shows the rest of the turn once it is back, nothing twice, and places the prompt once`, async () => {
      const session = (await invoke(["session", "new", "--cwd", home], home)).out;
      const gate = `cut${json ? "j" : "t"}`;
      let shown = "";
      const said: string[] = [];
      const running = run(["run", session, `ramble on gate:${gate}`, "--request-id", `r-${gate}`, "--follow", ...(json ? ["--json"] : [])], {
        env,
        cwd: "/",
        out: (text) => {
          shown += `${text}\n`;
        },
        write: (text) => {
          shown += text;
        },
        err: (text) => void said.push(text),
      });
      await lemma.mock.reached(gate);
      await settled(
        async () => shown,
        (text) => text.includes(json ? '"delta":"word30 "' : "word30 "),
      );
      link.cut();
      expect(await settled(async () => said.includes(lost) || undefined)).toBe(true);
      lemma.mock.open(gate);
      // The agent goes on while the command is cut off: its turn ends before the command is back.
      await over(session);
      link.restore();
      expect(await running).toBe(ExitCode.ok);
      expect(said).toEqual([lost, back]);
      if (!json) {
        const words = [...shown.matchAll(/word(\d+)/g)].map((match) => Number(match[1]));
        expect(words).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
      } else {
        const lines = shown
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { type: string; event?: { seq: number }; stepId?: string; seq?: number });
        // The log's events once each, in order; the live output during the cut is lost, as a slow client's would be.
        const appended = lines.filter((line) => line.type === "appended").map((line) => line.event!.seq);
        expect(appended).toEqual([...new Set(appended)].sort((a, b) => a - b));
        const deltas = lines.filter((line) => line.type === "delta").map((line) => `${line.stepId}:${line.seq}`);
        expect(new Set(deltas).size).toBe(deltas.length);
        expect(lines.at(-1)).toMatchObject({ type: "result", reason: "done" });
      }
      expect(await placed(session, `r-${gate}`)).toBe(1);
    }, 60_000);
  }

  test("without --follow ends with the turn's result once it is back", async () => {
    const session = (await invoke(["session", "new", "--cwd", home], home)).out;
    let out = "";
    const said: string[] = [];
    const running = run(["run", session, "ramble on gate:plain", "--request-id", "r-plain", "--json"], {
      env,
      cwd: "/",
      out: (text) => {
        out += text;
      },
      err: (text) => void said.push(text),
    });
    await lemma.mock.reached("plain");
    link.cut();
    expect(await settled(async () => said.includes(lost) || undefined)).toBe(true);
    lemma.mock.open("plain");
    await over(session);
    link.restore();
    expect(await running).toBe(ExitCode.ok);
    expect(JSON.parse(out)).toMatchObject({ reason: "done" });
    expect(said).toEqual([lost, back]);
    expect(await placed(session, "r-plain")).toBe(1);
  }, 60_000);
});
