#!/usr/bin/env node
import { enableCompileCache } from "node:module";
import { fileURLToPath } from "node:url";

/**
 * Starts the host (`main.ts`) with Node's compile cache on: most of a start is compiling the ~750 modules it loads and
 * stripping their types, which the cache keeps from one start to the next, each module's checked against its source
 * so an edit (to this checkout, or a plugin file) compiles again. It is this checkout's (`node_modules/.cache`), so every
 * home and shell shares it; `NODE_COMPILE_CACHE` names another directory, and `NODE_DISABLE_COMPILE_CACHE=1` turns it
 * off. It caches only what loads after it is on, so this module imports nothing else first.
 */
enableCompileCache(fileURLToPath(new URL("../node_modules/.cache/compile", import.meta.url)));
await import("./main.ts");
