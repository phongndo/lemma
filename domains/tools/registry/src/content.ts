import { ToolResult } from "@lemma/tools";

/**
 * Bounds the text a result carries into the context window. Text parts are
 * kept in order until the budget is spent; the part that crosses it is cut and
 * marked, later text parts are dropped. Images are kept: they are not text and
 * providers bound them separately.
 */
/** How many characters of text `result` carries. */
export const textLength = (result: ToolResult): number => result.content.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 0), 0);

export function capResult(result: ToolResult, maxChars: number): ToolResult {
  const total = textLength(result);
  if (total <= maxChars) return result;
  const marker = `\n\n[Output truncated: showing ${maxChars} of ${total} characters]`;
  const content: ToolResult["content"][number][] = [];
  let remaining = maxChars;
  for (const part of result.content) {
    if (part.type !== "text") {
      content.push(part);
      continue;
    }
    if (remaining <= 0) continue;
    if (part.text.length <= remaining) {
      content.push(part);
      remaining -= part.text.length;
    } else {
      content.push({ type: "text", text: part.text.slice(0, remaining) + marker });
      remaining = 0;
    }
  }
  return new ToolResult({ ...result, content });
}
