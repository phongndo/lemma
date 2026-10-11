import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

/**
 * `@lemma/ui/vitest`: the config a web plugin's package tests with (its `vitest.config.ts` default-exports it), so its
 * tests compile Solid's JSX and run against Solid's browser build, as the page does.
 */
export default defineConfig({
  plugins: [solid()],
  resolve: { conditions: ["lemma-source", "browser", "development"] },
  ssr: { resolve: { conditions: ["lemma-source", "browser", "development"], externalConditions: ["browser"] } },
  test: { environment: "node", include: ["tests/**/*.test.ts"], server: { deps: { inline: ["solid-js"] } } },
});
