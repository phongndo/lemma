import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, test } from "vitest";
import { HostError } from "@lemma/contracts";
import type { InteractionRequest, NoticePayload, RuntimeEvent } from "@lemma/contracts";
import { ExitCode } from "../src/command.ts";
import type { Io, Options } from "../src/command.ts";
import { loginCommand } from "../src/live.ts";
import { fakeHost, fed } from "./fake.ts";

const copilot = { id: "github-copilot", name: "GitHub Copilot", configured: false, auth: [{ type: "oauth", name: "GitHub Copilot", interactive: true }] };
const notice = (fields: Partial<NoticePayload>): RuntimeEvent => ({
  type: "notice",
  notice: { level: "info", message: "", origin: "login:github-copilot", ...fields },
});
const question = (request: Record<string, unknown>, id = "q1"): RuntimeEvent =>
  ({ type: "interaction", request: { ...request, id, origin: "login:github-copilot" } as InteractionRequest }) as RuntimeEvent;

/**
 * A host whose login publishes `events` as it starts and runs until the test calls `finish`, recording
 * the calls it is sent. Cancelling withdraws the login's open questions, as the transport does.
 */
const fakeLogin = (events: readonly RuntimeEvent[]) => {
  const calls: string[] = [];
  const answers: unknown[] = [];
  const done = Effect.runSync(Deferred.make<void>());
  const answered = Effect.runSync(Deferred.make<void>());
  const stream = fed<RuntimeEvent>();
  const connection = fakeHost({
    calls: {
      "llm.providers": () => Effect.succeed([copilot]),
      "llm.login": () =>
        Effect.andThen(
          Effect.sync(() => {
            calls.push("login");
            stream.push(...events);
          }),
          Deferred.await(done),
        ),
      // The transport withdraws the question before it replies, so the client hears of that first.
      "llm.cancel-login": () =>
        Effect.sync(() => {
          calls.push("cancel");
          for (const event of events) if (event.type === "interaction") stream.push({ type: "interaction-closed", id: event.request.id });
        }).pipe(Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 20 })), Effect.as(true)),
    },
    events: stream.stream,
    rpcs: {
      "Interaction.Answer": ({ answer }: { answer: unknown }) =>
        Effect.andThen(
          Effect.sync(() => void answers.push(answer)),
          Deferred.succeed(answered, undefined),
        ),
    },
  });
  return { connection, calls, answers, answered: Deferred.await(answered), finish: () => Effect.runSync(Deferred.succeed(done, undefined)) };
};

/** A terminal that records what it shows, asks, and opens; `reply` answers its prompts (never, by default). */
const terminal = (watch: (tty: { err: string[]; asked: string[] }) => void, reply: () => Promise<string> = () => new Promise<string>(() => {})) => {
  const tty = { err: [] as string[], asked: [] as string[], opened: [] as string[] };
  const io: Io = {
    env: {},
    cwd: "/",
    out: () => {},
    err: (text) => (tty.err.push(text), watch(tty)),
    ask: (text) => (tty.asked.push(text), watch(tty), reply()),
    open: (url) => void tty.opened.push(url),
  };
  return { io, ...tty };
};

const options = (fields: Partial<Options> = {}) => ({ json: false, answers: [], ...fields }) as unknown as Options;
const shown = (lines: readonly string[], text: string) => lines.join("\n").includes(text);
const device = notice({ kind: "device-code", message: "Enter code", code: "WDJB-MJHT", links: [{ url: "https://github.com/login/device" }] });

