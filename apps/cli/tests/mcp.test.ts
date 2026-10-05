import { Deferred, Effect, PubSub, Schema, Stream } from "effect";
import { RpcTest } from "@effect/rpc";
import type { RpcGroup } from "@effect/rpc";
import { describe, expect, test } from "vitest";
import { HostError, HostRpcs, MCP_HIDDEN, McpServerSpec } from "@lemma/contracts";
import type { HostEvent, InteractionAnswer, McpLogEntry, McpServerInfo, McpToolInfo } from "@lemma/contracts";
import { ExitCode, run } from "../src/cli.ts";
import type { Connection, Io } from "../src/cli.ts";

type Handlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof HostRpcs>>;

const server = (spec: McpServerSpec, extra: Partial<McpServerInfo> = {}): McpServerInfo => ({
  id: spec.id,
  spec,
  type: spec.url === undefined ? "stdio" : (spec.type ?? "http"),
  scope: "user",
  status: "ready",
  since: 0,
  tools: [],
  resources: 0,
  prompts: 0,
  secrets: [],
  missing: [],
  ...extra,
});

const tool = (name: string, extra: Partial<McpToolInfo> = {}): McpToolInfo => ({ name, tool: `gh__${name}`, enabled: true, hints: {}, ...extra });

const github = server(
  {
    id: "gh",
    name: "GitHub",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    cwd: "/srv",
    env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", API_KEY: MCP_HIDDEN, DEBUG: "1" },
  },
  {
    scope: "project",
    tools: [
      tool("create_issue", { title: "Create an issue", hints: { openWorld: true } }),
      tool("delete_repo", { enabled: false, hints: { destructive: true } }),
      tool("search", { hints: { readOnly: true } }),
    ],
    secrets: ["GITHUB_TOKEN"],
    missing: ["GITHUB_ORG"],
    server: { name: "github-mcp", version: "1.2.0", title: "GitHub" },
    protocol: "2025-06-18",
    instructions: "Search before creating.\nNever force-push.",
    resources: 2,
    prompts: 1,
  },
);
const linear = server(
  {
    id: "linear",
    url: "https://mcp.linear.app/mcp",
    headers: { Authorization: MCP_HIDDEN, "X-Team": "${TEAM}" },
    oauth: { clientId: "lemma", scopes: ["read", "write"] },
  },
  { status: "auth", error: "The server wants a sign-in", signedIn: false },
);
const broken = server({ id: "broken", command: "node", args: ["server.js"] }, { status: "error", error: "spawn node ENOENT\nat ChildProcess" });
const quiet = server({ id: "quiet", command: "quiet-mcp", enabled: false }, { status: "off" });

interface Call {
  readonly method: string;
  readonly payload: unknown;
}

/**
 * A host that answers `Mcp.*` from memory, as the transport would with the
 * mcp plugin on (or, with `mcp: false`, off). A save shows the server as
 * `afterSave` says; a login sends its page as a notice and asks for the
 * address the browser landed on.
 */
