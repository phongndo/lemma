import { Cause } from "effect";
import { describe, expect, test } from "vitest";
import { causeMessage, errorMessage } from "../src/host.ts";

describe("errorMessage", () => {
  test("an Error's message, an object's message string, or the value as a string", () => {
    expect(errorMessage(new Error("broke"))).toBe("broke");
    expect(errorMessage({ _tag: "Failed", message: "said so" })).toBe("said so");
    expect(errorMessage({ message: 7 })).toBe("[object Object]");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(undefined)).toBe("undefined");
  });

  test("causeMessage says what the squashed cause does", () => {
    expect(causeMessage(Cause.fail(new Error("failed")))).toBe("failed");
    expect(causeMessage(Cause.die("died"))).toBe("died");
  });
});
