import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
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
    expect(result.err).toContain(`The host at ${url} runs another version of Lemma: it speaks RPC protocol 1, this command 2`);
    expect(result.err).toContain("Restart it from this version");
  });
});
