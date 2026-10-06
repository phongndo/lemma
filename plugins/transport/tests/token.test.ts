import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

// 0xf8 encodes as `-` in base64url; the second draw is all zeros, `A…`.
const draws = [Buffer.alloc(24, 0xf8), Buffer.alloc(24, 0)];
vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomBytes: (size: number) => draws.shift()!.subarray(0, size),
}));

const { loadToken } = await import("../src/token.ts");

let home: string | undefined;
afterEach(() => (home === undefined ? undefined : fs.rm(home, { recursive: true, force: true })));

describe("loadToken", () => {
  it("never makes a token starting with -, which `--token <token>` would take for an option", async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-token-"));
    expect(await Effect.runPromise(loadToken(home))).toBe("A".repeat(32));
  });
});
