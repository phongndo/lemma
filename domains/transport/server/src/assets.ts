import { stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join, resolve } from "node:path";
import { Effect, Option } from "effect";
import { HttpServerResponse, Mime } from "effect/http";
import type { HttpServerRequest } from "effect/http";
import { isInside } from "@lemma/contracts/fs";

/**
 * The copies of a file the web app's build writes beside it, compressed (`<file>.br`, `<file>.gz`), in the order a
 * client accepting both gets them: brotli's are a sixth smaller, but browsers offer it only over HTTPS.
 */
const ENCODINGS = [
  { encoding: "br", suffix: ".br" },
  { encoding: "gzip", suffix: ".gz" },
] as const;

/** What the build names by its content, under `assets/`: a new build names a changed file anew, so a copy never goes stale. */
const IMMUTABLE = "public, max-age=31536000, immutable";
/** Anything else (`index.html`, which names the build's files): kept, but asked about again each time, and a `304` when unchanged. */
const REVALIDATE = "no-cache";

/** Whether `header` (`Accept-Encoding`) accepts `encoding`: by name, or by `*` when it is not named, with a weight above 0. */
export const accepts = (header: string | undefined, encoding: string): boolean => {
  let any = false;
  for (const member of (header ?? "").split(",")) {
    const [name, ...params] = member.split(";").map((part) => part.trim().toLowerCase());
    const weight = params.find((param) => param.startsWith("q="));
    const positive = weight === undefined || Number(weight.slice(2)) > 0;
    if (name === encoding) return positive;
    if (name === "*") any = positive;
  }
  return any;
};

const fileAt = (path: string): Effect.Effect<Stats | undefined> =>
  Effect.promise(() =>
    stat(path).then(
      (info) => (info.isFile() ? info : undefined),
      () => undefined,
    ),
  );

/** The file to send for `file`: its compressed copy for the first encoding `header` accepts, when there is one no older than it. */
const representation = (file: string, modified: number, header: string | undefined) =>
  Effect.gen(function* () {
    for (const { encoding, suffix } of ENCODINGS) {
      if (!accepts(header, encoding)) continue;
      const copy = yield* fileAt(`${file}${suffix}`);
      if (copy !== undefined && copy.mtimeMs >= modified) return { path: `${file}${suffix}`, encoding };
    }
    return { path: file, encoding: undefined };
  });

const opaque = (tag: string) => tag.trim().replace(/^W\//i, "");

/** Whether the client holds what `headers` describe: its `If-None-Match` names the tag, or, without one, `If-Modified-Since` is no older. */
const unchanged = (request: HttpServerRequest.HttpServerRequest, headers: Readonly<Record<string, string>>): boolean => {
  const tags = request.headers["if-none-match"];
  const etag = headers["etag"];
  if (tags !== undefined) return etag !== undefined && tags.split(",").some((tag) => tag.trim() === "*" || opaque(tag) === opaque(etag));
  const since = Date.parse(request.headers["if-modified-since"] ?? "");
  const modified = Date.parse(headers["last-modified"] ?? "");
  return !Number.isNaN(since) && !Number.isNaN(modified) && modified <= since;
};

/** What a `304` repeats of the response it stands for (RFC 9110 §15.4.5). */
const KEPT = ["etag", "last-modified", "cache-control", "vary"] as const;

/** `file` (found at `info`), compressed as `request` accepts, with the caching `root` gives it, or `304` when the client holds it. */
const send = (request: HttpServerRequest.HttpServerRequest, root: string, file: string, info: Stats) =>
  Effect.gen(function* () {
    const chosen = yield* representation(file, info.mtimeMs, request.headers["accept-encoding"]);
    const response = yield* HttpServerResponse.file(chosen.path, {
      contentType: Option.getOrElse(Mime.getType(file), () => "application/octet-stream"),
      headers: {
        "cache-control": isInside(join(root, "assets"), file) ? IMMUTABLE : REVALIDATE,
        vary: "accept-encoding",
        ...(chosen.encoding === undefined ? {} : { "content-encoding": chosen.encoding }),
      },
    });
    if (!unchanged(request, response.headers)) return response;
    const headers: Record<string, string> = {};
    for (const name of KEPT) if (response.headers[name] !== undefined) headers[name] = response.headers[name];
    return HttpServerResponse.empty({ status: 304, headers });
  });

/**
 * A built web app: existing files are served as they are, or as the copy the build compressed beside them that the
 * request accepts; other extensionless GET paths fall back to `index.html` for client-side routing. Paths cannot
 * escape `root`. What is under `assets/` is cached for a year (the build names it by its content), anything else
 * revalidated by its `ETag` or date.
 */
export const serveStatic = (request: HttpServerRequest.HttpServerRequest, root: string, pathname: string) =>
  Effect.gen(function* () {
    const notFound = HttpServerResponse.text("Not found", { status: 404 });
    const decoded = yield* Effect.try(() => decodeURIComponent(pathname)).pipe(Effect.orElseSucceed(() => undefined));
    if (decoded === undefined || decoded.includes("\0")) return notFound;
    const target = resolve(root, `.${decoded}`);
    if (!isInside(root, target)) return notFound;
    const found = yield* fileAt(target);
    if (found !== undefined) return yield* send(request, root, target, found);
    const last = decoded.slice(decoded.lastIndexOf("/") + 1);
    const index = join(root, "index.html");
    const page = last.includes(".") ? undefined : yield* fileAt(index);
    return page === undefined ? notFound : yield* send(request, root, index, page);
  }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.text("Cannot read file", { status: 500 }))));
