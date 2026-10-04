import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Data, Effect } from "effect";
import { writeFileAtomic } from "@lemma/contracts/fs";

/** `<home>/token`: the token the host uses when its config sets none. */
export const tokenPath = (home: string): string => join(home, "token");

export class TokenError extends Data.TaggedError("TokenError")<{ readonly message: string }> {}

const errorCode = (cause: unknown) => (cause as NodeJS.ErrnoException).code;
const reason = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** The file's token, or undefined when there is no file. */
const read = async (path: string): Promise<string | undefined> => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return undefined;
    throw new TokenError({ message: `Cannot read the host's token from ${path}: ${reason(cause)}` });
  }
  const token = text.trim();
  if (token === "") throw new TokenError({ message: `${path} is empty; delete it and restart the host to generate a new token` });
  return token;
};

/**
 * The token in `<home>/token`, created with a random one when missing, so
 * remote clients stay valid across host restarts; deleting the file rotates
 * it. The file is complete before it appears (written aside, then linked into
 * place), and a link, unlike a rename, fails when the name exists: of two
 * hosts creating it at once, the second reads the first's.
 */
export const loadToken = (home: string): Effect.Effect<string, TokenError> =>
  Effect.tryPromise({
    try: async () => {
      const path = tokenPath(home);
      const existing = await read(path);
      if (existing !== undefined) return existing;
      const token = randomBytes(24).toString("base64url");
      let created: boolean;
      try {
        created = await writeFileAtomic(path, `${token}\n`, { exclusive: true });
      } catch (cause) {
        throw new TokenError({ message: `Cannot create the host's token file ${path}: ${reason(cause)}` });
      }
      if (created) return token;
      const winner = await read(path);
      if (winner === undefined) throw new TokenError({ message: `${path} disappeared while it was being created; restart the host` });
      return winner;
    },
    catch: (cause) => (cause instanceof TokenError ? cause : new TokenError({ message: reason(cause) })),
  });
