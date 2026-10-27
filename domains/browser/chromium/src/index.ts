import { Effect, Schema } from "effect";
import { definePlugin } from "@lemma/core";
import { Inspectors } from "@lemma/contracts";
import { Browser, BROWSER_CONTRACT } from "@lemma/browser";
import { makeChromium } from "./chromium.ts";

export { makeChromium } from "./chromium.ts";
export type { ChromiumOptions } from "./chromium.ts";
export { CHROMIUM_NAMES, findChromium, isExecutableFile } from "./executable.ts";
export type { ChromiumLookup, ChromiumSource } from "./executable.ts";

const ChromiumConfig = Schema.Struct({
  executablePath: Schema.optional(Schema.String).annotate({
    title: "Chromium",
    description:
      "The Chromium or Chrome executable to launch. Without it: LEMMA_CHROMIUM, then chromium or google-chrome on PATH, then Playwright's own download.",
  }),
  idleSeconds: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 300)))
    .annotate({
      title: "Close when idle after",
      description: "Seconds after a session's last call that its tabs close, and after the last call of all that the browser does. 0: they stay open.",
    }),
  headless: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.sync(() => true))).annotate({
    title: "Headless",
    description: "Run without a window. Off: the browser's windows show on this machine's screen, to watch the agent work.",
  }),
});

/** Provides `Browser` over a Chromium launched on first use, with a profile of its own per session. */
export default definePlugin({
  id: "browser.chromium",
  implements: [BROWSER_CONTRACT],
  uses: ["lemma/tools@2"],
  version: "0.1.0",
  config: ChromiumConfig,
  provides: { browser: Browser },
  setup: function* (_, owner) {
    const chromium = makeChromium({
      executablePath: owner.config.executablePath,
      idleMs: owner.config.idleSeconds * 1000,
      headless: owner.config.headless,
    });
    yield* Effect.addFinalizer(() => Effect.promise(chromium.close));
    yield* owner
      .add(Inspectors, {
        id: "browser.chromium",
        title: "Browser",
        description: "The Chromium the agent drives: its executable, whether it runs, and each session's tabs",
        snapshot: chromium.snapshot,
      })
      .pipe(Effect.ignore);
    return { browser: chromium.service };
  },
});
