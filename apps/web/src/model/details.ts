import { Predicate } from "effect";
/**
 * Tool `details` are plugin-defined UI data. These readers accept the shapes
 * the built-in tools are expected to produce (pi-style) and ignore the rest.
 */

interface ToolDetails {
  /** Unified diff (edit/write). */
  readonly diff?: string;
  readonly exitCode?: number;
  /** Output was cut; `fullOutputPath` holds the rest when given. */
  readonly truncated?: boolean;
  readonly fullOutputPath?: string;
}

export const readDetails = (details: unknown): ToolDetails => {
  if (!Predicate.isRecord(details)) return {};
  const diff = typeof details.diff === "string" ? details.diff : typeof details.patch === "string" ? details.patch : undefined;
  const exit = details.exitCode ?? details.exit_code ?? details.code;
  const truncation = details.truncation;
  const truncated = details.truncated === true || (Predicate.isRecord(truncation) && truncation.truncated !== false);
  const fullOutputPath = typeof details.fullOutputPath === "string" ? details.fullOutputPath : undefined;
  return {
    ...(diff === undefined || diff === "" ? {} : { diff }),
    ...(typeof exit === "number" ? { exitCode: exit } : {}),
    ...(truncated ? { truncated } : {}),
    ...(fullOutputPath === undefined ? {} : { fullOutputPath }),
  };
};

type DiffLine = { readonly kind: "add" | "del" | "ctx" | "hunk" | "meta"; readonly text: string };

export const parseDiff = (diff: string): DiffLine[] =>
  diff
    .replace(/\n$/, "")
    .split("\n")
    .map((text): DiffLine => {
      if (text.startsWith("+++") || text.startsWith("---") || text.startsWith("diff ") || text.startsWith("index ")) return { kind: "meta", text };
      if (text.startsWith("@@")) return { kind: "hunk", text };
      if (text.startsWith("+")) return { kind: "add", text };
      if (text.startsWith("-")) return { kind: "del", text };
      return { kind: "ctx", text };
    });

export const diffStats = (lines: readonly DiffLine[]): { readonly added: number; readonly removed: number } => ({
  added: lines.filter((line) => line.kind === "add").length,
  removed: lines.filter((line) => line.kind === "del").length,
});
