/**
 * Checks this plugin against the real providers, with a Lemma home's sign-ins and keys (`$LEMMA_HOME`, else
 * `~/.lemma`): for each model, a streamed answer with its usage and cost, a tool round trip whose second request
 * sends the first's thinking back and should read the prompt cache, every thinking level it offers, and a stop
 * midway. Each request costs a little; a model at `max` effort can think for a while.
 *
 *   node --conditions=lemma-source domains/llm/http/scripts/live.ts [options] [<provider>/<model> ...]
 *
 *   --login <provider>   sign in first through the provider's sign-in (`openai`: ChatGPT), opening the link printed
 *                        or pasting the redirect URL when asked; a key is stored with Lemma's `/login`, which hides it
 *   --refresh            refresh each signed-in provider's token first, as an expired one is
 *   --websocket          send OpenAI's requests over its WebSocket mode
 *   --provider <json>    add a provider of the user's, as the config's `providers` row takes it (a local server)
 *
 * Without models, it checks those `DEFAULTS` names for each provider that has a credential, or the first model it
 * serves where it serves none of them. A ChatGPT plan lists its own models once the catalog has read them, so name one
 * (`openai/gpt-6-luna`) to check a sign-in. It exits non-zero when a check fails.
 */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Cause, Effect, Exit, Layer, Stream } from "effect";
import { HostControl, Interaction, InteractionError, Notice, Paths } from "@lemma/contracts";
import { definePlugin, makeCore, PluginContext } from "@lemma/core";
import { Credentials } from "@lemma/credentials";
import credentialsFile from "@lemma/credentials-file";
import { Llm, LlmRequest } from "@lemma/llm";
import type { AssistantMessage, Message, ModelInfo, StreamEvent, ThinkingLevel } from "@lemma/llm";
import { makeLlmPlugin } from "../src/index.ts";

/** The models checked for each provider with a credential: a cheap one on each protocol it serves. */
const DEFAULTS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["claude-haiku-4-5", "claude-haiku-5-5"],
  openai: ["gpt-5.4-nano"],
  openrouter: ["anthropic/claude-haiku-4.5", "openai/gpt-5-mini", "qwen/qwen3-32b"],
  opencode: ["claude-haiku-4-5", "gpt-5.4-mini", "glm-5.1"],
  "opencode-go": ["deepseek-v4.1-flash", "minimax-m2.7"],
};

const args = process.argv.slice(2);
const option = (name: string) => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args.splice(at, 2)[1];
};
const flag = (name: string) => {
  const at = args.indexOf(name);
  if (at >= 0) args.splice(at, 1);
  return at >= 0;
};
const login = option("--login");
const custom = option("--provider");
const refresh = flag("--refresh");
const webSocket = flag("--websocket");
const asked = args;

const home = process.env.LEMMA_HOME?.trim() || join(homedir(), ".lemma");
const terminal = createInterface({ input: process.stdin, output: process.stdout });

/** Questions asked on the terminal; one the plugin withdraws (a sign-in's callback won) stops waiting. */
const interaction = definePlugin({
  id: "interaction",
  provides: [Interaction],
  layer: Layer.succeed(Interaction, {
    confirm: () => Effect.succeed(true),
    ask: (title) =>
      Effect.tryPromise({
        try: (signal) => terminal.question(`${title}\n> `, { signal }),
        catch: () => new InteractionError({ reason: "Dismissed", message: `"${title}" was not answered` }),
      }),
    select: (title) => Effect.fail(new InteractionError({ reason: "Unavailable", message: `No choice is asked here: "${title}"` })),
    form: (title) => Effect.fail(new InteractionError({ reason: "Unavailable", message: `No form is asked here: "${title}"` })),
  } as typeof Interaction.Service),
});

/** Prints the notices a sign-in publishes: its link, and how it ended. */
const notices = definePlugin({
  id: "notices",
  layer: Layer.effectDiscard(
    Effect.flatMap(PluginContext, (context) =>
      context.observe(Notice, (notice) =>
        Effect.sync(() => console.log(`  ${notice.message}${(notice.links ?? []).map((link) => `\n  ${link.url}`).join("")}`)),
      ),
    ),
  ),
});

/** The host's paths at the real home; the llm plugin asks the host nothing else here. */
const host = definePlugin({
  id: "host",
  provides: [HostControl, Paths],
  layer: Layer.merge(
    Layer.succeed(HostControl, {
      runtime: [HostControl.key, Paths.key],
      process: { pid: process.pid, startedAt: 0 },
      plugins: Effect.succeed([{ id: "llm.http" }]),
      composition: Effect.succeed({ id: "live", plugins: [] }),
    } as unknown as typeof HostControl.Service),
    Layer.succeed(Paths, { home, userConfig: join(home, "config.jsonc"), projectConfig: join(process.cwd(), ".lemma/config.jsonc"), cwd: process.cwd() }),
  ),
});

