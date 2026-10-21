import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** What the browser brought back to the callback, and how to answer it once the sign-in is done with. */
export interface Arrival {
  readonly params: URLSearchParams;
  /** Shows the browser how the sign-in ended: `undefined` for signed in, else why it failed. */
  readonly answer: (failure: string | undefined) => void;
}

/** A listener for the browser coming back from an authorization server, on this machine. */
export interface Callback {
  /** `http://localhost:<port>/callback`, the address the authorization server sends the browser to. */
  readonly redirectUrl: string;
  /** The first request to `/callback`. */
  readonly arrived: Promise<Arrival>;
  /** Stops listening, the same promise every call: it settles once the port is free. */
  readonly close: () => Promise<void>;
}

const escape = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const page = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title>` +
  `<body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem">` +
  `<h1 style="font-size:1.25rem">${escape(title)}</h1><p>${escape(text)}</p></body>`;

const send = (response: ServerResponse, status: number, html: string) => {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(html);
};

const listen = (server: Server, port: number, host: string) =>
  new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });

/** Stops listening once each answered page has gone out: idle connections now, any other after a second. */
const closeServer = (server: Server) =>
  new Promise<void>((resolve) => {
    if (!server.listening) return resolve();
    const force = setTimeout(() => server.closeAllConnections(), 1000);
    server.close(() => {
      clearTimeout(force);
      resolve();
    });
    server.closeIdleConnections();
  });

/**
 * Listens on `port` (`0`: any free one) for the browser coming back, on both loopback addresses `localhost` may be:
 * IPv4 first, which must be free, and IPv6 at the same port when this machine has it. The first request to
 * `/callback` that brings the sign-in's `state` is the sign-in's, held open until `answer` says how it ended; one
 * without it (another sign-in's tab, another program) is turned away and the listener waits on, and one after it is
 * told the sign-in was handled. Closing waits until the port is free again.
 */
export async function listenForCallback(port: number, server: string, state: string): Promise<Callback> {
  let arrive!: (arrival: Arrival) => void;
  const arrived = new Promise<Arrival>((resolve) => (arrive = resolve));
  let taken = false;
  /** The sign-in's request, until it is answered. */
  let held: ServerResponse | undefined;
  const handle = (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/callback") return send(response, 404, page("Not found", "This address only takes a sign-in coming back to Lemma."));
    if (taken) return send(response, 200, page("Already handled", "This sign-in has come back to Lemma already. You can close this tab."));
    if (url.searchParams.get("state") !== state)
      return send(
        response,
        400,
        page("Not this sign-in", "Lemma is waiting on another sign-in than the one this page comes from. Go back to Lemma to see how it stands."),
      );
    taken = true;
    held = response;
    arrive({
      params: url.searchParams,
      answer: (failure) => {
        if (held !== response) return;
        held = undefined;
        if (failure === undefined)
          send(response, 200, page(`Signed in to ${server}`, "Lemma is connecting to it. You can close this tab and go back to Lemma."));
        else send(response, 400, page(`Could not sign in to ${server}`, `${failure} Go back to Lemma to try again.`));
      },
    });
  };
  const v4 = createServer(handle);
  const bound = await listen(v4, port, "127.0.0.1");
  const v6 = createServer(handle);
  // A machine without IPv6, or with the port taken there, still has the IPv4 listener `localhost` reaches.
  await listen(v6, bound, "::1").catch(() => {});
  let closing: Promise<void> | undefined;
  return {
    redirectUrl: `http://localhost:${bound}/callback`,
    arrived,
    close: () =>
      (closing ??= (async () => {
        // A browser that came back after the sign-in ended another way (a paste, a cancel) is told so.
        if (held !== undefined) send(held, 410, page("This sign-in has ended", "Go back to Lemma to see how it stands."));
        held = undefined;
        taken = true;
        await Promise.all([closeServer(v4), closeServer(v6)]);
      })()),
  };
}
