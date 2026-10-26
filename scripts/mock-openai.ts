import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

/**
 * A scripted OpenAI Chat Completions server for end-to-end runs without an API
 * key. A user turn gets a `bash` tool call; a tool result gets a streamed text
 * answer that quotes it, at length (a list, a shell block, a Mermaid graph, a
 * TypeScript block) when the prompt says "at length". A prompt saying "slowly"
 * gets a command that prints, then runs until its host stops; one saying
 * "ramble" gets a long answer and no tool call: both are for cutting a turn off
 * midway. One saying "tally" gets a command that appends its call's id to
 * `tally.log` in the session's directory and then takes half a second, so a
 * test that kills the host meanwhile can tell whether the call ran twice. One
 * saying "draw a page" gets a `codemode` script that runs `git log`, waits at
 * the gate `script`, and draws a page (`html_render`), then a page the model
 * draws itself beside a script that draws none, then an answer. Each tool call
 * has an id of its own (`call_<n>`). Configure it as a keyless custom provider:
 *
 *   { "plugins": { "llm.pi-ai": { "config": { "providers": [{ "id": "mock", "api": "openai-completions",
 *     "baseUrl": "http://127.0.0.1:7499/v1", "models": [{ "id": "scripted" }] }] } } } }
 *
 * Its model list (`GET /v1/models`) checks a key as a provider's does: it
 * refuses a request without one, or with one that has "wrong" in it, and lists
 * `scripted` for any other, so a provider configured to need a key can be
 * connected and refused. It also serves a device sign-in (RFC 8628) as Kimi
 * Code's (`/api/oauth/...`), which a host signs in to here when
 * `KIMI_CODE_OAUTH_HOST` names this server: its code is `WDJB-MJHT`, and it is
 * never approved.
 *
 * It listens on `PORT` (default 7499; 0 picks a free one) and prints its base
 * URL once it does. A test sets its pace rather than waiting it out: `PACE_MS`
 * is the pause between streamed words (default 40, and 100 for a ramble), and
 * a ramble whose prompt names a gate (`gate:<name>`) stops halfway, printing
 * `waiting <name>`, until the line `open <name>` on stdin opens the gate for it
 * and every later one. After the line `hold` on stdin, each answer that starts
 * stops after its first words, printing `holding`, until the line `release`.
 * `e2e.ts`, beside it, starts it with no pause unless asked for one (the
 * torture test, `torture.ts`, asks for one).
 */
const port = Number(process.env.PORT ?? 7499);
const pace = (ms: number) => Number(process.env.PACE_MS ?? ms);

interface ChatMessage {
  readonly role: string;
  readonly content?: unknown;
}

const chunk = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "scripted", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

/** Tool calls made so far: each gets the next id. */
let calls = 0;

/** Where an opened gate leaves a file, so a command a script runs can wait at one too. */
const gates = mkdtempSync(join(tmpdir(), "lemma-mock-gates-"));
process.on("exit", () => rmSync(gates, { recursive: true, force: true }));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0));

const opened = new Set<string>();
const waiting = new Map<string, (() => void)[]>();
const gate = (name: string) =>
  opened.has(name)
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        waiting.set(name, [...(waiting.get(name) ?? []), resolve]);
        console.log(`waiting ${name}`);
      });
/** While `hold` is on: the answers stopped after their first words, each let go on `release`. */
let held: (() => void)[] | undefined;
createInterface({ input: process.stdin }).on("line", (line) => {
  const command = line.trim();
  if (command === "hold") held ??= [];
  else if (command === "release") {
    const stopped = held ?? [];
    held = undefined;
    for (const resolve of stopped) resolve();
  }
  const name = /^open (\S+)$/.exec(command)?.[1];
  if (name === undefined) return;
  opened.add(name);
  writeFileSync(join(gates, name), "");
  for (const resolve of waiting.get(name) ?? []) resolve();
  waiting.delete(name);
});

/** Reports what a page can reach and the theme it has, each time the theme changes: for a check of where pages are drawn. */
const probe = `<script>
const report = () => {
  let reach;
  try { reach = String(parent.document.title); } catch (error) { reach = error.name; }
  parent.postMessage({ type: "check-page", title: document.title, reach, bg: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(), loaded: performance.timeOrigin }, "*");
};
new MutationObserver(report).observe(document.getElementById("lemma-theme"), { childList: true, characterData: true, subtree: true });
report();
</script>`;
const COMMITS_PAGE = `<!doctype html><html><head><title>Commits</title></head><body><h3 style="margin:0 0 8px">Commits this week</h3><div style="display:flex;gap:6px;align-items:end;height:80px">${[
  40, 72, 28, 64, 50,
]
  .map((height, index) => `<div style="flex:1;height:${height}px;background:var(--chart-${index + 1});border-radius:4px"></div>`)
  .join("")}</div>${probe}</body></html>`;
