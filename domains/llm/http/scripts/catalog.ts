/**
 * Writes `src/catalog.json`: each built-in provider's models as models.dev lists them now, the catalog this version
 * serves before it reads models.dev itself (and serves offline, or with `liveCatalogs: false`). And `src/nonchat.json`:
 * OpenRouter's classifier and image models, from its list. Run it to refresh the snapshots, then `pnpm format`:
 *
 *   node domains/llm/http/scripts/catalog.ts
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { catalogOf, fetchJson, MODELS_DEV, MUST_THINK_LISTS, mustThinkOf, OPENROUTER_ALL, openrouterNonchat } from "../src/catalog.ts";
import type { DevCatalog } from "../src/catalog.ts";
import { ENDPOINTS } from "../src/endpoints.ts";

const response = await fetch(MODELS_DEV);
if (!response.ok) throw new Error(`${MODELS_DEV}: HTTP ${response.status}`);
const dev = (await response.json()) as DevCatalog;
const catalog = Object.fromEntries(
  await Promise.all(
    // A provider of classifiers alone has no chat models to list.
    ENDPOINTS.filter((endpoint) => Object.keys(endpoint.apis).length > 0).map(async (endpoint) => {
      const listing = dev[endpoint.catalog ?? endpoint.id];
      if (listing === undefined) throw new Error(`models.dev lists no provider "${endpoint.catalog ?? endpoint.id}"`);
      const list = MUST_THINK_LISTS[endpoint.id];
      const mustThink = list === undefined ? undefined : mustThinkOf(await fetchJson(fetch, list, {}, new AbortController().signal));
      if (list !== undefined && mustThink === undefined) throw new Error(`${list}: not a list of models`);
      return [endpoint.id, catalogOf(endpoint, listing, mustThink)] as const;
    }),
  ),
);
const path = fileURLToPath(new URL("../src/catalog.json", import.meta.url));
writeFileSync(path, `${JSON.stringify(catalog, null, 2)}\n`);
const openrouter = openrouterNonchat(await fetchJson(fetch, OPENROUTER_ALL, {}, new AbortController().signal));
if (openrouter === undefined) throw new Error(`${OPENROUTER_ALL}: not a list of models`);
writeFileSync(fileURLToPath(new URL("../src/nonchat.json", import.meta.url)), `${JSON.stringify({ openrouter }, null, 2)}\n`);
console.log(
  [
    ...Object.entries(catalog).map(([id, models]) => `${id}: ${models.length}`),
    `openrouter: ${openrouter.classifiers.length} classifiers, ${openrouter.images.length} image models`,
  ].join(", "),
);
