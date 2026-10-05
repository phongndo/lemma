import { Duration, Effect } from "effect";
import { HostError, joinCommandLine, parseMcpInput } from "@lemma/contracts";
import type { McpServerInfo, McpServerSpec } from "@lemma/contracts";
import type { HostRpcClient } from "@lemma/client";
import { CliError, ExitCode, usage } from "./command.ts";
import type { Command, Failure, Io, Options } from "./command.ts";
import { formatMcpLogs, formatMcpServer, formatMcpServers } from "./format.ts";
import { noticeLine, questionHandler, subscribe } from "./live.ts";

/**
 * `lemma mcp …`: the MCP servers the host connects to, through the `Mcp.*`
 * calls the `mcp` plugin answers. Every command that names a server looks it
 * up first, so an unknown id and a host without the plugin read the same
 * whichever command met them.
 */

/** How long `add` waits for new servers to connect before saying they are still connecting. */
const SETTLE = Duration.seconds(10);

// ------------------------------------------------------------------ the host

/** `Unavailable` from an `Mcp.*` call means no plugin manages MCP servers. */
const managed = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | CliError, R> =>
  Effect.mapError(effect, (error) =>
    error instanceof HostError && error.code === "Unavailable"
      ? new CliError({
          code: "Unavailable",
          message:
            "No plugin manages MCP servers: the mcp plugin is off or not running. `lemma plugins show mcp` says why; `lemma plugins enable mcp` turns it on.",
          exit: ExitCode.failed,
        })
      : error,
  );

const listServers = (rpc: HostRpcClient) => managed(rpc.Mcp.Servers());

const notFound = (id: string, servers: readonly McpServerInfo[]) =>
  new CliError({
    code: "NotFound",
    message: `No MCP server "${id}": ${servers.length ? `the servers are ${servers.map((server) => server.id).join(", ")}` : "none are configured (lemma mcp add adds one)"}`,
    subject: id,
    exit: ExitCode.failed,
  });

const serverOf = (rpc: HostRpcClient, id: string) =>
  Effect.flatMap(listServers(rpc), (servers) => {
    const server = servers.find((candidate) => candidate.id === id);
    return server === undefined ? Effect.fail(notFound(id, servers)) : Effect.succeed(server);
  });

/** Servers just saved, once each has connected or failed to, or as they are when `SETTLE` runs out. */
const settle = (rpc: HostRpcClient, ids: readonly string[]) =>
  Effect.gen(function* () {
    const deadline = Date.now() + Duration.toMillis(SETTLE);
    for (;;) {
      const servers = (yield* listServers(rpc)).filter((server) => ids.includes(server.id));
      if (servers.every((server) => server.status !== "starting") || Date.now() >= deadline) return servers;
      yield* Effect.sleep(Duration.millis(250));
    }
  });

// ------------------------------------------------------------------ add

/** What `add` says of a server it saved, once it has settled: how it is doing, and what to do next. */
const added = (spec: McpServerSpec, server: McpServerInfo | undefined): string => {
  const id = spec.id;
  // The name it was given, when its id is not that: a config's `GitHub`, or a taken id's suffix.
  const label = spec.name === undefined || spec.name === id ? id : `${id} (${spec.name})`;
  switch (server?.status) {
    case "ready":
      return `added ${label}: ready, ${server.tools.length} tool${server.tools.length === 1 ? "" : "s"}`;
    case "auth":
      return `added ${label}: it needs a sign-in. Next: lemma mcp login ${id}`;
    case "error":
      return `added ${label}, but it did not connect: ${server.error ?? "no reason given"}\nlemma mcp logs ${id} shows what it printed.`;
    case "starting":
      return `added ${label}: still connecting (lemma mcp show ${id})`;
    case "off":
      return `added ${label}: off, as its config says`;
    case undefined:
      return `added ${label}`;
  }
};

/**
 * `mcp add <text…>`: the servers in a URL, a command line, or a config, read
 * by `parseMcpInput` as the web app reads a paste. One word is the text as
 * written; several (a command after `--`) are quoted back into one line, so a
 * word with spaces stays one word. `-` reads standard input.
 */
