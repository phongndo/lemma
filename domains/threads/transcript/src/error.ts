/**
 * How an error message reads to a person in the chat. Provider errors often
 * carry the response body inline (`request failed (400): {"error": …}. Run
 * /login`): the first JSON object or array in the message is dropped from view,
 * keeping only the human-readable description it holds, with the text before it
 * as the summary and the text after it as a hint.
 */
export interface ErrorView {
  readonly summary: string;
  /** The description the embedded JSON holds (`error_description`, `message`, …); undefined when there is none. */
  readonly description?: string;
  /** What follows the JSON, such as what to do next. */
  readonly hint?: string;
}

/** Keys a response body's human-readable description goes under, most specific first. */
const DESCRIPTION_KEYS = ["error_description", "message", "detail", "description"];

/** The first description in a parsed body, searching nested objects breadth-first. */
const describe = (value: unknown): string | undefined => {
  const queue: unknown[] = [value];
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i];
    if (typeof node !== "object" || node === null) continue;
    if (!Array.isArray(node)) {
      for (const key of DESCRIPTION_KEYS) {
        const text = (node as Record<string, unknown>)[key];
        if (typeof text === "string" && text.trim() !== "") return text.trim();
      }
    }
    queue.push(...Object.values(node));
  }
  return undefined;
};

/** The index just past the bracket that closes the one at `start`, skipping strings; undefined when it never closes. */
const closing = (text: string, start: number): number | undefined => {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === "\\") i++;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return undefined;
};

export function errorView(message: string): ErrorView {
  for (let start = 0; start < message.length; start++) {
    if (message[start] !== "{" && message[start] !== "[") continue;
    const end = closing(message, start);
    if (end === undefined) continue;
    let value: unknown;
    try {
      value = JSON.parse(message.slice(start, end));
    } catch {
      continue;
    }
    // `[]`, `{}`, and `[400]` say nothing worth splitting out.
    if (typeof value !== "object" || value === null || Object.keys(value).length === 0 || (Array.isArray(value) && !value.some((v) => typeof v === "object")))
      continue;
    const summary = message.slice(0, start).trim().replace(/:$/, "").trimEnd();
    const hint = message
      .slice(end)
      .trim()
      .replace(/^[.:;,]\s*/, "");
    const description = describe(value);
    return { summary: summary === "" ? "Error" : summary, ...(description === undefined ? {} : { description }), ...(hint === "" ? {} : { hint }) };
  }
  return { summary: message };
}
