import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { eventId, IdBytes, sessionId } from "../src/format.ts";

describe("ids", () => {
  it("never start with -, which a command line would take for an option", () => {
    // 0xf8 encodes as `-` in base64url; the second draw is all zeros, `A…`.
    const draws = [new Uint8Array(9).fill(0xf8), new Uint8Array(9)];
    const id = Effect.runSync(sessionId.pipe(Effect.provideService(IdBytes, (size) => draws.shift()!.subarray(0, size))));
    expect(id).toBe("AAAAAAAAAAAA");
  });

  it("are url-safe, 12 characters for sessions and 8 for events, from the system's secure source by default", () => {
    const [session, event] = Effect.runSync(Effect.all([sessionId, eventId]));
    expect(session).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_-]{11}$/);
    expect(event).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_-]{7}$/);
  });
});
