import { describe, expect, it } from "vitest";
import type { SessionInfo } from "@lemma/sessions";
import { byDay } from "../src/groups.ts";

const now = new Date(2026, 9, 15, 14, 0).getTime();
const at = (days: number, hours = 0) => new Date(2026, 9, 15 - days, 12 + hours).getTime();
const session = (id: string, updatedAt: number) => ({ id, updatedAt, cwd: "/p" }) as unknown as SessionInfo;

describe("byDay", () => {
  it("groups threads newest first by when they were last used", () => {
    const groups = byDay([session("old", at(3)), session("now", at(0)), session("y", at(1)), session("month", at(20))], now);
    expect(groups.map((group) => [group.label, group.sessions.map((s) => s.id)])).toEqual([
      ["Today", ["now"]],
      ["Yesterday", ["y"]],
      ["Previous 7 days", ["old"]],
      ["Previous 30 days", ["month"]],
    ]);
  });

  it("names older months, with the year when it is not this one", () => {
    const groups = byDay([session("aug", new Date(2026, 7, 2).getTime()), session("2025", new Date(2025, 11, 2).getTime())], now);
    expect(groups.map((group) => group.label)).toEqual([
      new Date(2026, 7, 2).toLocaleDateString(undefined, { month: "long" }),
      new Date(2025, 11, 2).toLocaleDateString(undefined, { month: "long", year: "numeric" }),
    ]);
  });
});