const SUMMARY_PAGE = `<!doctype html><html><head><title>Summary</title></head><body><h3 style="margin:0 0 8px">Summary</h3><div style="height:120px;padding:16px;box-sizing:border-box;background:var(--bg-raised);border-radius:var(--radius)">Three packages, one plugin each.</div>${probe}</body></html>`;
/** The script that draws a page: a call that settles, one that waits at the gate `script`, and the page. */
const pageScript = () =>
  [
    '// @options: {"timeout_ms": 60000}',
    'const log = await tools.bash({ command: "git log --oneline -n 5" });',
    `await tools.bash({ command: ${JSON.stringify(`until [ -e '${join(gates, "script")}' ]; do sleep 0.05; done`)} });`,
    `await tools.html_render({ title: "Commits", html: ${JSON.stringify(COMMITS_PAGE)} });`,
    'return "drawn";',
  ].join("\n");

const ANSWER_AT_LENGTH = [
  "There are three packages: **client**, **contracts**, and **core**. Try:",
  "",
  "1. The model picker (Ctrl+K)",
  "2. Esc twice to stop a turn",
  "3. Settings → Providers for the login flow, or from a shell:",
  "",
  "   ```sh",
  "   lemma models --all",
  "   ```",
  "",
  "How they depend on each other:",
  "",
  "```mermaid",
  "graph LR",
  "  client --> contracts",
  "  core --> effect",
  "  contracts --> core",
  "```",
  "",
  "And the entry point:",
  "",
  "```ts",
  'import { boot } from "./ui/boot.tsx";',
  "",
  "await boot({ host, token, bundled, api, element, safe: false });",
  "```",
  "",
].join("\n");

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url?.endsWith("/models")) {
    const key = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
    if (key === undefined || key.includes("wrong")) {
      response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Incorrect API key provided" } }));
    } else response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: [{ id: "scripted", object: "model" }] }));
    return;
  }
  if (request.method === "POST" && request.url === "/api/oauth/device_authorization") {
    const verify = "https://www.kimi.com/code/authorize_device";
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        device_code: "scripted-device",
        user_code: "WDJB-MJHT",
        verification_uri: verify,
        verification_uri_complete: `${verify}?user_code=WDJB-MJHT`,
        interval: 5,
        expires_in: 900,
      }),
    );
    return;
  }
  if (request.method === "POST" && request.url === "/api/oauth/token") {
    response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "authorization_pending" }));
    return;
  }
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
    const asked = messages.map((message) => message.role).lastIndexOf("user");
    const prompt = JSON.stringify(messages[asked]?.content ?? "");
    /** The steps this turn has taken since its prompt: the model's answers so far. */
    const steps = messages.slice(asked + 1).filter((message) => message.role === "assistant").length;
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    // A client cut off midway (its host killed) is not written to again.
    let gone = false;
    response.on("close", () => {
      gone = true;
    });
    const send = (text: string) => gone || response.write(text);
    /** Started while held: it stops at its first pause. */
    let holding = held !== undefined;
    const pause = async (ms: number) => {
      if (holding && held !== undefined) {
        console.log("holding");
        await new Promise<void>((resolve) => held!.push(resolve));
      }
      holding = false;
      await new Promise((resolve) => setTimeout(resolve, pace(ms)));
    };
    const call = (name: string, args: object, index = 0, id = `call_${++calls}`) => {
      send(chunk({ tool_calls: [{ index, id, type: "function", function: { name, arguments: "" } }] }));
      send(chunk({ tool_calls: [{ index, function: { arguments: JSON.stringify(args) } }] }));
    };
    if (/draw a page/i.test(prompt) && steps < 2) {
      if (steps === 0) {
        send(chunk({ content: "I'll draw it with a script." }));
        await pause(40);
        call("codemode", { code: pageScript() });
      } else {
        call("html_render", { title: "Summary", html: SUMMARY_PAGE });
        await pause(40);
        call("codemode", { code: "return 2 + 2;" }, 1);
      }
      send(chunk({}, "tool_calls"));
    } else if (/draw a page/i.test(prompt)) {
      send(chunk({ content: "Both pages are above: the week's commits, and a summary." }));
      await pause(40);
      send(chunk({}, "stop"));
    } else if (last?.role === "tool") {
      const output = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
      const text = `The command printed: **${output.trim()}**. Everything works end to end.${prompt.includes("at length") ? `\n\n${ANSWER_AT_LENGTH}` : ""}`;
      for (const word of text.split(/(?<= )/)) {
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
      const id = `call_${++calls}`;
      const command = prompt.includes("slowly")
        ? "echo started && while kill -0 $PPID 2>/dev/null; do sleep 0.1; done && echo finished"
        : prompt.includes("tally")
          ? `echo ${id} >> tally.log && sleep 0.5 && echo tallied ${id}`
          : "echo hello from lemma, INIT_CWD=${INIT_CWD:-unset}, ELECTRON_RUN_AS_NODE=${ELECTRON_RUN_AS_NODE:-unset}, NODE_OPTIONS=${NODE_OPTIONS:-unset} && uname -s";
      send(chunk({ content: "Let me check with bash." }));
      await pause(40);
      call("bash", { command }, 0, id);
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
