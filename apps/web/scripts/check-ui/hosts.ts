import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { startLemma } from "../../../../scripts/e2e.ts";
import type { Mock } from "../../../../scripts/e2e.ts";
import { projectsOf, seedHome } from "./seed.ts";

/*
 * The real hosts the UI check's pages run against: one or more for each lane's try, started from the checkout on a home
 * of its own (seed.ts), with the scripted provider (scripts/mock-openai.ts) as its model. Pages share one dev server,
 * whose `/rpc` and `/api` go to `router`, which sends each page's requests to its host by the cookie `open` gives it,
 * with that host's token.
 */

/** The lane running (check-ui.ts runs each in `inLane`), so that a try's pages and hosts can be set apart. */
const lanes = new AsyncLocalStorage<string>();
export const inLane = <A>(name: string, run: () => Promise<A>): Promise<A> => lanes.run(name, run);
export const laneNow = () => lanes.getStore();

/** The cookie that names a page's host to the router. */
export const HOST_COOKIE = "lemma-check-host";

/** A host the check started, as a lane drives it. */
export interface Host {
  /** Its home (`LEMMA_HOME`), which is its `HOME` too. */
  readonly home: string;
  /** The seeded projects, `~/code/lemma` (a git repository) and `~/code/website`. */
  readonly projects: { readonly lemma: string; readonly website: string };
  /** The scripted provider's base URL, and its controls: gates, and holding answers. */
  readonly provider: string;
  readonly mock: Mock;
  /** What a page's cookie says to reach it. */
  readonly key: string;
  /** Writes plugin files into its plugins directory (`~/.lemma/plugins`, here `<home>/plugins`), by name; null removes one. */
  readonly plugins: (files: Readonly<Record<string, string | null>>) => Promise<void>;
  /** What it and its provider printed. */
  readonly output: () => string;
}

export interface HostOptions {
  /** The seeded threads (`seedThreads`); with false, a home with none. */
  readonly threads?: boolean;
  /** Config rows besides the check's (the scripted provider, titles off), given the provider's base URL. */
  readonly plugins?: (provider: string) => Readonly<Record<string, unknown>>;
  /** Plugin files in its plugins directory when it starts, by name. */
  readonly files?: Readonly<Record<string, string>>;
}

/** The provider the check's hosts use: the scripted one, with a model that reasons, so the composer offers its levels. */
export const scripted = (provider: string, extra: object = {}) => ({
  id: "scripted",
  name: "Scripted",
  api: "openai-completions",
  baseUrl: provider,
  models: [{ id: "scripted", name: "Scripted model", reasoning: true }],
  ...extra,
});

/**
 * What the host's environment keeps of the check's: what runs commands and finds programs. The rest (a provider's key
 * in the shell, `AWS_PROFILE`) would set up a provider the check expects to find none of.
 */
const KEEP = new Set(["PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SYSTEMROOT", "SystemRoot", "COMSPEC", "PATHEXT"]);

interface Target {
  readonly port: number;
  readonly token: string;
}
const targets = new Map<string, Target>();
const targetOf = (headers: IncomingHttpHeaders) => {
  const key = new RegExp(`(?:^|;\\s*)${HOST_COOKIE}=([^;]+)`).exec(headers.cookie ?? "")?.[1];
  return key === undefined ? undefined : targets.get(key);
};
/** The request's headers for its host: its own, with the host's token rather than any it had. */
const headersFor = (raw: readonly string[], target: Target) => {
  const kept: [string, string][] = [];
  for (let at = 0; at < raw.length; at += 2) {
    const name = raw[at]!.toLowerCase();
    if (name !== "authorization" && name !== "host") kept.push([raw[at]!, raw[at + 1]!]);
  }
  return [...kept, ["host", `127.0.0.1:${target.port}`], ["authorization", `Bearer ${target.token}`]] as [string, string][];
};

