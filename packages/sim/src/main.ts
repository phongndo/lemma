// `pnpm sim`: runs the harness simulation for a seed, printing the seed first, so a failure always says how to replay it.
//   pnpm sim [--seed <n>]
process.env.TZ = "UTC";

import { parseArgs } from "node:util";
import { digestRun } from "./run.ts";

const { values } = parseArgs({ options: { seed: { type: "string" }, digest: { type: "boolean" } } });
const seed = values.seed === undefined ? Math.floor(Math.random() * 2 ** 31) : Number(values.seed);
if (!Number.isInteger(seed)) throw new Error("--seed must be an integer");
console.log(`seed ${seed}`);
const digest = await digestRun(seed);
console.log(values.digest === true ? digest : `ok: disk ${digest.slice(0, 16)}`);
