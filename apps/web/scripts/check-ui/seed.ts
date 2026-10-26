import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Clock, Effect } from "effect";
import { makeCore } from "@lemma/core";
import { pathsPlugin } from "@lemma/contracts/testing";
import { emptyUsage } from "@lemma/llm";
import type { AssistantMessage, Usage } from "@lemma/llm";
import { Sessions } from "@lemma/sessions";
import type { EventData, SessionParent } from "@lemma/sessions";
import sessions from "../../../../domains/sessions/files/src/index.ts";

/*
 * What a UI check lane's host has in its home before it starts. The home is the host's `HOME` too, so `~` is it:
 *
 * - `code/lemma`: a project, a git repository with files the composer's `@` finds, a project skill, and `origin` (a
 *   bare repository at `remotes/lemma.git`), whose `main` is a commit behind the project's, to start a worktree from;
 * - `code/website`: another project;
 * - `skills/review`: a skill of the user's;
 * - with `threads`, the threads the lanes open (`seedThreads`), written by the sessions store the host runs.
 */

/** The files the project has, as `@` finds them. */
const FILES = [
  "README.md",
  "package.json",
  "src/main.ts",
  "src/app.tsx",
  "src/components/Composer.tsx",
  "src/components/Sidebar.tsx",
  "src/lib/format.ts",
  "src/styles.css",
  "tests/app.test.ts",
  "flake.nix",
  "Dockerfile",
  ".gitignore",
  "scripts/release.sh",
  "tools/codegen.py",
];

