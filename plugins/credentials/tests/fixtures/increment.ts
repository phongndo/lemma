// Runs in a separate Node process: increments a counter credential `count` times through the plugin.
import { dirname } from "node:path";
import { Effect } from "effect";
import { Credentials } from "@lemma/contracts";
import { pathsPlugin } from "@lemma/contracts/testing";
import { makeCore } from "@lemma/core";
import credentials from "../../src/index.ts";

const [auth, provider, count] = process.argv.slice(2) as [string, string, string];
const paths = pathsPlugin(dirname(auth), { auth });

await Effect.runPromise(
  Effect.scoped(
    Effect.flatMap(makeCore([paths, credentials]), (core) =>
      core.run(
        Effect.gen(function* () {
          const service = yield* Credentials;
          for (let i = 0; i < Number(count); i++) {
            yield* service.modify(provider, (current) =>
              Effect.succeed({
                type: "api_key" as const,
                key: String(Number(current?.type === "api_key" ? current.key : 0) + 1),
              }),
            );
          }
        }),
      ),
    ),
  ),
);