const fakeHost = (initial: readonly McpServerInfo[], options: { readonly mcp?: boolean } = {}) => {
  const servers = new Map(initial.map((info) => [info.id, info]));
  const calls: Call[] = [];
  const state = {
    afterSave: (_spec: McpServerSpec): Partial<McpServerInfo> => ({ status: "ready" }),
    logs: [] as McpLogEntry[],
  };
  const unavailable = () => Effect.fail(new HostError({ code: "Unavailable", message: "No plugin manages MCP servers: turn on the mcp plugin, or add one" }));
  const known = (id: string) => (servers.has(id) ? Effect.void : Effect.fail(new HostError({ code: "NotFound", message: `No MCP server ${id}`, subject: id })));
  const record = (method: string) => (payload: unknown) => {
    calls.push({ method, payload });
    return options.mcp === false ? unavailable() : Effect.void;
  };

  const handlers = Effect.gen(function* () {
    const events = yield* PubSub.unbounded<HostEvent>();
    const subscribed = yield* Deferred.make<void>();
    const questions = new Map<string, Deferred.Deferred<InteractionAnswer, HostError>>();
    const notFaked = Object.fromEntries(
      [...HostRpcs.requests.keys()].map((tag) => [tag, () => Effect.fail(new HostError({ code: "Unknown", message: `the fake host does not answer ${tag}` }))]),
    );
    const handlers: Partial<Handlers> = {
      "Host.Info": () => Effect.succeed({ version: "test", cwd: "/", home: "/", composition: { id: "test", plugins: [] } } as never),
      "Host.Events": () =>
        Stream.unwrapScoped(
          Effect.gen(function* () {
            const queue = yield* PubSub.subscribe(events);
            yield* Deferred.succeed(subscribed, undefined);
            return Stream.fromQueue(queue);
          }),
        ),
      "Interaction.Answer": ({ id, answer }) => Effect.asVoid(Deferred.succeed(questions.get(id)!, answer)),
      "Interaction.Dismiss": ({ id }) => Effect.asVoid(Deferred.fail(questions.get(id)!, new HostError({ code: "Cancelled", message: "Dismissed" }))),
      "Mcp.Servers": () => (options.mcp === false ? unavailable() : Effect.sync(() => [...servers.values()])),
      "Mcp.Save": (payload) =>
        Effect.gen(function* () {
          yield* record("save")(payload);
          // What the transport would refuse to decode.
          const spec = Schema.decodeUnknownSync(McpServerSpec)(payload.spec);
          const previous = servers.get(spec.id);
          const secrets = new Set(previous?.secrets);
          for (const [name, value] of Object.entries(payload.secrets ?? {})) {
            if (value === null) secrets.delete(name);
            else secrets.add(name);
          }
          servers.set(spec.id, server(spec, { scope: payload.scope ?? previous?.scope ?? "user", secrets: [...secrets], ...state.afterSave(spec) }));
        }),
      "Mcp.Remove": (payload) => Effect.zipRight(record("remove")(payload), known(payload.id)),
      "Mcp.Restart": (payload) => Effect.zipRight(record("restart")(payload), known(payload.id)),
      "Mcp.Logout": (payload) => record("logout")(payload),
      "Mcp.Logs": (payload) => Effect.as(record("logs")(payload), state.logs),
      "Mcp.Login": (payload) =>
        Effect.gen(function* () {
          yield* record("login")(payload);
          const origin = `mcp:${payload.id}`;
          // The CLI subscribes before it calls; a real host replays open questions to a late subscriber.
          yield* Deferred.await(subscribed);
          yield* PubSub.publish(events, {
            type: "notice",
            notice: { level: "info", source: origin, message: "Sign in to Linear", links: [{ url: "https://auth.example/authorize?client=lemma" }] },
          });
          const asked = yield* Deferred.make<InteractionAnswer, HostError>();
          questions.set("q1", asked);
          yield* PubSub.publish(events, { type: "interaction", request: { type: "ask", id: "q1", title: "Paste the address your browser landed on", origin } });
          // Another login's question, which this one must leave alone.
          yield* PubSub.publish(events, { type: "interaction", request: { type: "ask", id: "q2", title: "Someone else's", origin: "mcp:other" } });
          const answer = yield* Deferred.await(asked);
          calls.push({ method: "answered", payload: answer });
        }),
    };
    return { ...notFaked, ...handlers } as Handlers;
  });
  const layer = HostRpcs.toLayer(handlers);

  const reach = (_io: Io) =>
    Effect.map(RpcTest.makeClient(HostRpcs).pipe(Effect.provide(layer)), (client): Connection => ({
      target: { url: "http://fake.test", token: "t", source: "env", from: "LEMMA_URL" },
      rpc: client,
      live: Effect.succeed(client),
    }));

  const invoke = async (argv: readonly string[], io: Partial<Io> = {}) => {
    let out = "";
    const err: string[] = [];
    const code = await run(
      argv,
      {
        env: {},
        cwd: "/work",
        out: (text) => {
          out += `${text}\n`;
        },
        err: (text) => err.push(text),
        ...io,
      },
      reach,
    );
    return { code, out: out.replace(/\n$/, ""), err: err.join("\n") };
  };
  const saved = () => calls.filter((call) => call.method === "save").map((call) => call.payload as { spec: McpServerSpec; secrets?: object; scope?: string });
  return { invoke, calls, saved, servers, state };
};