const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${description}.\n`;

/** Runs git in `cwd` as nobody's config but its own, so the user's (signing, hooks, a default branch) changes nothing. */
export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Lemma Check", "-c", "user.email=check@lemma.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    stdio: "pipe",
    encoding: "utf8",
  }).trim();

const put = async (path: string, text: string) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
};

/** Where the seeded projects are in a home. */
export const projectsOf = (home: string) => ({ lemma: join(home, "code", "lemma"), website: join(home, "code", "website") });

export const seedHome = async (home: string, { threads }: { readonly threads: boolean }) => {
  const { lemma, website } = projectsOf(home);
  for (const file of FILES) await put(join(lemma, file), file === "README.md" ? "# Lemma\n\nA coding-agent harness in which every part is a plugin.\n" : "");
  await put(join(lemma, ".agents", "skills", "release", "SKILL.md"), skill("release", "Cut a release: changelog, tag, and publish"));
  await put(join(home, "skills", "review", "SKILL.md"), skill("review", "Review a diff for bugs before it merges"));
  await put(join(website, "index.html"), "<!doctype html><title>Website</title>\n");
  git(lemma, "init", "--quiet", "--initial-branch=main");
  git(lemma, "add", ".");
  git(lemma, "commit", "--quiet", "-m", "Start the harness");
  const origin = join(home, "remotes", "lemma.git");
  await mkdir(origin, { recursive: true });
  git(origin, "init", "--quiet", "--bare", "--initial-branch=main");
  git(lemma, "remote", "add", "origin", origin);
  git(lemma, "push", "--quiet", "--set-upstream", "origin", "main");
  // A commit not pushed yet: a worktree started from the remote's `main` is told apart from one started from this one.
  await put(join(lemma, "src", "main.ts"), 'import "./app.tsx";\n');
  git(lemma, "commit", "--quiet", "-am", "Start the app");
  if (threads) await seedThreads(home);
};

/** A clock whose wall time is set, for events written as long ago as the threads say; the rest is the system's. */
const setClock = () => {
  const system = Clock.Clock.defaultValue();
  let now = Date.now();
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => system.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: system.monotonicTimeNanos,
    sleep: (duration) => system.sleep(duration),
  };
  return { clock, set: (at: number) => void (now = at) };
};

const usage = (input: number, output: number, cacheRead = 0): Usage => ({
  ...emptyUsage,
  input,
  output,
  cacheRead,
  totalTokens: input + output + cacheRead,
  cost: {
    input: input * 3e-6,
    output: output * 15e-6,
    cacheRead: cacheRead * 0.3e-6,
    cacheWrite: 0,
    total: input * 3e-6 + output * 15e-6 + cacheRead * 0.3e-6,
  },
});

const assistant = (
  content: AssistantMessage["content"],
  u: Usage,
  timestamp: number,
  stopReason: AssistantMessage["stopReason"] = "stop",
  errorMessage?: string,
  /** The model that answered: Claude Sonnet 4.5, unless another is named. */
  by: { readonly api: string; readonly provider: string; readonly id: string } = { api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet-4-5" },
): AssistantMessage => ({
  role: "assistant",
  content,
  api: by.api,
  provider: by.provider,
  model: by.id,
  usage: u,
  stopReason,
  timestamp,
  ...(errorMessage === undefined ? {} : { errorMessage }),
});

/**
 * The threads the lanes open, each as its plugins log it, oldest first:
 *
 * - "Landing page copy", in `code/website`: a turn whose model call failed, the provider's answer in its message;
 * - an empty thread in `code/lemma`;
 * - "Refactor the session log reader": a thread that handed tasks to agents (`delegate`), two in the background, one
 *   of which has told it back, and one it waited on that failed, each agent a thread of its own under it;
 * - "Fix flaky session log test", the newest, so the one a lane opens first: a call that failed and was asked again,
 *   commands, a read and an edit, guards and handlers, and a compaction, each request logged with who shaped it.
 */
export const seedThreads = (home: string) => {
  const { lemma, website } = projectsOf(home);
  const { clock, set } = setClock();
  const system = `You are an expert coding assistant.\n\nWorking directory: ${lemma}`;
  const specs = ["bash", "read", "edit"].map((name) => ({ name, description: `The ${name} tool`, parameters: {} }));
  /** A `request` event as the agent logs it: the prompt by source, and the handlers that shaped it (`AgentRequestHook`). */
  const request = (turnId: string, stepId: string, handlers: Extract<EventData, { type: "request" }>["handlers"]): EventData => ({
    type: "request",
    turnId,
    stepId,
    model: "anthropic/claude-sonnet-4-5",
    composition: "seeded",
    system,
    tools: specs,
    contributions: [
      { source: "agent.loop", kind: "system", label: "base", chars: system.length },
      ...specs.map((spec) => ({ source: `tools.${spec.name}`, kind: "tool" as const, label: spec.name, chars: JSON.stringify(spec).length })),
    ],
    ...(handlers === undefined ? {} : { handlers }),
  });
  const body = Effect.gen(function* () {
    const store = yield* Sessions;
    /** A thread made at `start`, and a writer of its events, each `ms` after the one before unless placed `at` a time. */
    const thread = function* (cwd: string, start: number, parent?: SessionParent) {
      set(start);
      const info = yield* store.create({ cwd, ...(parent === undefined ? {} : { parent }) });
      let t = start;
      const append = (data: EventData, ms = 400) =>
        Effect.gen(function* () {
          t += ms;
          set(t);
          return yield* store.append(info.id, data);
        });
      return { id: info.id, append, now: () => t };
    };

    const t0 = Date.now() - 3 * 3600_000;
    // A turn whose model call failed, with the provider's response body in its message.
    const site = yield* thread(website, t0 - 2 * 86400_000);
    const oauthError =
      'OAuth refresh failed for openai: OpenAI OAuth token request failed (400): { "error": "invalid_grant", "error_reason": "refresh_token_invalidated", "error_description": "The refresh token has been invalidated. A fresh sign-in is required." }. Sign in to OpenAI again on the Providers page, or with `lemma login openai`.';
    yield* site.append({ type: "title", title: "Landing page copy" });
    yield* site.append({ type: "turn-start", turnId: "t1" });
    yield* site.append({
      type: "message",
      turnId: "t1",
      message: { role: "user", timestamp: site.now(), content: [{ type: "text", text: "Tighten the hero copy." }] },
    });
    yield* site.append({ type: "step-start", turnId: "t1", stepId: "p1" });
    const failedAt = site.now();
    yield* site.append(
      {
        type: "message",
        turnId: "t1",
        stepId: "p1",
        timing: { startedAt: failedAt, endedAt: failedAt + 363 },
        message: assistant([], usage(0, 0), failedAt, "error", oauthError, { api: "openai-responses", provider: "openai", id: "gpt-5" }),
      },
      363,
    );
    yield* site.append({ type: "step-end", turnId: "t1", stepId: "p1" }, 10);
    yield* site.append({ type: "turn-end", turnId: "t1", reason: "error", error: oauthError }, 10);

    yield* thread(lemma, t0 - 86400_000);

    // The agents a thread handed tasks to: each a thread of its own under it, told its task and done or failed.
    const delegated = t0 - 3600_000;
    set(delegated);
    const parent = yield* store.create({ cwd: lemma });
    const agent = function* (call: string, title: string, mode: string | undefined, prompt: string, answer: string, end: "done" | "error", after: number) {
      const child = yield* thread(lemma, delegated + after, { sessionId: parent.id, toolCallId: call });
      yield* child.append({ type: "title", title }, 300);
      yield* child.append({ type: "turn-start", turnId: "t1", ...(mode === undefined ? {} : { plugins: { "agent.modes": mode } }) }, 300);
      yield* child.append(
        {
          type: "message",
          turnId: "t1",
          requestId: `tools.delegate/${call}`,
          message: { role: "user", timestamp: child.now(), content: [{ type: "text", text: prompt }] },
        },
        300,
      );
      yield* child.append({ type: "step-start", turnId: "t1", stepId: "p1" }, 300);
      const asked = child.now();
      yield* child.append(
        {
          type: "message",
          turnId: "t1",
          stepId: "p1",
          timing: { startedAt: asked, endedAt: asked + 5200 },
          message: assistant(
            end === "done" ? [{ type: "text", text: answer }] : [],
            usage(6100, 420, 9000),
            asked,
            end === "done" ? "stop" : "error",
            end === "done" ? undefined : answer,
          ),
        },
        5200,
      );
      yield* child.append({ type: "step-end", turnId: "t1", stepId: "p1" }, 300);
      yield* child.append({ type: "turn-end", turnId: "t1", reason: end, ...(end === "error" ? { error: answer } : {}) }, 300);
      return child.id;
    };
    const mapped = yield* agent(
      "d1",
      "Map callers of rebuildRequest",
      "explore",
      "Find every caller of rebuildRequest in domains/ and say how each uses its result.",
      "Fourteen callers, all in domains/: the agent loop's request builder, the trajectory view, and twelve tests. Each reads the rebuilt request whole; none keeps it.",
      "done",
      1200,
    );
    const reviewed = yield* agent(
      "d2",
      "Review the reader refactor",
      "explore",
      "Review the session log reader for what a refactor would break: its readers, its tests, and its format.",
      "Nothing breaks if the reader keeps its signature: the format tests pin every projection.",
      "done",
      1400,
    );
    const renamed = yield* agent(
      "d3",
      "Rename the reader's types",
      undefined,
      "Rename SessionReader to LogReader throughout.",
      "The model provider refused the request: 429 rate limited",
      "error",
      1600,
    );
    // The parent's own log, after its agents' starts.
    let p = delegated;
    const say = (data: EventData, ms = 400) =>
      Effect.gen(function* () {
        p += ms;
        set(p);
        yield* store.append(parent.id, data);
      });
    yield* say({ type: "title", title: "Refactor the session log reader" });
    yield* say({ type: "turn-start", turnId: "t1" });
    yield* say({
      type: "message",
      turnId: "t1",
      message: { role: "user", timestamp: p, content: [{ type: "text", text: "Refactor the session log reader and check every caller still works." }] },
    });
    yield* say({ type: "step-start", turnId: "t1", stepId: "p1" });
    const calls = [
      {
        id: "d1",
        child: mapped,
        title: "Map callers of rebuildRequest",
        prompt: "Find every caller of rebuildRequest in domains/ and say how each uses its result.",
        background: true,
      },
      {
        id: "d2",
        child: reviewed,
        title: "Review the reader refactor",
        prompt: "Review the session log reader for what a refactor would break.",
        background: true,
      },
      { id: "d3", child: renamed, title: "Rename the reader's types", prompt: "Rename SessionReader to LogReader throughout.", background: false },
    ];
    yield* say(
      {
        type: "message",
        turnId: "t1",
        stepId: "p1",
        timing: { startedAt: p, endedAt: p + 2100 },
        message: assistant(
          [
            { type: "text", text: "I'll split this: two explorers in the background, and the rename waited on." },
            ...calls.map((call) => ({
              type: "toolCall" as const,
              id: call.id,
              name: "delegate",
              arguments: { prompt: call.prompt, title: call.title, ...(call.background ? { mode: "explore", background: true } : {}) },
            })),
          ],
          usage(5200, 260, 11000),
          p,
          "toolUse",
        ),
      },
      2100,
    );
    for (const call of calls) {
      const failed = !call.background;
      yield* say(
        {
          type: "message",
          turnId: "t1",
          stepId: "p1",
          timing: { startedAt: p, endedAt: p + (failed ? 7400 : 60) },
          details: {
            sessionId: call.child,
            title: call.title,
            ...(call.background ? { mode: "explore", background: true } : {}),
            ended: failed ? "error" : "running",
            ...(failed ? { preview: "The model provider refused the request: 429 rate limited" } : {}),
          },
          message: {
            role: "toolResult",
            toolCallId: call.id,
            toolName: "delegate",
            isError: failed,
            timestamp: p,
            content: [
              {
                type: "text",
                text: failed
                  ? `Agent "${call.title}" (session ${call.child}) ended: error.`
                  : `Started agent "${call.title}" (session ${call.child}) in the background. You are told when it finishes: do not wait or poll for it.`,
              },
            ],
          },
        },
        failed ? 7400 : 60,
      );
    }
    yield* say({ type: "step-end", turnId: "t1", stepId: "p1", decision: { result: "continue", why: "the model asked for tools" } });
    yield* say({ type: "step-start", turnId: "t1", stepId: "p2" });
    yield* say(
      {
        type: "message",
        turnId: "t1",
        stepId: "p2",
        timing: { startedAt: p, endedAt: p + 1600 },
        message: assistant(
          [{ type: "text", text: "The rename failed on a rate limit; the explorers are still at work, and I'll pick up when they report back." }],
          usage(5600, 90, 16000),
          p,
        ),
      },
      1600,
    );
    yield* say({ type: "step-end", turnId: "t1", stepId: "p2" });
    yield* say({ type: "turn-end", turnId: "t1", reason: "done" });
    // The explorer that finished, told back: its notice starts the next turn.
    yield* say({ type: "turn-start", turnId: "t2" }, 9000);
    yield* say({
      type: "context",
      turnId: "t2",
      source: "tools.delegate",
      requestId: "tools.delegate:d1",
      display: "Map callers of rebuildRequest finished",
      content: [
        {
          type: "text",
          text: `<agent_result title="Map callers of rebuildRequest" session="${mapped}" ended="done">\nFourteen callers, all in domains/: the agent loop's request builder, the trajectory view, and twelve tests. Each reads the rebuilt request whole; none keeps it.\n</agent_result>`,
        },
      ],
    });
    yield* say({ type: "step-start", turnId: "t2", stepId: "p1" });
    yield* say(
      {
        type: "message",
        turnId: "t2",
        stepId: "p1",
        timing: { startedAt: p, endedAt: p + 1900 },
        message: assistant(
          [{ type: "text", text: "The callers only read the rebuilt request, so the reader can change its internals freely." }],
          usage(6200, 70, 18000),
          p,
        ),
      },
      1900,
    );
    yield* say({ type: "step-end", turnId: "t2", stepId: "p1" });
    yield* say({ type: "turn-end", turnId: "t2", reason: "done" });

    // The newest: a fix, step by step, each request with the handlers that shaped it.
    const fix = yield* thread(lemma, t0);
    yield* fix.append({ type: "title", title: "Fix flaky session log test" });
    yield* fix.append({ type: "turn-start", turnId: "t1" });
    yield* fix.append({
      type: "message",
      turnId: "t1",
      message: {
        role: "user",
        timestamp: fix.now(),
        content: [{ type: "text", text: "The session-log test fails randomly on CI. Can you find out why and fix it?" }],
      },
    });
    // A call that failed and was asked again, as the agent logs it: the attempt closes its step, and the next asks again.
    yield* fix.append({ type: "step-start", turnId: "t1", stepId: "p0" });
    yield* fix.append(request("t1", "p0", [{ source: "context.compaction", ms: 0.31 }]));
    const overloaded = fix.now();
    yield* fix.append(
      {
        type: "attempt",
        turnId: "t1",
        stepId: "p0",
        message: assistant([], usage(0, 0), overloaded, "error", "529 overloaded_error: Overloaded"),
        timing: { startedAt: overloaded, endedAt: overloaded + 900 },
        failure: { kind: "transient" },
        retry: { reason: "failure", attempt: 1, at: overloaded + 1200 },
      },
      900,
    );
    yield* fix.append({ type: "step-end", turnId: "t1", stepId: "p0" });
    yield* fix.append({ type: "step-start", turnId: "t1", stepId: "p1" });
    yield* fix.append(request("t1", "p1", [{ source: "context.compaction", ms: 0.27 }]));
    const test = `${lemma}/packages/client/tests/session-log.test.ts`;
    const looked = fix.now();
    yield* fix.append(
      {
        type: "message",
        turnId: "t1",
        stepId: "p1",
        timing: { startedAt: looked, firstTokenAt: looked + 700, endedAt: looked + 3200 },
        message: assistant(
          [
            {
              type: "thinking",
              thinking:
                "The test uses setTimeout(0) to wait for the repair fetch. If the fetch resolves later than a macrotask, the assertion races.\nLet me run it and look at the test.",
            },
            { type: "text", text: "Let me run the tests and look at the file." },
            { type: "toolCall", id: "c1", name: "bash", arguments: { command: "pnpm --filter @lemma/client test -- --reporter=dot" } },
            { type: "toolCall", id: "c2", name: "read", arguments: { path: test, offset: 30, limit: 40 } },
          ],
          usage(4200, 180, 12000),
          looked,
          "toolUse",
        ),
      },
      3200,
    );
    const ran = fix.now();
    yield* fix.append(
      {
        type: "message",
        turnId: "t1",
        stepId: "p1",
        timing: { startedAt: ran, endedAt: ran + 2400 },
        details: { exitCode: 1 },
        credit: { handlers: [{ source: "tools.bash", ms: 0.12 }], checks: [{ source: "plan-mode", allowed: true, ms: 0.08 }] },
        message: {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "bash",
          isError: true,
          timestamp: ran,
          content: [
            {
              type: "text",
              text: " ✓ mergeEvents (3)\n ✓ rpcUrl (1)\n × SessionLog > holds events beyond a gap\n   AssertionError: expected [ 1, 2 ] to deeply equal [ 1, 2, 3, 4, 5 ]\n\n Test Files  1 failed (1)\n      Tests  1 failed | 11 passed (12)",
            },
          ],
        },
      },
      2400,
    );
    yield* fix.append(
      {
        type: "message",
        turnId: "t1",
        stepId: "p1",
        timing: { startedAt: fix.now(), endedAt: fix.now() + 40 },
        message: {
          role: "toolResult",
          toolCallId: "c2",
          toolName: "read",
          isError: false,
          timestamp: fix.now(),
          content: [{ type: "text", text: '  it("holds events beyond a gap", async () => {\n    const file = range(1, 2);\n    ...\n    await settle();\n' }],
        },
      },
      40,
    );
    yield* fix.append({ type: "step-end", turnId: "t1", stepId: "p1", decision: { result: "continue", why: "the model asked for tools" } });
    yield* fix.append({ type: "step-start", turnId: "t1", stepId: "p2" });
    yield* fix.append(request("t1", "p2", [{ source: "context.compaction", ms: 0.27 }]));
    const edits = fix.now();
    yield* fix.append(
      {
        type: "message",
        turnId: "t1",
        stepId: "p2",
        timing: { startedAt: edits, firstTokenAt: edits + 500, endedAt: edits + 2600 },
        message: assistant(
          [
            {
              type: "text",
              text: "The repair fetch is awaited with a single `setTimeout(0)`, which races when the fake fetch takes more than one macrotask. I'll wait for the call instead:",
            },
            {
              type: "toolCall",
              id: "c3",
              name: "edit",
              arguments: { path: test, oldText: "await settle();", newText: "await vi.waitFor(() => expect(s.calls).toHaveLength(2));" },
            },
          ],
          usage(5100, 240, 16200),
          edits,
          "toolUse",
        ),
      },
      2600,
    );
    const edited = yield* fix.append(
      {
        type: "message",
        turnId: "t1",
        stepId: "p2",
        timing: { startedAt: fix.now(), endedAt: fix.now() + 30 },
        details: {
          diff: "--- a/packages/client/tests/session-log.test.ts\n+++ b/packages/client/tests/session-log.test.ts\n@@ -88,7 +88,7 @@\n     log.apply(ev(5));\n     expect(seqs(log.events)).toEqual([1, 2]);\n-    await settle();\n+    await vi.waitFor(() => expect(s.calls).toHaveLength(2));\n     expect(s.calls).toEqual([undefined, 2]);\n",
        },
        message: {
          role: "toolResult",
          toolCallId: "c3",
          toolName: "edit",
          isError: false,
          timestamp: fix.now(),
          content: [{ type: "text", text: "Edited packages/client/tests/session-log.test.ts" }],
        },
        credit: { checks: [{ source: "plan-mode", allowed: true, ms: 0.06 }] },
      },
      30,
    );
    yield* fix.append({ type: "step-end", turnId: "t1", stepId: "p2", decision: { result: "continue", why: "the model asked for tools" } });
    yield* fix.append({ type: "step-start", turnId: "t1", stepId: "p3" });
    // The history had grown past the compaction threshold: the request summarized what came before the edit.
    yield* fix.append({
      type: "compaction",
      summary: "They asked why the session-log test fails on CI; the tests showed SessionLog > holds events beyond a gap failing.",
      firstKeptId: edited.id,
      tokensBefore: 18200,
      source: "context.compaction",
      turnId: "t1",
      usage: usage(18200, 140),
    });
    yield* fix.append(request("t1", "p3", [{ source: "context.compaction", ms: 1840.5, changed: ["+compaction"] }]));
    const fixed = fix.now();
    yield* fix.append(
      {
        type: "message",
        turnId: "t1",
        stepId: "p3",
        timing: { startedAt: fixed, firstTokenAt: fixed + 400, endedAt: fixed + 1800 },
        message: assistant(
          [
            {
              type: "text",
              text: "Fixed. The test now waits for the repair fetch explicitly:\n\n```ts\nawait vi.waitFor(() => expect(s.calls).toHaveLength(2));\n```\n\n- **Cause:** a timing assumption (`setTimeout(0)`) in the test, not a bug in `SessionLog`.\n- **Check:** ran the suite 50× locally with no failures.",
            },
          ],
          usage(5600, 120, 21000),
          fixed,
        ),
      },
      1800,
    );
    yield* fix.append({ type: "step-end", turnId: "t1", stepId: "p3", decision: { result: "stop", why: "the model stopped (stop)" } });
    yield* fix.append({ type: "turn-end", turnId: "t1", reason: "done" }, 100);
  });
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore([pathsPlugin(home, { cwd: lemma }), sessions]);
        return yield* core.run(body.pipe(Effect.provideService(Clock.Clock, clock)));
      }),
    ),
  );
};
