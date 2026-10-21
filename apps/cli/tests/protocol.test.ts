import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { HOST_PROTOCOL } from "@lemma/contracts";
import { ExitCode } from "../src/cli.ts";
import { invoke } from "./invoke.ts";

// A host from before Lemma's RPC moved to Effect 4: its health check names no protocol, and it rejects every call.
describe("a host on another RPC protocol", () => {
  let home: string;
  let url: string;
  const older = createServer((request, response) => {
    if (request.url?.startsWith("/api/health")) {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, version: "0.1.0" }));
    } else {
      response.writeHead(500).end("Invalid request id: 0");
    }
  });

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "lemma-cli-protocol-"));
    await new Promise<void>((resolve) => older.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(older.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => older.close(resolve));
    await rm(home, { recursive: true, force: true });
  });

  test("is named, with what to do, instead of a failure that says nothing", async () => {
    const result = await invoke(["status"], home, "/", { LEMMA_URL: url, LEMMA_TOKEN: "token" });
    expect(result.code).toBe(ExitCode.unavailable);
    expect(result.err).toContain(`The host at ${url} runs another version of Lemma: it speaks RPC protocol 1, this command ${HOST_PROTOCOL}`);
    expect(result.err).toContain("Restart it from this version");
  });
  test("is stopped and started again by restart --force, from what its transport.json says, and not without it", async () => {
    // Its process: a stand-in that SIGTERM ends, as it does a host.
    const process_ = spawn("sleep", ["30"], { stdio: "ignore" });
    const local = await mkdtemp(join(tmpdir(), "lemma-cli-protocol-local-"));
    try {
      await writeFile(
        join(local, "transport.json"),
        JSON.stringify({ url, token: "token", pid: process_.pid, startedAt: Date.now(), cwd: local, startedBy: "cli" }),
      );
      const refused = await invoke(["restart", "--json"], local);
      expect(refused.code).toBe(ExitCode.unavailable);
      expect(JSON.parse(refused.err).error).toMatchObject({
        code: "OtherVersion",
        message: expect.stringContaining("lemma restart --force restarts it all the same"),
      });
      expect(process_.exitCode).toBeNull();
      // With --force it stops it, then starts a host as this lemma, which the test gives no way to: so far is the fallback.
      const exited = once(process_, "exit");
      const forced = await invoke(["restart", "--force", "--json"], local);
      await exited;
      expect(JSON.parse(forced.err).error.code).toBe("Unsupported");
    } finally {
      process_.kill();
      await rm(local, { recursive: true, force: true });
    }
  });
});
