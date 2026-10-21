import { Duration, Effect, Layer, Schema } from "effect";
import { appUrl, HostControl, InteractionHook, Notice, Paths, secret } from "@lemma/contracts";
import { definePlugin, Events, Registries } from "@lemma/core";
import { ChannelLifetime, channelLifetime, ServedRpcs } from "./channels.ts";
import { makeHandlers } from "./handlers.ts";
import { makeHub } from "./hub.ts";
import type { Hub } from "./hub.ts";
import { makeInteractions } from "./interactions.ts";
import { publishDiscovery } from "./discovery.ts";
import { replies, Replies, Serving } from "./replies.ts";
import { startServer } from "./server.ts";
import { Startup, startupGate } from "./startup.ts";
import { loadToken } from "./token.ts";

/** Reported by `Host.Info` and as the plugin version. */
const VERSION = "0.1.0";

const TransportConfig = Schema.Struct({
  host: Schema.String.pipe(Schema.withDecodingDefaultType(Effect.sync(() => "127.0.0.1"))).annotate({
    description: "Loopback by default; set explicitly to expose the host beyond this machine.",
  }),
  port: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 65535 }))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 7433)))
    .annotate({
      description: "0 asks the OS for a free port; the chosen one lands in transport.json.",
    }),
  token: Schema.optional(Schema.NonEmptyString).annotate({
    ...secret,
    description: "When absent, read from <home>/token, which the first start creates with a random token; delete that file to rotate it.",
  }),
  staticDir: Schema.optional(Schema.String).annotate({
    description: "A built web app served at /, with index.html as the fallback for client-side routes.",
  }),
  compression: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.sync(() => true))).annotate({
    description:
      "Compress WebSocket messages and /rpc/http replies of 1 KiB or more for clients that accept it (browsers, Node, and the CLI do): a long thread's log crosses a network in a sixth of its bytes. Off saves the host that CPU when every client is on this machine.",
  }),
  interactionGraceMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 15_000)))
    .annotate({
      description: "How long an open interaction waits for a client that answers questions to (re)connect before failing Unavailable.",
    }),
  startupTimeoutMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 60_000)))
    .annotate({
      description: "How long a request held while the host starts waits for its plugins before failing Unavailable.",
    }),
});
type TransportConfig = typeof TransportConfig.Type;

/** A wildcard bind is reachable locally through loopback; that is what the discovery file should say. */
const clientHost = (hostname: string): string => {
  if (hostname === "0.0.0.0") return "127.0.0.1";
  if (hostname === "::") return "[::1]";
  return hostname.includes(":") ? `[${hostname}]` : hostname;
};

export default definePlugin({
  id: "transport.server",
  version: VERSION,
  config: TransportConfig,
  // The runtime only: a domain serves its own calls and streams as channels, read at each request, so it stops,
  // reloads, or is off without this plugin noticing.
  requires: { paths: Paths, host: HostControl },
  // Owns the listening port: a reload stops this instance before starting its replacement.
  exclusive: true,
  setup: function* (_, owner) {
    const config = owner.config;
    const events = yield* Events;
    const [paths, control] = yield* Effect.all([Paths, HostControl]);
    const registries = yield* Registries;

    let hub: Hub | undefined;
    const interactions = makeInteractions(() => hub!, config.interactionGraceMs);
    hub = yield* makeHub(owner, interactions.open, registries);
    yield* owner.on(InteractionHook, interactions.handle);

    const token = config.token ?? (yield* loadToken(paths.home));
    const startup = yield* startupGate(owner, control.composition, Duration.millis(config.startupTimeoutMs));
    // Each request runs with this item, as the transport's work, until its reply has left (`Replies`).
    yield* owner.add(Serving, "requests");
    const handlers = Layer.mergeAll(
      ServedRpcs.toLayer(makeHandlers({ version: VERSION, hub, interactions, paths, control, registries })),
      Layer.succeed(ChannelLifetime, channelLifetime(registries)),
      Layer.succeed(Startup, startup),
      Layer.succeed(Replies, replies(registries, owner.id)),
    );
    const address = yield* startServer(
      { host: config.host, port: config.port, token, version: VERSION, staticDir: config.staticDir, compression: config.compression, web: control.web },
      handlers,
    );
    const url = `http://${clientHost(address.hostname)}:${address.port}`;
    // Before the composition is up, which waits on this setup: requests for channels and inspectors wait at the startup gate meanwhile.
    yield* publishDiscovery(paths.home, {
      url,
      token,
      pid: process.pid,
      startedAt: Date.now(),
      cwd: paths.cwd,
      host: config.host,
      ...(control.process.startedBy === undefined ? {} : { startedBy: control.process.startedBy }),
      ...(control.process.safe ? { safe: true } : {}),
    });
    yield* events.publish(Notice, {
      level: "info",
      source: owner.id,
      message: `Listening on ${url}`,
      ...(config.staticDir === undefined ? {} : { links: [{ url: appUrl(url, "/", token), label: "Open the web app" }] }),
    });
  },
});
