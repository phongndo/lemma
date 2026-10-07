import { Effect, Layer, Schema } from "effect";
import type { Context } from "effect";
import { definePlugin } from "@lemma/core";
import { Tools } from "@lemma/contracts";
import type { Tool } from "@lemma/contracts";
import { DEFAULT_BASH_TIMEOUT, makeBashTool } from "./bash.ts";
import { codemodeTool } from "./codemode.ts";
import { editTool } from "./edit.ts";
import { readTool } from "./read.ts";
import { writeTool } from "./write.ts";

export { bashTool, BashInput, DEFAULT_BASH_TIMEOUT, makeBashTool } from "./bash.ts";
export type { BashDetails } from "./bash.ts";
export { codemodeTool, CodemodeInput } from "./codemode.ts";
export type { CodemodeDetails } from "./codemode.ts";
export { applyEdits, editTool, EditInput } from "./edit.ts";
export type { EditDetails } from "./edit.ts";
export { readTool, ReadInput } from "./read.ts";
export type { ReadDetails } from "./read.ts";
export { writeTool, WriteInput } from "./write.ts";
export { unifiedPatch } from "./diff.ts";
export { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead, truncateTail } from "./truncate.ts";
export { resolveToCwd } from "./files.ts";

/**
 * One plugin per tool, with the tool's name as its id, so a composition can
 * disable or replace one (`bash`, say) without touching the others. A reload
 * swaps in the new tool without a gap: the registry lets a plugin's
 * replacement take over its names. A tool that runs others is built from the
 * registry it registers with.
 */
const toolPlugin = (id: string, tool: Tool<any> | ((registry: Context.Service.Shape<typeof Tools>) => Tool<any>)) =>
  definePlugin({
    id,
    version: "0.1.0",
    requires: { tools: Tools },
    setup: ({ tools }) => tools.register(typeof tool === "function" ? tool(tools) : tool),
  });

export const read = toolPlugin(readTool.name, readTool);
export const write = toolPlugin(writeTool.name, writeTool);
export const edit = toolPlugin(editTool.name, editTool);
const BashConfig = Schema.Struct({
  timeout: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => DEFAULT_BASH_TIMEOUT)))
    .annotate({
      title: "Default timeout",
      description: "Seconds a command may run when the model names no timeout of its own. 0: no limit.",
    }),
});

export const bash = definePlugin({
  id: "bash",
  version: "0.1.0",
  config: BashConfig,
  requires: [Tools],
  layer: (config: typeof BashConfig.Type) => Layer.effectDiscard(Effect.flatMap(Tools, (registry) => registry.register(makeBashTool(config.timeout)))),
});
export const codemode = toolPlugin("codemode", codemodeTool);

/** All five plugins, for compositions that want the standard set. */
export default [read, write, edit, bash, codemode] as const;