describe("lemma mcp", () => {
  test("lists each server: status (with a short reason), tools on of all, and transport and target", async () => {
    const host = fakeHost([github, linear, broken, quiet]);
    const listed = await host.invoke(["mcp"]);
    expect(listed.code).toBe(ExitCode.ok);
    expect(listed.out.split("\n")).toEqual([
      "server       status                    tools  transport",
      "gh (GitHub)  ready                     2/3    stdio npx -y @modelcontextprotocol/server-github",
      "linear       needs sign-in             -      http mcp.linear.app/mcp",
      "broken       error: spawn node ENOENT  -      stdio node server.js",
      "quiet        off                       -      stdio quiet-mcp",
    ]);
    expect(JSON.parse((await host.invoke(["mcp", "list", "--json"])).out).map((info: McpServerInfo) => info.id)).toEqual(["gh", "linear", "broken", "quiet"]);
    expect((await fakeHost([]).invoke(["mcp", "list"])).out).toBe("No MCP servers. `lemma mcp add` adds one from its URL, its command, or a config.");
  });

  test("show prints the config as written (hidden values as such), secrets, unset variables, what the server reported, and its tools", async () => {
    const host = fakeHost([github, linear]);
    const shown = await host.invoke(["mcp", "show", "gh"]);
    expect(shown.code).toBe(ExitCode.ok);
    const lines = shown.out.split("\n");
    expect(lines[0]).toBe("gh (GitHub)");
    expect(lines[1]).toMatch(/^ {2}status +ready \(since \d{4}-\d\d-\d\d \d\d:\d\d\)$/);
    expect(shown.out).toContain(
      [
        "  transport  stdio",
        "  command    npx -y @modelcontextprotocol/server-github",
        "  cwd        /srv",
        "  env        GITHUB_TOKEN=${GITHUB_TOKEN}",
        "             API_KEY=(hidden)",
        "             DEBUG=1",
        "  secrets    GITHUB_TOKEN",
        "  saved in   the project config",
        "  server     GitHub 1.2.0 (github-mcp)",
        "  protocol   2025-06-18",
        "  offers     3 tools, 2 resources, 1 prompt",
      ].join("\n"),
    );
    expect(shown.out).toContain(
      "warning: ${GITHUB_ORG} is not set: no secret of gh's and nothing in the host's environment sets it (the web app's Settings → MCP servers stores one)",
    );
    expect(shown.out).toContain("Instructions\n    Search before creating.\n    Never force-push.");
    expect(shown.out).toContain(
      [
        "Tools (2 of 3 on)",
        "  on   create_issue  Create an issue  open-world",
        "  off  delete_repo                    destructive",
        "  on   search                         read-only",
      ].join("\n"),
    );

    const url = (await host.invoke(["mcp", "show", "linear"])).out;
    expect(url).toMatch(/ {2}status +needs sign-in \(since [^)]+\)\n {2}reason +The server wants a sign-in\n/);
    expect(url).toContain(
      "  url        https://mcp.linear.app/mcp\n  headers    Authorization: (hidden)\n             X-Team: ${TEAM}\n  sign-in    not signed in",
    );
    expect(url).toContain("  oauth      client lemma, scopes read write");
    expect(url).toContain("Sign in with lemma mcp login linear.");
    expect(url).toContain("No tools listed: it needs a sign-in.");
    // A reason over several lines keeps to its column.
    const failed = (await fakeHost([broken]).invoke(["mcp", "show", "broken"])).out;
    expect(failed).toMatch(/\n {2}status +error \(since [^)]+\)\n {2}reason +spawn node ENOENT\n {13}at ChildProcess\n {2}transport  stdio\n/);
    expect(failed).toContain("lemma mcp logs broken shows what it printed.\n\nNo tools listed: it did not connect.");
    expect(JSON.parse((await host.invoke(["mcp", "show", "linear", "--json"])).out)).toEqual(linear);
  });

  test("add saves the server at a URL, named after its host; one that wants a sign-in says to log in next", async () => {
    const host = fakeHost([]);
    host.state.afterSave = () => ({ status: "auth" });
    const added = await host.invoke(["mcp", "add", "https://mcp.linear.app/mcp"]);
    expect(added).toEqual({ code: ExitCode.ok, err: "", out: "added linear: it needs a sign-in. Next: lemma mcp login linear" });
    expect(host.saved()).toEqual([{ spec: { id: "linear", url: "https://mcp.linear.app/mcp" } }]);

    // --project saves it in the project's config; --json reports what was saved and how it is doing.
    const json = await host.invoke(["mcp", "add", "https://mcp.example.com/mcp", "--name", "Example", "--project", "--json"]);
    expect(json.code).toBe(ExitCode.ok);
    expect(host.saved()[1]).toEqual({ spec: { id: "example", name: "Example", url: "https://mcp.example.com/mcp" }, scope: "project" });
    expect(JSON.parse(json.out)).toMatchObject({
      added: [{ id: "example", secrets: [], notes: [], server: { id: "example", status: "auth", scope: "project" } }],
      problems: [],
    });
  });

  test("add saves a command after --: leading K=V words are its env, a credential among them a secret, and every word stays one", async () => {
    const host = fakeHost([]);
    host.state.afterSave = () => ({ status: "ready", tools: [tool("a"), tool("b")] });
    const added = await host.invoke([
      "mcp",
      "add",
      "--",
      "GITHUB_TOKEN=ghp_123",
      "DEBUG=1",
      "npx",
      "-y",
      "@modelcontextprotocol/server-github",
      "--root",
      "/my docs",
      "--json",
    ]);
    expect(added.code).toBe(ExitCode.ok);
    expect(host.saved()).toEqual([
      {
        spec: {
          id: "github",
          command: "npx",
          // After `--` everything is the command's, `--json` too.
          args: ["-y", "@modelcontextprotocol/server-github", "--root", "/my docs", "--json"],
          env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", DEBUG: "1" },
        },
        secrets: { GITHUB_TOKEN: "ghp_123" },
      },
    ]);
    expect(added.out).toBe("added github: ready, 2 tools\n  secret kept out of the config: GITHUB_TOKEN");
    expect(added.err).toBe("");

    // --name gives the id; the whole command line in one word reads the same.
    expect((await host.invoke(["mcp", "add", "--name", "pw", "npx -y @playwright/mcp@latest"])).out).toBe("added pw: ready, 2 tools");
    expect(host.saved()[1]).toEqual({ spec: { id: "pw", command: "npx", args: ["-y", "@playwright/mcp@latest"] } });
  });

  test("add - reads a config from standard input: secrets moved out, placeholders and skipped entries warned of, each server reported", async () => {
    const config = JSON.stringify({
      mcpServers: {
        GitHub: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret" } },
        notes: { env: { API_KEY: "<YOUR_KEY>" }, command: "notes-mcp" },
        bad: { foo: 1 },
      },
    });
    const host = fakeHost([]);
    host.state.afterSave = (spec) => (spec.id === "notes" ? { status: "error", error: "spawn notes-mcp ENOENT" } : { status: "ready", tools: [tool("a")] });
    const added = await host.invoke(["mcp", "add", "-"], { input: async () => config });
    expect(added.code).toBe(ExitCode.ok);
    expect(host.saved()).toEqual([
      {
        spec: {
          id: "github",
          name: "GitHub",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_PERSONAL_ACCESS_TOKEN}" },
        },
        secrets: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret" },
      },
      { spec: { id: "notes", command: "notes-mcp", env: { API_KEY: "${API_KEY}" } } },
    ]);
    expect(added.err.split("\n")).toEqual([
      'lemma: not added: "bad" has neither a command nor a URL',
      "lemma: notes: Set API_KEY: the config has a placeholder (<YOUR_KEY>)",
    ]);
    expect(added.out.split("\n")).toEqual([
      "added github (GitHub): ready, 1 tool",
      "  secret kept out of the config: GITHUB_PERSONAL_ACCESS_TOKEN",
      "added notes, but it did not connect: spawn notes-mcp ENOENT",
      "lemma mcp logs notes shows what it printed.",
    ]);
    // The secret's value never reaches the output.
    const json = await fakeHost([]).invoke(["mcp", "add", "-", "--json"], { input: async () => config });
    expect(json.out).not.toContain("ghp_secret");
    expect(JSON.parse(json.out).added.map((entry: { id: string; secrets: string[] }) => [entry.id, entry.secrets])).toEqual([
      ["github", ["GITHUB_PERSONAL_ACCESS_TOKEN"]],
      ["notes", []],
    ]);
  });

  test("add never replaces a server: an id in use gets a suffix", async () => {
    const host = fakeHost([linear]);
    expect((await host.invoke(["mcp", "add", "https://mcp.linear.app/mcp"])).out).toBe("added linear-2 (linear): ready, 0 tools");
    expect(host.saved()).toEqual([{ spec: { id: "linear-2", name: "linear", url: "https://mcp.linear.app/mcp" } }]);
    expect(host.servers.get("linear")).toEqual(linear);
  });

  test("add fails when it finds no server, saving nothing", async () => {
    const host = fakeHost([]);
    const none = await host.invoke(["mcp", "add", "-", "--json"], { input: async () => '{ "mcpServers": { "bad": { "foo": 1 } } }' });
    expect(none.code).toBe(ExitCode.failed);
    expect(JSON.parse(none.err).error).toEqual({ code: "Invalid", message: 'No MCP server to add: "bad" has neither a command nor a URL' });
    expect((await host.invoke(["mcp", "add", "-"], { input: async () => "{ nope" })).err).toMatch(/^lemma: No MCP server to add: Not JSON: /);
    expect((await host.invoke(["mcp", "add", "-"], { input: async () => " \n" })).code).toBe(ExitCode.usage);
    expect(host.saved()).toEqual([]);
  });

  test("login prints the page to open and answers the host's question for this server only", async () => {
    const host = fakeHost([linear, github]);
    const login = await host.invoke(["mcp", "login", "linear", "--answer", "http://localhost:4567/callback?code=abc"]);
    expect(login.code).toBe(ExitCode.ok);
    expect(login.out).toBe("signed in to linear");
    expect(login.err).toBe("Open this page to sign in to linear:\n  https://auth.example/authorize?client=lemma");
    expect(host.calls.filter((call) => call.method === "answered").map((call) => call.payload)).toEqual([
      { type: "ask", value: "http://localhost:4567/callback?code=abc" },
    ]);

    const stdio = await host.invoke(["mcp", "login", "gh", "--json"]);
    expect(stdio.code).toBe(ExitCode.failed);
    expect(JSON.parse(stdio.err).error).toMatchObject({ code: "Invalid", message: "gh runs as a command on the host; only a server at a URL signs in" });
  });

  test("remove, restart, logout, and logs go to the server named", async () => {
    const host = fakeHost([github]);
    host.state.logs = [
      { at: 0, source: "stderr", text: "starting\nready" },
      { at: 0, source: "server", level: "warning", text: "rate limited" },
      { at: 0, source: "host", text: "reconnected" },
    ];
    const logs = (await host.invoke(["mcp", "logs", "gh"])).out.replace(/\d\d:\d\d:\d\d/g, "HH:MM:SS");
    expect(logs.split("\n")).toEqual([
      "HH:MM:SS  stderr          starting",
      "                          ready",
      "HH:MM:SS  server warning  rate limited",
      "HH:MM:SS  host            reconnected",
    ]);
    for (const [sub, out] of [
      ["restart", "restarted gh"],
      ["logout", "signed out of gh"],
      ["remove", "removed gh"],
    ] as const) {
      expect(await host.invoke(["mcp", sub, "gh"])).toMatchObject({ code: ExitCode.ok, out });
    }
    expect(host.calls).toEqual([
      { method: "logs", payload: { id: "gh" } },
      { method: "restart", payload: { id: "gh" } },
      { method: "logout", payload: { id: "gh" } },
      { method: "remove", payload: { id: "gh" } },
    ]);
  });

  test("an unknown id and a host without the mcp plugin read well", async () => {
    const missing = await fakeHost([github, linear]).invoke(["mcp", "show", "nope", "--json"]);
    expect(missing.code).toBe(ExitCode.failed);
    expect(JSON.parse(missing.err).error).toEqual({ code: "NotFound", subject: "nope", message: 'No MCP server "nope": the servers are gh, linear' });
    const host = fakeHost([]);
    for (const sub of ["remove", "restart", "logout", "login", "logs"]) {
      expect((await host.invoke(["mcp", sub, "nope"])).err, sub).toBe('lemma: No MCP server "nope": none are configured (lemma mcp add adds one)');
    }
    expect(host.calls).toEqual([]);

    const off = fakeHost([], { mcp: false });
    for (const argv of [["mcp"], ["mcp", "remove", "gh"], ["mcp", "add", "--", "cmd"]]) {
      const result = await off.invoke(["--json", ...argv]);
      expect(result.code, argv.join(" ")).toBe(ExitCode.failed);
      expect(JSON.parse(result.err).error, argv.join(" ")).toMatchObject({ code: "Unavailable" });
    }
    expect(off.calls).toEqual([]);
    expect((await off.invoke(["mcp"])).err).toBe(
      "lemma: No plugin manages MCP servers: the mcp plugin is off or not running. `lemma plugins show mcp` says why; `lemma plugins enable mcp` turns it on.",
    );
  });

  test("rejects bad usage before reaching the host", async () => {
    const host = fakeHost([github]);
    for (const argv of [
      ["mcp", "bogus"],
      ["mcp", "list", "extra"],
      ["mcp", "show"],
      ["mcp", "show", "gh", "extra"],
      ["mcp", "add"],
      ["mcp", "add", "--"],
      ["mcp", "add", ""],
      // No standard input to read.
      ["mcp", "add", "-"],
      // A command's flags need -- before them.
      ["mcp", "add", "npx", "-y", "server"],
      ["mcp", "add", "--url", "https://x.example/mcp"],
      ["mcp", "remove"],
      ["mcp", "logs", "gh", "extra"],
      ["mcp", "tools", "gh"],
      ["mcp", "enable", "gh"],
      ["mcp", "import", "config.json"],
    ]) {
      expect((await host.invoke(argv)).code, argv.join(" ")).toBe(ExitCode.usage);
    }
    expect(host.calls).toEqual([]);
  });

  test("help lists the mcp commands", async () => {
    const help = await fakeHost([]).invoke(["--help"]);
    expect(help.out).toContain("mcp add -- <command> [args…]");
    expect(help.out).toContain("mcp remove|restart <id>");
  });
});
