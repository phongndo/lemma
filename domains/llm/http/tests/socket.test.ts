import { arch, platform, release } from "node:os";
import { describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import { Llm, LlmRequest } from "@lemma/llm";
import type { AssistantMessage, Message, StreamEvent } from "@lemma/llm";
import { makeLlmPlugin } from "../src/index.ts";
import { SocketPool } from "../src/socket.ts";
import {
  catalogModel,
  fakeCredentials,
  fakeInteraction,
  fakeSockets,
  faux,
  offline,
  responseEvents,
  runWith,
  scriptedFetch,
  sseBody,
  sseResponse,
} from "./helpers.ts";
import type { FakeSocket } from "./helpers.ts";

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const ask = (messages: readonly Message[], extra: Partial<ConstructorParameters<typeof LlmRequest>[0]> = {}) =>
  new LlmRequest({ model: "faux/gpt", messages, sessionId: "s1", ...extra });
const collect = (request: LlmRequest) => Effect.flatMap(Llm, (llm) => Stream.runCollect(llm.stream(request)));
const answer = (events: readonly StreamEvent[]): AssistantMessage => {
  const last = events.at(-1);
  if (last?.type !== "done") throw new Error(`no answer: ${JSON.stringify(last)}`);
  return last.message;
};

/** The llm plugin with a provider whose Responses API speaks the WebSocket mode, and the mode on. */
function setup(sockets: ReturnType<typeof fakeSockets>, fetchImpl: typeof fetch = offline, webSocket = true) {
  const provider = faux({ webSocket: true, models: [catalogModel("gpt", { api: "openai-responses" })] });
  const plugins = [
    fakeCredentials().plugin,
    fakeInteraction(() => Effect.succeed("")).plugin,
    makeLlmPlugin({ fetch: fetchImpl, providers: () => [provider], env: { FAUX_KEY: "sk-faux" }, socket: sockets.factory }),
  ];
  return (body: Effect.Effect<unknown, unknown, Llm>) => runWith(plugins, body as Effect.Effect<unknown, never, Llm>, { "llm.http": { webSocket } });
}

/** Answers each request with `answer <n>`, its response `resp_<n>`, n counting the socket's requests. */
const answering = (request: Record<string, unknown>, socket: FakeSocket) => {
  const n = socket.sent.length;
  for (const event of responseEvents(`resp_${n}`, `answer ${n}`)) socket.receive(event);
};

describe("OpenAI's WebSocket mode", () => {
  it("keeps a session on one connection, a request extending the last sending only what is new after it", async () => {
    const sockets = fakeSockets(answering);
    const run = setup(sockets);
    const [first, second] = (await run(
      Effect.gen(function* () {
        const first = yield* collect(ask([user("hi")], { system: "Be brief" }));
        const second = yield* collect(ask([user("hi"), answer(first), user("again")], { system: "Be brief" }));
        return [first, second];
      }),
    )) as [StreamEvent[], StreamEvent[]];
    expect(answer(first).content).toEqual([{ type: "text", text: "answer 1", textSignature: '{"v":1,"id":"msg_resp_1"}' }]);
    expect(answer(second)).toMatchObject({ responseId: "resp_2", content: [{ type: "text", text: "answer 2" }] });
    expect(sockets.opened).toHaveLength(1);
    const [socket] = sockets.opened;
    expect(socket!.url).toBe("wss://faux.test/v1/responses");
    expect(socket!.headers).toMatchObject({ authorization: "Bearer sk-faux", "user-agent": `lemma (${platform()} ${release()}; ${arch()})` });
    expect(socket!.sent[0]).toMatchObject({ type: "response.create", model: "gpt", store: false, input: [{ role: "system" }, { role: "user" }] });
    expect(socket!.sent[0]).not.toHaveProperty("stream");
    expect(socket!.sent[0]).not.toHaveProperty("previous_response_id");
    expect(socket!.sent[1]).toMatchObject({ previous_response_id: "resp_1", input: [{ role: "user", content: [{ type: "input_text", text: "again" }] }] });
  });

  it("sends the whole input when a request does not extend the last, or the provider no longer holds it", async () => {
    let forget = false;
    const sockets = fakeSockets((request, socket) => {
      if (forget && request.previous_response_id !== undefined) {
        forget = false;
        socket.receive({ type: "error", status: 400, error: { code: "previous_response_not_found", message: "Previous response not found" } });
        return;
      }
      answering(request, socket);
    });
    const run = setup(sockets);
    await run(
      Effect.gen(function* () {
        const first = yield* collect(ask([user("hi")], { system: "Be brief" }));
        // Another system prompt: the provider's memory holds another start.
        const other = yield* collect(ask([user("hi"), answer(first), user("again")], { system: "Be thorough" }));
        forget = true;
        yield* collect(ask([user("hi"), answer(first), user("again"), answer(other), user("more")], { system: "Be thorough" }));
      }),
    );
    const sent = sockets.opened[0]!.sent;
    expect(sent.map((request) => [request.previous_response_id ?? null, (request.input as unknown[]).length])).toEqual([
      [null, 2],
      [null, 4],
      // Forgotten: asked again with everything.
      ["resp_2", 1],
      [null, 6],
    ]);
  });

  it("goes over HTTP where no connection can be had, and for a request with no session", async () => {
    const sockets = fakeSockets(answering, { refuse: true });
    const { fetch, sent } = scriptedFetch(() => sseResponse(sseBody(responseEvents("resp_h", "over http"))));
    const run = setup(sockets, fetch);
    const events = (await run(Effect.all([collect(ask([user("hi")])), collect(ask([user("hi")], { sessionId: undefined }))]))) as StreamEvent[][];
    expect(events.map((each) => answer(each).content[0])).toMatchObject([{ text: "over http" }, { text: "over http" }]);
    expect(sockets.opened).toHaveLength(1);
    expect(sent.map((request) => request.url)).toEqual(["https://faux.test/v1/responses", "https://faux.test/v1/responses"]);
  });

  it("stays on HTTP while the mode is off", async () => {
    const sockets = fakeSockets(answering);
    const { fetch, sent } = scriptedFetch(() => sseResponse(sseBody(responseEvents("resp_h", "over http"))));
    await setup(sockets, fetch, false)(collect(ask([user("hi")])));
    expect(sockets.opened).toHaveLength(0);
    expect(sent).toHaveLength(1);
  });

  it("closes the connection when the consumer stops, so the provider stops generating; the next request opens another", async () => {
    let stall = true;
    const sockets = fakeSockets((request, socket) => {
      if (!stall) return answering(request, socket);
      // Starts, then sends nothing more.
      for (const event of responseEvents("resp_x", "half").slice(0, 3)) socket.receive(event);
    });
    const run = setup(sockets);
    await run(
      Effect.gen(function* () {
        const llm = yield* Llm;
        yield* Stream.runCollect(llm.stream(ask([user("hi")])).pipe(Stream.take(2)));
        yield* Effect.promise(() => expect.poll(() => sockets.opened[0]!.closed).toBe(true));
        stall = false;
        yield* collect(ask([user("hi")]));
        // Kept for the session's next request.
        expect(sockets.opened.map((socket) => socket.closed)).toEqual([true, false]);
      }),
    );
    expect(sockets.opened[1]!.sent[0]).not.toHaveProperty("previous_response_id");
  });

  it("opens one connection for a session though two requests ask at once, and stops one opening when closed", async () => {
    const sockets = fakeSockets(answering);
    const pool = new SocketPool(sockets.factory);
    const signal = new AbortController().signal;
    const [first, second] = await Promise.all([pool.acquire("s1", "wss://x", {}, signal), pool.acquire("s1", "wss://x", {}, signal)]);
    // The second goes over HTTP while the first opens.
    expect([first !== undefined, second === undefined]).toEqual([true, true]);
    expect(sockets.opened).toHaveLength(1);
    // Closed while another session's connection opens: it is stopped, and nothing opens after.
    const opening = pool.acquire("s2", "wss://x", {}, signal);
    pool.closeAll();
    expect(await opening).toBeUndefined();
    expect(await pool.acquire("s3", "wss://x", {}, signal)).toBeUndefined();
    expect(sockets.opened).toHaveLength(2);
    expect(sockets.opened.every((socket) => socket.closed)).toBe(true);
  });

  it("goes over HTTP when the connection drops before anything arrived, and fails an answer it cut off as transient", async () => {
    let cut = false;
    const sockets = fakeSockets((_, socket) => {
      if (!cut) return socket.drop();
      for (const event of responseEvents("resp_c", "half").slice(0, 3)) socket.receive(event);
      socket.drop();
    });
    const { fetch, sent } = scriptedFetch(() => sseResponse(sseBody(responseEvents("resp_h", "over http"))));
    const run = setup(sockets, fetch);
    const [dropped, half] = (await run(
      Effect.gen(function* () {
        const dropped = yield* collect(ask([user("hi")]));
        cut = true;
        return [dropped, yield* collect(ask([user("hi")]))];
      }),
    )) as [StreamEvent[], StreamEvent[]];
    expect(answer(dropped).content[0]).toMatchObject({ text: "over http" });
    expect(sent).toHaveLength(1);
    expect(half.at(-1)).toMatchObject({ type: "error", failure: { kind: "transient" }, message: { content: [{ type: "text", text: "half" }] } });
  });

  it("sends nothing for a request stopped before it was sent", async () => {
    const sockets = fakeSockets(answering);
    const pool = new SocketPool(sockets.factory);
    const connection = (await pool.acquire("s1", "wss://x", {}, new AbortController().signal))!;
    const stopped = new AbortController();
    stopped.abort();
    await expect(connection.request({ type: "response.create" }, stopped.signal).next()).rejects.toThrow("aborted");
    expect(sockets.opened[0]!.sent).toEqual([]);
    const refused = new AbortController();
    refused.abort();
    await expect(pool.acquire("s2", "wss://x", {}, refused.signal)).rejects.toThrow("aborted");
    expect(sockets.opened).toHaveLength(1);
  });

  it("fails an answer the provider refuses over the socket by its status", async () => {
    const sockets = fakeSockets((_, socket) => socket.receive({ type: "error", status: 429, error: { code: "rate_limit_exceeded", message: "Slow down" } }));
    const events = (await setup(sockets)(collect(ask([user("hi")])))) as StreamEvent[];
    expect(events.at(-1)).toMatchObject({ type: "error", failure: { kind: "rate-limit" }, message: { errorMessage: "429 rate_limit_exceeded: Slow down" } });
    // A failed request leaves no connection to reuse.
    expect(sockets.opened[0]!.closed).toBe(true);
  });
});
