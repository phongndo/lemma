import { defineConfig } from "vitest/config";

// Solid's browser build: its server build (what Node resolves by default) does not track signals. Inlined, so Vite
// resolves it with these conditions rather than Node.
export default defineConfig({
  resolve: { conditions: ["lemma-source", "browser", "development"] },
  ssr: { resolve: { conditions: ["lemma-source", "browser", "development"], externalConditions: ["browser"] } },
  test: { environment: "node", server: { deps: { inline: ["solid-js"] } } },
});