/** Sends `/rpc` and `/api`, a page's calls and streams, to the host its cookie names. */
const router = createServer((incoming, outgoing) => {
  const target = targetOf(incoming.headers);
  if (target === undefined) return void outgoing.writeHead(502, { "content-type": "text/plain" }).end("This page has no host: open it with open()");
  const upstream = request(
    { host: "127.0.0.1", port: target.port, method: incoming.method, path: incoming.url, headers: Object.fromEntries(headersFor(incoming.rawHeaders, target)) },
    (answer) => {
      outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(outgoing);
    },
  );
  upstream.on("error", () => outgoing.destroy());
  incoming.pipe(upstream);
});
router.on("upgrade", (incoming, socket, head) => {
  const target = targetOf(incoming.headers);
  if (target === undefined) return void socket.destroy();
  const upstream = connect(target.port, "127.0.0.1", () => {
    const lines = headersFor(incoming.rawHeaders, target).map(([name, value]) => `${name}: ${value}`);
    upstream.write(`${incoming.method} ${incoming.url} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
    upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const end = () => {
    socket.destroy();
    upstream.destroy();
  };
  socket.on("error", end).on("close", end);
  upstream.on("error", end).on("close", end);
});
await new Promise<void>((resolve) => router.listen(0, "127.0.0.1", resolve));
/** Where the dev server sends `/rpc` and `/api` (`LEMMA_HOST_URL`). */
export const routerUrl = `http://127.0.0.1:${(router.address() as AddressInfo).port}`;

/** Each lane's hosts, for its try's end to stop. */
const started = new Map<string, { readonly host: Host; readonly stop: () => Promise<void> }[]>();
let made = 0;

/** A host for the lane running, on a seeded home, stopped when the lane's try ends (`stopHosts`). */
export const startHost = async (options: HostOptions = {}): Promise<Host> => {
  const lane = laneNow() ?? "check";
  const lemma = await startLemma(`lemma-ui-${lane}-`, {
    plugins: (provider) => ({
      "llm.pi-ai": { config: { providers: [scripted(provider)] } },
      ...options.plugins?.(provider),
    }),
    env: (home, provider) => ({
      ...Object.fromEntries(Object.keys(process.env).flatMap((name) => (KEEP.has(name) ? [] : [[name, undefined]]))),
      HOME: home,
      // Kimi Code's sign-in, asked of the scripted provider: a device code, never approved.
      KIMI_CODE_OAUTH_HOST: new URL(provider).origin,
    }),
    prepare: async (home) => {
      await seedHome(home, { threads: options.threads ?? true });
      for (const [name, source] of Object.entries(options.files ?? {})) await put(join(home, "plugins", name), source);
    },
  });
  const { url, token } = JSON.parse(await readFile(join(lemma.home, "transport.json"), "utf8")) as { url: string; token: string };
  const key = `${++made}`;
  targets.set(key, { port: Number(new URL(url).port), token });
  const host: Host = {
    home: lemma.home,
    projects: projectsOf(lemma.home),
    provider: lemma.mock.url,
    mock: lemma.mock,
    key,
    plugins: async (files) => {
      for (const [name, source] of Object.entries(files)) {
        const path = join(lemma.home, "plugins", name);
        if (source === null) await rm(path, { recursive: true, force: true });
        else await put(path, source);
      }
    },
    output: lemma.output,
  };
  started.set(lane, [
    ...(started.get(lane) ?? []),
    {
      host,
      stop: async () => {
        targets.delete(key);
        await lemma.stop();
      },
    },
  ]);
  return host;
};

/** Writes `text` to `path`, unless it is there already: a plugin file written again would load again. */
const put = async (path: string, text: string) => {
  if ((await readFile(path, "utf8").catch(() => undefined)) === text) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
};

/** The hosts `lane` started, still running. */
export const hostsOf = (lane: string): readonly Host[] => (started.get(lane) ?? []).map((entry) => entry.host);

/** Stops the hosts `lane` started (every lane's when none is named), and removes their homes. */
export const stopHosts = async (lane?: string) => {
  const stopping = lane === undefined ? [...started.values()].flat() : (started.get(lane) ?? []);
  if (lane === undefined) started.clear();
  else started.delete(lane);
  await Promise.all(stopping.map((entry) => entry.stop()));
};

export const closeRouter = () =>
  new Promise<void>((resolve) => {
    router.close(() => resolve());
    router.closeAllConnections();
  });
