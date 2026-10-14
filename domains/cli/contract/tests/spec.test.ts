import { describe, expect, test } from "vitest";
import { closest, inputProblem, parseInput, renderHelp, specProblem, usageLine } from "../src/spec.ts";
import type { CommandSpec } from "../src/spec.ts";

const run: CommandSpec = {
  path: ["run"],
  summary: "Send a prompt",
  args: [
    { name: "session", description: "A session, or new", required: true },
    { name: "prompt", description: "The prompt", variadic: true },
  ],
  flags: {
    follow: { type: "boolean", short: "f", description: "Stream the turn" },
    model: { type: "string", description: "Model" },
    thinking: { type: "string", values: ["low", "high"], description: "Level" },
    image: { type: "file", multiple: true, description: "Attach" },
    limit: { type: "number", description: "At most" },
  },
};

describe("parseInput", () => {
  test("takes flags anywhere before --, and the rest positionally", () => {
    expect(parseInput(run, ["s1", "fix", "--follow", "the", "--model=a/b", "test", "--", "--not-a-flag"])).toEqual({
      args: { session: "s1", prompt: ["fix", "the", "test", "--not-a-flag"] },
      flags: { follow: true, model: "a/b", image: [] },
    });
  });

  test("reads values, numbers, repeats, and short flags", () => {
    expect(parseInput(run, ["new", "-f", "--image", "a.png", "--image=b.png", "--limit", "3", "--thinking", "high"])).toEqual({
      args: { session: "new", prompt: [] },
      flags: { follow: true, image: ["a.png", "b.png"], limit: 3, thinking: "high" },
    });
    expect(parseInput(run, ["new", "--follow=false"])).toMatchObject({ flags: { follow: false } });
  });

  test("says what is wrong, suggesting the flag meant", () => {
    expect(parseInput(run, [])).toEqual({ error: '"lemma run" needs <session>' });
    expect(parseInput(run, ["s", "--folow"])).toEqual({ error: 'Unknown option --folow for "lemma run"; did you mean --follow?' });
    expect(parseInput(run, ["s", "--thinking", "max"])).toEqual({ error: '--thinking must be one of low, high, not "max"' });
    expect(parseInput(run, ["s", "--limit", "x"])).toEqual({ error: '--limit must be a number, not "x"' });
    expect(parseInput(run, ["s", "--model"])).toEqual({ error: "--model needs a value" });
    expect(parseInput({ path: ["x"] }, ["extra"])).toEqual({ error: 'Unexpected argument "extra" for "lemma x"' });
  });

  test("a negative number is a value, not a flag", () => {
    expect(parseInput(run, ["s", "--limit", "-2"])).toMatchObject({ flags: { limit: -2 } });
  });
});

describe("specs", () => {
  test("refuse what the command line could not reach", () => {
    expect(specProblem(run)).toBeUndefined();
    expect(specProblem({ path: [], summary: "x" })).toMatch(/path/);
    expect(specProblem({ path: ["Sessions"], summary: "x" })).toMatch(/lowercase/);
    expect(specProblem({ path: ["x"], summary: "x", flags: { json: { type: "boolean", description: "" } } })).toMatch(/lemma command's own/);
    expect(
      specProblem({
        path: ["x"],
        summary: "x",
        args: [
          { name: "a", description: "", variadic: true },
          { name: "b", description: "" },
        ],
      }),
    ).toMatch(/last argument/);
  });

  test("a host checks what a client sends against the spec", () => {
    expect(inputProblem(run, { args: { session: "s", prompt: ["hi"] }, flags: { follow: true } })).toBeUndefined();
    expect(inputProblem(run, { args: {}, flags: {} })).toMatch(/needs <session>/);
    expect(inputProblem(run, { args: { session: "s" }, flags: { nope: 1 } })).toMatch(/no --nope/);
    expect(inputProblem(run, { args: { session: "s" }, flags: { image: ["a.png"] } })).toMatch(/--image/);
    expect(inputProblem(run, { args: { session: "s" }, flags: { image: [{ name: "a.png", data: "" }] } })).toBeUndefined();
  });

  test("help reads from the spec", () => {
    expect(usageLine(run)).toBe("lemma run <session> [prompt…] [options]");
    const help = renderHelp({ ...run, source: "agent.cli" });
    expect(help).toContain("-f, --follow");
    expect(help).toContain("--thinking <value>");
    expect(help).toContain("Added by the plugin agent.cli.");
  });

  test("closest finds a typo's word", () => {
    expect(closest("sesions", ["sessions", "status"])).toBe("sessions");
    expect(closest("zzz", ["sessions", "status"])).toBeUndefined();
  });
});
