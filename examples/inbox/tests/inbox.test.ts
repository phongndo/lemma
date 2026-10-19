import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { makeCore } from "@lemma/core";
import type { Plugin } from "@lemma/core";
import { definePlugin } from "@lemma/core/plain";
import type { PluginInfo } from "@lemma/contracts";
import { hostControlPlugin, pathsPlugin } from "@lemma/contracts/testing";
import { Agent, AgentRequestHook } from "@lemma/agent";
import agent from "@lemma/agent-loop";
import profiles from "@lemma/agent-profiles";
import { callTools, reply, scriptedLlm, SCRIPTED_MODEL, toolCall } from "@lemma/llm/testing";
import type { Script } from "@lemma/llm/testing";
import { Sessions } from "@lemma/sessions";
import sessions from "@lemma/sessions-files";
import tools from "@lemma/tools-registry";
import inbox, { announce, parseMessage, readInbox, SHOWN, shownOn } from "../inbox.ts";

let dir: string;
beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lemma-inbox-")));
  await fs.mkdir(path.join(dir, "project", "inbox"), { recursive: true });
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const deliver = (name: string, from: string, subject: string, body: string) =>
  fs.writeFile(path.join(dir, "project", "inbox", name), `From: ${from}\nSubject: ${subject}\n\n${body}\n`);

describe("messages", () => {
  it("reads headers up to the first line that is none, and the body after", () => {
    expect(parseMessage("a.eml", "From: Ann <ann@example.com>\r\nSubject: Lunch?\r\n\r\nAre you free?\r\n")).toEqual({
      id: "a.eml",
      headers: { from: "Ann <ann@example.com>", subject: "Lunch?" },
      body: "Are you free?",
    });
    expect(parseMessage("b.txt", "No headers here.").body).toBe("No headers here.");
  });

  it("lists the inbox's message files, not what is filed below it", async () => {
    await deliver("1.md", "ann", "One", "first");
    await fs.mkdir(path.join(dir, "project", "inbox", "done"));
    await fs.writeFile(path.join(dir, "project", "inbox", "done", "0.md"), "From: old\n\nfiled");
    await fs.writeFile(path.join(dir, "project", "inbox", "notes.json"), "{}");
    expect((await readInbox(path.join(dir, "project", "inbox"))).map((message) => message.id)).toEqual(["1.md"]);
    expect(await readInbox(path.join(dir, "nowhere"))).toEqual([]);
  });

  it("announces each one by id, sender, subject, and first lines", () => {
    expect(announce([parseMessage("1.md", "From: ann\nSubject: One\n\nline 1\n\nline 2\nline 3\nline 4")])).toBe(
      'New in the inbox (1); read one in full with inbox_read, and file it with inbox_file:\n<message id="1.md" from="ann" subject="One">\nline 1\nline 2\nline 3\n</message>',
    );
  });
});

