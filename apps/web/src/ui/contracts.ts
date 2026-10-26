import * as actions from "@lemma/actions";
import * as commands from "@lemma/commands/web";
import * as credentials from "@lemma/credentials/web";
import * as devtools from "@lemma/devtools/web";
import * as frame from "@lemma/frame";
import * as llm from "@lemma/llm/web";
import * as look from "@lemma/look";
import { customEvents, lastPromptText, latestDetails, modelEntries, NewThreadRoute, ThreadRoute } from "@lemma/sessions";
import * as settings from "@lemma/settings";
import * as threads from "@lemma/threads";
import * as webRuntime from "@lemma/web";
import * as workspace from "@lemma/workspace/web";

/** `value` without `keys`, typed so. */
const omit = <T extends object, K extends keyof T>(value: T, keys: readonly K[]): Omit<T, K> =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !(keys as readonly PropertyKey[]).includes(key))) as Omit<T, K>;

/**
 * Every contract a web half receives, by the module a bundled plugin imports it from: the web runtime's (`@lemma/web`:
 * `Client`, `Slots`, `Router`, …), each domain's web contract (`@lemma/frame`, `@lemma/threads`, `@lemma/llm/web`, …),
 * with the views that draw each part, and the thread routes and log readers (`@lemma/sessions`: `latestDetails`, …). The one list: `contracts` merges it
 * for `api.contracts` (`ui/api.ts`), and `WebPlugins.contracts` hands it to the plugins that show it (the devtools).
 * Not what makes slots and parts: a web half makes those with `api.defineSlot` and `api.definePart`, which gives a part
 * no fallback, since a fallback belongs to no plugin and outlives the half. `tests/api.test.ts` fails when a web
 * contract the bundled plugins import is missing.
 */
export const contractModules = {
  "@lemma/web": omit(webRuntime, ["definePart", "createSlots"]),
  "@lemma/frame": frame,
  "@lemma/look": look,
  "@lemma/settings": settings,
  "@lemma/actions": actions,
  "@lemma/devtools/web": devtools,
  "@lemma/threads": threads,
  "@lemma/llm/web": llm,
  "@lemma/workspace/web": workspace,
  "@lemma/commands/web": commands,
  "@lemma/credentials/web": credentials,
  "@lemma/sessions": { NewThreadRoute, ThreadRoute, latestDetails, customEvents, lastPromptText, modelEntries },
};

type Modules = typeof contractModules;
/** One namespace of every module's exports, typed as each module's together. */
type Merged = { [M in keyof Modules]: (exports: Modules[M]) => void }[keyof Modules] extends (exports: infer All) => void ? All : never;
// One namespace of them all: a name two of them export would be one's, silently (the UI check's rail lane fails that).
export const contracts = Object.assign({}, ...Object.values(contractModules)) as Merged;
