import type { Exposure } from "@lemma/mcp";

/** How a server's tools reach the model, by the names the page and `/mcp` give them. */
export const EXPOSURES: readonly { readonly value: Exposure; readonly label: string }[] = [
  { value: "codemode", label: "Code mode" },
  { value: "direct", label: "Direct" },
  { value: "hidden", label: "Hidden" },
];
export const LABELS = Object.fromEntries(EXPOSURES.map(({ value, label }) => [value, label])) as Readonly<Record<Exposure, string>>;
/** The exposure the file gives a tool by its name, or none of its own (`default`): a pattern's, the plugin's, or the server's. */
export const TOOL_EXPOSURES = [{ value: "default", label: "Default" }, ...EXPOSURES];
