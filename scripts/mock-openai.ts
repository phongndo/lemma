import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";

/**
 * A scripted OpenAI Chat Completions server for end-to-end runs without an API
 * key. A user turn gets a `bash` tool call; a tool result gets a streamed text
 * answer that quotes it. A prompt saying "slowly" gets a command that prints,
 * then runs until its host stops; one saying "ramble" gets a long answer and
 * no tool call: both are for cutting a turn off midway. Configure it as a
 * keyless custom provider:
 *
 *   { "plugins": { "llm": { "config": { "providers": [{ "id": "mock", "api": "openai-completions",
 *     "baseUrl": "http://127.0.0.1:7499/v1", "models": [{ "id": "scripted" }] }] } } } }
 *
 * It listens on `PORT` (default 7499; 0 picks a free one) and prints its base
 * URL once it does. A test sets its pace rather than waiting it out: `PACE_MS`
 * is the pause between streamed words (default 40, and 100 for a ramble), and
 * a ramble whose prompt names a gate (`gate:<name>`) stops halfway, printing
 * `waiting <name>`, until the line `open <name>` on stdin opens the gate for it
 * and every later one. `e2e.ts`, beside it, starts it so, with no pause.
 */
const port = Number(process.env.PORT ?? 7499);
const pace = (ms: number) => Number(process.env.PACE_MS ?? ms);

interface ChatMessage {
  readonly role: string;
  readonly content?: unknown;
}

const chunk = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "scripted", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

const opened = new Set<string>();
const waiting = new Map<string, (() => void)[]>();
const gate = (name: string) =>
  opened.has(name)
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        waiting.set(name, [...(waiting.get(name) ?? []), resolve]);
        console.log(`waiting ${name}`);
      });
createInterface({ input: process.stdin }).on("line", (line) => {
  const name = /^open (\S+)$/.exec(line.trim())?.[1];
  if (name === undefined) return;
  opened.add(name);
  for (const resolve of waiting.get(name) ?? []) resolve();
  waiting.delete(name);
});

const server = createServer((request, response) => {
  if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
    response.writeHead(404).end();
    return;
  }
  let body = "";
  request.on("data", (data) => {
    body += data;
  });
  request.on("end", async () => {
    const messages: ChatMessage[] = JSON.parse(body).messages;
    const last = messages.at(-1);
    const prompt = JSON.stringify(messages.filter((message) => message.role === "user").at(-1)?.content ?? "");
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    // A client cut off midway (its host killed) is not written to again.
    let gone = false;
    response.on("close", () => {
      gone = true;
    });
    const send = (text: string) => gone || response.write(text);
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, pace(ms)));
    if (last?.role === "tool") {
      const output = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
      const words = `The command printed: **${output.trim()}**. Everything works end to end.`.split(/(?<= )/);
      for (const word of words) {
        send(chunk({ content: word }));
        await pause(40);
      }
      send(chunk({}, "stop"));
    } else if (prompt.includes("ramble")) {
      const name = /gate:([\w-]+)/.exec(prompt)?.[1];
      for (let word = 1; word <= 60 && !gone; word++) {
        if (word === 31 && name !== undefined) await gate(name);
        send(chunk({ content: `word${word} ` }));
        await pause(100);
      }
      send(chunk({}, "stop"));
    } else {
      // `$PPID` is the host: the command outlives neither it nor a cancel, which kills the command's process group.
      const command = prompt.includes("slowly")
        ? "echo started && while kill -0 $PPID 2>/dev/null; do sleep 0.1; done && echo finished"
        : "echo hello from lemma, INIT_CWD=${INIT_CWD:-unset} && uname -s";
      send(chunk({ content: "Let me check with bash." }));
      await pause(40);
      send(chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: "" } }] }));
      send(
        chunk({
          tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command }) } }],
        }),
      );
      send(chunk({}, "tool_calls"));
    }
    send(
      `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "scripted", choices: [], usage: { prompt_tokens: 120, completion_tokens: 24, total_tokens: 144 } })}\n\n`,
    );
    send("data: [DONE]\n\n");
    response.end();
  });
});
server.on("error", (error) => {
  console.error(`mock-openai: ${error.message}`);
  process.exit(1);
});
// `PORT=0` takes a free port; the line names the one it took.
server.listen(port, "127.0.0.1", () => console.log(`mock-openai listening on http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`));
