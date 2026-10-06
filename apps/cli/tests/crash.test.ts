import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { settled, startLemma } from "../../../scripts/e2e.ts";
import type { Lemma } from "../../../scripts/e2e.ts";
import { invoke, printOnFailure } from "./invoke.ts";

describe("a host killed mid-turn", () => {
  let lemma: Lemma;
  let home: string;
  beforeAll(async () => {
    lemma = await startLemma("lemma-cli-crash-", { plugins: { agent: { config: { defaultModel: "mock/scripted" } } } });
    home = lemma.home;
  }, 30_000);
  afterAll(() => lemma?.stop());
  printOnFailure(() => lemma?.output());

  const show = async (session: string) =>
    JSON.parse((await invoke(["session", "show", session, "--json"], home)).out) as { branch: { data: Record<string, any> }[] };

  test("resumes its turns when it starts again: a cut-off command is reported with its output, a cut-off answer is asked again", async () => {
    const first = lemma.host;
    const slow = (await invoke(["session", "new", "--cwd", home], home)).out;
    const ramble = (await invoke(["session", "new", "--cwd", home], home)).out;
    // Both are left waiting when the host dies under them: the command runs until then, and the answer stops halfway.
    void invoke(["run", slow, "do it slowly"], home);
    void invoke(["run", ramble, "ramble on gate:crash"], home);
    // What the agent has saved of each so far (the command it was given says "started" too, so its output is looked at).
    const live = async (session: string) =>
      JSON.parse(await readFile(join(home, "agent", `${session}.live.json`), "utf8")) as { step?: { content: unknown[] }; output: { output: string }[] };
    expect(
      await settled(
        () => live(slow),
        (file) => file.output.some((tool) => tool.output.includes("started")),
      ),
    ).toBeDefined();
    expect(
      await settled(
        () => live(ramble),
        (file) => JSON.stringify(file.step?.content).includes("word5"),
      ),
    ).toBeDefined();
    const exited = new Promise((resolve) => first.once("exit", resolve));
    first.kill("SIGKILL");
    await exited;

    // Asked again, the answer runs to its end.
    lemma.mock.open("crash");
    await lemma.restart();
    const ended = async (session: string) =>
      settled(
        () => show(session),
        ({ branch }) => branch.some((event) => event.data.type === "turn-end"),
      );
    const [slowLog, rambleLog] = await Promise.all([ended(slow), ended(ramble)]);
    for (const log of [slowLog!, rambleLog!]) {
      expect(log.branch.some((event) => event.data.type === "custom" && event.data.kind === "agent.resumed")).toBe(true);
      expect(log.branch.find((event) => event.data.type === "turn-end")!.data.reason).toBe("done");
      expect(log.branch.filter((event) => event.data.type === "turn-start")).toHaveLength(1);
    }
    // The command was not run again: the model was told it was cut off, with what it had printed.
    const result = slowLog!.branch.find((event) => event.data.type === "message" && event.data.message.role === "toolResult")!.data.message;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/interrupted[\s\S]*started/);
    // The answer cut off midway is kept as an interrupted attempt, and asked again in full.
    const attempt = rambleLog!.branch.find((event) => event.data.type === "attempt")!.data.message;
    expect(attempt.errorMessage).toMatch(/^Interrupted/);
    expect(attempt.content[0].text).toContain("word5");
    const answer = rambleLog!.branch.filter((event) => event.data.type === "message" && event.data.message.role === "assistant").at(-1)!.data.message;
    expect(answer.content[0].text).toContain("word60");
  }, 60_000);
});