interface Outcome {
  readonly ref: string;
  readonly check: string;
  readonly ok: boolean;
  readonly detail: string;
}
const outcomes: Outcome[] = [];
const report = (ref: string, check: string, ok: boolean, detail: string) => {
  outcomes.push({ ref, check, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${ref}  ${check}${detail === "" ? "" : `  (${detail})`}`);
};

// Long enough for every provider's prompt cache (1,024 tokens at most), so the second request of a round reads it.
const PADDING = Array.from(
  { length: 60 },
  (_, at) => `Reference note ${at + 1}: the live check sends this text so that its prompt is long enough to cache.`,
).join("\n");
const add = {
  name: "add",
  description: "Adds two numbers.",
  parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
};
const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });

interface Run {
  readonly message: AssistantMessage | undefined;
  readonly failure: string | undefined;
  readonly deltas: number;
  /** The status its provider event named; none over a WebSocket. */
  readonly status: number | undefined;
}

const run = (llm: typeof Llm.Service, request: LlmRequest) =>
  Effect.gen(function* () {
    let deltas = 0;
    let status: number | undefined;
    let last: StreamEvent | undefined;
    const exit = yield* Effect.exit(
      Stream.runForEach(llm.stream(request), (event) =>
        Effect.sync(() => {
          last = event;
          if (event.type === "text-delta") deltas++;
          if (event.type === "provider") status = event.status;
        }),
      ),
    );
    const ended = last as StreamEvent | undefined;
    const message = ended?.type === "done" || ended?.type === "error" ? ended.message : undefined;
    const failure = Exit.isFailure(exit)
      ? String(Cause.squash(exit.cause))
      : ended?.type === "error"
        ? `${ended.failure?.kind ?? "failed"}: ${ended.message.errorMessage ?? ended.message.stopReason}`
        : undefined;
    return { message, failure, deltas, status } satisfies Run;
  });

const textOf = (message: AssistantMessage | undefined) => (message?.content ?? []).flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");

/** The level a round thinks at: `medium` where offered, else the nearest the model takes; none for a model without levels. */
const roundLevel = (info: ModelInfo): ThinkingLevel | undefined =>
  info.thinkingLevels.length === 0 ? undefined : info.thinkingLevels.includes("medium") ? "medium" : info.thinkingLevels.at(-1);

const check = (llm: typeof Llm.Service, ref: string) =>
  Effect.gen(function* () {
    const found = yield* Effect.exit(llm.model(ref));
    if (Exit.isFailure(found)) return report(ref, "model", false, String(Cause.squash(found.cause)));
    const info = found.value;
    const priced = info.cost.input > 0 || info.cost.output > 0;
    const sessionId = randomUUID();
    const level = roundLevel(info);
    const thinking = level === undefined ? {} : { thinking: level };

    // A streamed answer, with its usage and cost.
    const answer = yield* run(llm, new LlmRequest({ model: ref, messages: [user("Reply with exactly: lemma live check")], sessionId, ...thinking }));
    const usage = answer.message?.usage;
    report(
      ref,
      "answer",
      answer.failure === undefined && answer.deltas > 0 && (usage?.input ?? 0) > 0 && (usage?.output ?? 0) > 0 && (!priced || (usage?.cost.total ?? 0) > 0),
      answer.failure ??
        `${answer.deltas} deltas, ${usage?.input} in, ${usage?.output} out, $${usage?.cost.total.toFixed(6)}${answer.status === undefined ? ", over a WebSocket" : ""}`,
    );

    // A tool round trip: the second request sends the first's thinking and call back, and reads the prompt cache.
    const system = `${PADDING}\n\nWhen asked to add numbers, call the add tool, then state the sum.`;
    const first = yield* run(llm, new LlmRequest({ model: ref, system, tools: [add], messages: [user("Add 2 and 3.")], sessionId, ...thinking }));
    const call = first.message?.content.find((block) => block.type === "toolCall");
    if (first.failure !== undefined || call?.type !== "toolCall") {
      report(ref, "tool round trip", false, first.failure ?? `no tool call: ${textOf(first.message).slice(0, 120)}`);
    } else {
      const thought = first.message!.content.some((block) => block.type === "thinking");
      const messages: Message[] = [
        user("Add 2 and 3."),
        first.message!,
        { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "5" }], isError: false, timestamp: Date.now() },
      ];
      const second = yield* run(llm, new LlmRequest({ model: ref, system, tools: [add], messages, sessionId, ...thinking }));
      report(
        ref,
        "tool round trip",
        second.failure === undefined && textOf(second.message).includes("5"),
        second.failure ??
          `${call.name}(${JSON.stringify(call.arguments)}), ${thought ? "its thinking sent back" : "no thinking to send back"}, at ${level ?? "no level"}`,
      );
      const cached = second.message?.usage.cacheRead ?? 0;
      report(ref, "prompt cache", cached > 0, `${cached} tokens read from the cache`);
    }

    // Every thinking level it offers.
    for (const at of info.thinkingLevels) {
      const levelRun = yield* run(llm, new LlmRequest({ model: ref, messages: [user("Reply with: ok")], thinking: at, sessionId }));
      const thought = (levelRun.message?.content.some((block) => block.type === "thinking") ?? false) || (levelRun.message?.usage.reasoning ?? 0) > 0;
      // Asked not to think, it must not.
      report(
        ref,
        `thinking ${at}`,
        levelRun.failure === undefined && !(at === "off" && thought),
        levelRun.failure ?? `${levelRun.message?.usage.output} out${thought ? ", thought" : ""}`,
      );
    }

    // A stop midway: the stream ends at once, and the next request is answered.
    const started = Date.now();
    const stopped = yield* Effect.exit(
      llm.stream(new LlmRequest({ model: ref, messages: [user("Count from 1 to 300, one number a line.")], sessionId })).pipe(
        Stream.takeUntil((event) => event.type === "text-delta"),
        Stream.runDrain,
        Effect.timeout("60 seconds"),
      ),
    );
    const after = yield* run(llm, new LlmRequest({ model: ref, messages: [user("Reply with: ok")], sessionId }));
    report(
      ref,
      "stop midway",
      Exit.isSuccess(stopped) && after.failure === undefined,
      Exit.isSuccess(stopped) ? `stopped in ${Date.now() - started} ms` : String(Cause.squash(stopped.cause)),
    );
  });

const program = Effect.gen(function* () {
  const llm = yield* Llm;
  const credentials = yield* Credentials;
  if (login !== undefined) {
    const signs = (yield* llm.providers).find((provider) => provider.id === login)?.auth.some((auth) => auth.type === "oauth") ?? false;
    const signed = signs ? yield* Effect.exit(llm.login(login, "oauth")) : undefined;
    report(
      login,
      "sign in",
      signed !== undefined && Exit.isSuccess(signed),
      signed === undefined ? "it has no sign-in: store its key with Lemma's /login" : Exit.isSuccess(signed) ? "stored" : String(Cause.squash(signed.cause)),
    );
  }
  const providers = (yield* llm.providers).filter((provider) => provider.configured);
  const available = yield* llm.models({ available: true });
  const pick = (provider: string): string[] => {
    const served = available.filter((model) => model.provider === provider).map((model) => model.ref);
    const listed = (DEFAULTS[provider] ?? []).map((id) => `${provider}/${id}`).filter((ref) => served.includes(ref));
    return listed.length > 0 ? listed : served.slice(0, 1);
  };
  const refs = asked.length > 0 ? asked : providers.flatMap((provider) => pick(provider.id));
  // A model named for a provider is the one its refresh is checked with: a sign-in's plan may serve none of `DEFAULTS`.
  const named = (provider: string) => refs.find((ref) => ref.startsWith(`${provider}/`)) ?? pick(provider)[0];
  if (refresh) {
    for (const provider of providers) {
      const stored = yield* credentials.read(provider.id);
      const ref = named(provider.id);
      if (stored?.type !== "oauth" || ref === undefined) continue;
      yield* credentials.modify(provider.id, (current) => (current?.type === "oauth" ? { ...current, expires: 0 } : undefined));
      const asking = yield* run(llm, new LlmRequest({ model: ref, messages: [user("Reply with: ok")] }));
      const now = yield* credentials.read(provider.id);
      const renewed = now?.type === "oauth" && now.expires > Date.now() && now.access !== stored.access;
      report(provider.id, "refresh", asking.failure === undefined && renewed, asking.failure ?? (renewed ? "a new token stored" : "the token was not renewed"));
    }
  }
  if (refs.length === 0) console.log(`No models to check: no provider has a credential in ${home}, and none was named.`);
  for (const ref of refs) yield* check(llm, ref);
});

const config = { webSocket, ...(custom === undefined ? {} : { providers: [JSON.parse(custom)] }) };
const exit = await Effect.runPromiseExit(
  Effect.scoped(
    Effect.gen(function* () {
      const core = yield* makeCore([credentialsFile, interaction, notices, host, makeLlmPlugin()], { configs: { "llm.http": config } });
      return yield* core.run(program);
    }),
  ),
);
terminal.close();
if (Exit.isFailure(exit)) {
  console.error(Cause.pretty(exit.cause));
  process.exit(1);
}
const failed = outcomes.filter((outcome) => !outcome.ok);
console.log(`\n${outcomes.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length === 0 ? 0 : 1);