describe("lemma login", () => {
  test("prints a device code, and asks to open its page only when this terminal answers questions", async () => {
    for (const [policy, offered] of [
      ["ignore", false],
      ["ask", true],
    ] as const) {
      const host = fakeLogin([device]);
      const tty = terminal(({ err, asked }) => {
        if (shown(err, "Only enter this code") && (!offered || asked.length > 0)) host.finish();
      });
      await Effect.runPromise(Effect.scoped(loginCommand("github-copilot")(host.connection, tty.io, options({ questions: policy }))));
      expect(shown(tty.err, "First copy your one-time code: WDJB-MJHT")).toBe(true);
      expect(tty.asked.some((text) => text.startsWith("Press Enter to open github.com"))).toBe(offered);
    }
  });

  test("leaves a question after a documentation link as it was asked", async () => {
    const docs = notice({ message: "Amazon Bedrock supports AWS profiles.", links: [{ url: "https://docs.aws.test/profiles", label: "AWS profiles" }] });
    const host = fakeLogin([docs, question({ type: "ask", title: "Enter AWS profile name" })]);
    const tty = terminal(
      () => {},
      async () => "",
    );
    const login = Effect.runFork(Effect.scoped(loginCommand("github-copilot")(host.connection, tty.io, options({ questions: "ask" }))));
    await Effect.runPromise(host.answered);
    host.finish();
    await Effect.runPromise(Fiber.join(login));
    expect(shown(tty.err, "AWS profiles: https://docs.aws.test/profiles")).toBe(true);
    expect(tty.asked).toEqual(["Enter AWS profile name: "]);
    // A blank answer is one: the default profile.
    expect(host.answers).toEqual([{ type: "ask", value: "" }]);
  });

  test("words the host's paste-the-address question, after the link it follows though the question arrived first", async () => {
    const link = notice({ kind: "sign-in", message: "Complete sign-in", links: [{ url: "https://auth.test/authorize" }] });
    const host = fakeLogin([question({ type: "ask", title: "Paste the final redirect URL:", kind: "sign-in-code" }), link]);
    const tty = terminal(({ asked }) => asked.length > 0 && host.finish());
    await Effect.runPromise(Effect.scoped(loginCommand("github-copilot")(host.connection, tty.io, options({ questions: "ask" }))));
    expect(tty.opened).toEqual(["https://auth.test/authorize"]);
    expect(shown(tty.err, "https://auth.test/authorize")).toBe(true);
    expect(tty.asked).toEqual(["If the browser ends on a page that won't load, paste its address here: "]);
  });

  test("a login its provider's reload withdrew fails, saying to run the command again, and closes its question's prompt", async () => {
    const events = fed<RuntimeEvent>();
    const asked = Effect.runSync(Deferred.make<void>());
    let logins = 0;
    const connection = fakeHost({
      calls: {
        "llm.providers": () => Effect.succeed([copilot]),
        "llm.login": () =>
          Effect.suspend(() => {
            logins++;
            events.push(question({ type: "ask", title: "GitHub Enterprise URL" }));
            // Withdrawn with its question open: the old instance closes that only as it goes.
            return Effect.andThen(Deferred.await(asked), Effect.fail(new HostError({ code: "Withdrawn", subject: "llm.login", message: "withdrawn" })));
          }),
      },
      events: events.stream,
    });
    const prompts: AbortSignal[] = [];
    const io: Io = {
      env: {},
      cwd: "/",
      out: () => {},
      err: () => {},
      ask: (_text, _secret, signal) => {
        if (signal !== undefined) prompts.push(signal);
        Effect.runSync(Deferred.succeed(asked, undefined));
        return new Promise<string>(() => {});
      },
    };
    const failed = await Effect.runPromise(Effect.flip(Effect.scoped(loginCommand("github-copilot")(connection, io, options({ questions: "ask" })))));
    expect(failed).toMatchObject({ code: "Withdrawn", subject: "llm.login", exit: ExitCode.failed });
    expect(failed.message).toContain("run the command again");
    expect(logins).toBe(1);
    expect(prompts.map((signal) => signal.aborted)).toEqual([true]);
  });

  test("interrupting cancels the login on the host, without saying its questions were answered elsewhere", async () => {
    const host = fakeLogin([question({ type: "ask", title: "GitHub Enterprise URL" })]);
    const asking = Effect.runSync(Deferred.make<void>());
    const tty = terminal(({ asked }) => asked.length > 0 && Effect.runSync(Deferred.succeed(asking, undefined)));
    const login = Effect.runFork(Effect.scoped(loginCommand("github-copilot")(host.connection, tty.io, options({ questions: "ask" }))));
    await Effect.runPromise(Deferred.await(asking));
    await Effect.runPromise(Fiber.interrupt(login));
    expect(host.calls).toEqual(["login", "cancel"]);
    expect(tty.err).toContain("Cancelled the GitHub Copilot login.");
    expect(shown(tty.err, "answered elsewhere")).toBe(false);
  });
});