describe("in a turn", () => {
  /** Prompts once per entry of `turns` (each played by its scripts), and returns the requests and the session's log. */
  const run = (
    turns: readonly { readonly before?: () => Promise<void>; readonly scripts: readonly Script[] }[],
    profile?: string,
    extra: readonly Plugin[] = [],
  ) => {
    // As the host lists this package when it is in a plugins directory: its profiles folder in its status.
    const known: PluginInfo[] = [
      {
        id: "inbox",
        source: "user",
        enabled: true,
        state: "active",
        provides: [],
        requires: [],
        resources: { profiles: [fileURLToPath(new URL("../profiles", import.meta.url))] },
      },
    ];
    const llm = scriptedLlm(turns.flatMap((turn) => turn.scripts));
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore(
            [
              pathsPlugin(path.join(dir, "home"), { cwd: path.join(dir, "project") }),
              hostControlPlugin(known),
              sessions,
              tools,
              agent,
              profiles,
              llm.plugin,
              inbox,
              ...extra,
            ],
            { configs: { "agent.loop": { defaultModel: SCRIPTED_MODEL.ref } } },
          );
          return yield* core.run(
            Effect.gen(function* () {
              const { id } = yield* (yield* Sessions).create({ cwd: path.join(dir, "project") });
              for (const turn of turns) {
                if (turn.before !== undefined) yield* Effect.promise(turn.before);
                yield* (yield* Agent).prompt(id, [{ type: "text", text: "triage" }], profile === undefined ? {} : { plugins: { "agent.profiles": profile } });
              }
              return { requests: llm.requests, log: yield* (yield* Sessions).events(id) };
            }),
          );
        }),
      ),
    );
  };

  it("shows the model what is new once, where it arrived, and files a message out of the inbox", async () => {
    await deliver("1.md", "ann", "Lunch?", "Are you free on Friday?");
    const { requests, log } = await run([
      { scripts: [callTools(toolCall("inbox_file", { id: "1.md", folder: "reply" })), reply("Filed it.")] },
      { before: () => deliver("2.md", "bob", "Invoice", "Attached."), scripts: [reply("Nothing else.")] },
    ]);
    const said = (index: number) => JSON.stringify(requests[index]!.messages);
    // The first request carries the announcement, after the prompt; the step after the call does not repeat it.
    expect(said(0)).toContain('<message id=\\"1.md\\" from=\\"ann\\" subject=\\"Lunch?\\">');
    expect(said(1).split('id=\\"1.md\\"').length).toBe(2);
    // The next turn tells only of what arrived since.
    expect(said(2)).toContain('<message id=\\"2.md\\"');
    expect(said(2).split('id=\\"1.md\\"').length).toBe(2);
    await expect(fs.stat(path.join(dir, "project", "inbox", "reply", "1.md"))).resolves.toBeDefined();
    // The log keeps both announcements as context events, and what each showed.
    expect(log.filter((event) => event.data.type === "context").map((event) => event.data.type === "context" && event.data.display)).toEqual([
      "1 new message",
      "1 new message",
    ]);
    expect([...shownOn(log)]).toEqual(["1.md", "2.md"]);
    expect(log.some((event) => event.data.type === "custom" && event.data.kind === SHOWN)).toBe(true);
  });

  it("hands the handlers after it the request with what it announced, as compaction must size it", async () => {
    await deliver("1.md", "ann", "Lunch?", "Are you free on Friday?");
    const seen: string[] = [];
    const fit = definePlugin({
      id: "fit-observer",
      setup: (_deps, { on }) =>
        on(
          AgentRequestHook,
          (draft, next) => {
            seen.push(JSON.stringify(draft.history.at(-1)));
            return next(draft);
          },
          { phase: "fit" },
        ),
    });
    await run([{ scripts: [reply("Noted.")] }], undefined, [fit]);
    expect(seen[0]).toContain('<message id=\\"1.md\\"');
  });

  it("brings the triage profile, which narrows the agent to the inbox's tools", async () => {
    const { requests } = await run([{ scripts: [reply("Nothing new.")] }], "triage");
    expect((requests[0]!.tools ?? []).map((tool) => tool.name).sort()).toEqual(["inbox_file", "inbox_read"]);
    expect(requests[0]!.system).toContain("# Triage");
  });

  it("refuses an id or a folder that would reach out of the inbox", async () => {
    await deliver("1.md", "ann", "Hi", "Hello");
    const { log } = await run([
      {
        scripts: [
          callTools(toolCall("inbox_read", { id: "../secret.md" }, "a"), toolCall("inbox_file", { id: "1.md", folder: "../out" }, "b")),
          reply("Could not."),
        ],
      },
    ]);
    const results = log.flatMap((event) => (event.data.type === "message" && event.data.message.role === "toolResult" ? [event.data.message] : []));
    expect(results.map((result) => result.isError)).toEqual([true, true]);
    await expect(fs.stat(path.join(dir, "project", "inbox", "1.md"))).resolves.toBeDefined();
  });
});