const addCommand = (words: readonly string[], options: Options, io: Io): Command | CliError => {
  if (words.join("").trim() === "") return usage("mcp add needs a server's URL, its command after --, or its config (- reads it from standard input)");
  const stdin = words.length === 1 && words[0] === "-";
  if (stdin && io.input === undefined) return usage("Nothing to read on standard input");
  const read = stdin ? Effect.promise(io.input!) : Effect.succeed(words.length === 1 ? words[0]! : joinCommandLine(words));
  return ({ rpc }) =>
    Effect.gen(function* () {
      const text = yield* read;
      if (text.trim() === "") return yield* usage("Standard input is empty: there is nothing to add");
      const taken = (yield* listServers(rpc)).map((server) => server.id);
      const found = parseMcpInput(text, { taken, ...(options.name === undefined ? {} : { name: options.name }) });
      if (found.servers.length === 0) {
        return yield* new CliError({ code: "Invalid", message: `No MCP server to add: ${found.problems.join("; ")}`, exit: ExitCode.failed });
      }
      for (const problem of found.problems) io.err(`lemma: not added: ${problem}`);
      for (const { spec, notes } of found.servers) for (const note of notes) io.err(`lemma: ${spec.id}: ${note}`);
      for (const { spec, secrets } of found.servers) {
        yield* rpc.Mcp.Save({ spec, ...(Object.keys(secrets).length > 0 ? { secrets } : {}), ...(options.project ? { scope: "project" as const } : {}) });
      }
      const ids = found.servers.map(({ spec }) => spec.id);
      const settled = yield* settle(rpc, ids);
      // Secrets by name only: their values never leave for the output.
      const servers = found.servers.map(({ spec, secrets, notes }) => {
        const server = settled.find((candidate) => candidate.id === spec.id);
        return { id: spec.id, spec, secrets: Object.keys(secrets), notes, ...(server === undefined ? {} : { server }) };
      });
      return {
        json: { added: servers, problems: found.problems },
        text: servers
          .flatMap(({ spec, secrets, server }) => [
            added(spec, server),
            ...(secrets.length === 0 ? [] : [`  secret${secrets.length === 1 ? "" : "s"} kept out of the config: ${secrets.join(", ")}`]),
          ])
          .join("\n"),
      };
    });
};

// ------------------------------------------------------------------ one server

const showCommand =
  (id: string): Command =>
  ({ rpc }) =>
    Effect.map(serverOf(rpc, id), (server) => ({ json: server, text: formatMcpServer(server) }));

/** Runs `call` on a server that exists, and says `done`. */
const act =
  (id: string, call: (rpc: HostRpcClient) => Effect.Effect<void, Failure>, done: string, key: string): Command =>
  ({ rpc }) =>
    Effect.gen(function* () {
      yield* serverOf(rpc, id);
      yield* call(rpc);
      return { json: { [key]: id }, text: `${done} ${id}` };
    });

/**
 * `mcp login <id>`: signs in to a URL server. The host sends the page to
 * open as a notice from `mcp:<id>`, and may ask for the address the browser
 * landed on (when it is not on the host's machine); questions are answered
 * as `login`'s are.
 */
const loginCommand =
  (id: string): Command =>
  (connection, io, options) =>
    Effect.gen(function* () {
      const server = yield* serverOf(connection.rpc, id);
      if (server.type === "stdio") {
        return yield* new CliError({
          code: "Invalid",
          message: `${id} runs as a command on the host; only a server at a URL signs in`,
          subject: id,
          exit: ExitCode.failed,
        });
      }
      const origin = `mcp:${id}`;
      const rpc = yield* connection.live;
      const questions = yield* questionHandler(rpc, io, options, origin);
      yield* subscribe(rpc, (event) =>
        Effect.gen(function* () {
          if (event.type === "notice" && event.notice.source === origin) {
            const link = event.notice.links?.[0]?.url;
            io.err(link === undefined ? noticeLine(event) : `Open this page to sign in to ${server.spec.name ?? id}:\n  ${link}`);
          }
          yield* questions(event);
        }),
      );
      yield* rpc.Mcp.Login({ id });
      return { json: { signedIn: id }, text: `signed in to ${server.spec.name ?? id}` };
    });

const logsCommand =
  (id: string): Command =>
  ({ rpc }) =>
    Effect.gen(function* () {
      yield* serverOf(rpc, id);
      const entries = yield* rpc.Mcp.Logs({ id });
      return { json: entries, text: formatMcpLogs(entries) };
    });

// ------------------------------------------------------------------ routing

/** `words` are the positionals after `mcp`, those after `--` included. */
export const mcpCommand = (words: readonly string[], options: Options, io: Io): Command | CliError => {
  const [sub, id] = words;
  const extra = (count: number) => (words.length > count ? usage(`Unexpected argument "${words[count]}"`) : undefined);
  const needsId = () => (id === undefined ? usage(`mcp ${sub} needs a server id`) : undefined);
  switch (sub) {
    case undefined:
    case "list":
      return extra(sub === undefined ? 0 : 1) ?? (({ rpc }) => Effect.map(listServers(rpc), (servers) => ({ json: servers, text: formatMcpServers(servers) })));
    case "show":
      return needsId() ?? extra(2) ?? showCommand(id!);
    case "add":
      return addCommand(words.slice(1), options, io);
    case "remove":
      return needsId() ?? extra(2) ?? act(id!, (rpc) => rpc.Mcp.Remove({ id: id! }), "removed", "removed");
    case "restart":
      return needsId() ?? extra(2) ?? act(id!, (rpc) => rpc.Mcp.Restart({ id: id! }), "restarted", "restarted");
    case "logout":
      return needsId() ?? extra(2) ?? act(id!, (rpc) => rpc.Mcp.Logout({ id: id! }), "signed out of", "signedOut");
    case "login":
      return needsId() ?? extra(2) ?? loginCommand(id!);
    case "logs":
      return needsId() ?? extra(2) ?? logsCommand(id!);
    default:
      return usage(`Unknown mcp command "${sub}"`);
  }
};
