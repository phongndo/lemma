import * as os from "node:os";
import type { PromptContent, SystemSection } from "@lemma/contracts";

/**
 * The default base prompt, after pi's: an identity line and guidelines for the
 * tools that are actually registered, so replacing or removing a builtin tool
 * does not leave stale advice behind.
 */
function basePrompt(toolNames: ReadonlySet<string>): string {
  const rules: string[] = [];
  if (toolNames.has("bash") && !toolNames.has("grep") && !toolNames.has("find") && !toolNames.has("ls")) {
    rules.push("Use bash for file operations like ls, rg, find");
  }
  if (toolNames.has("read")) rules.push("Use read to examine files instead of cat or sed.");
  if (toolNames.has("edit")) {
    rules.push(
      "Use edit for precise changes (edits[].oldText must match exactly)",
      "When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
      "Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
      "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
    );
  }
  if (toolNames.has("write")) rules.push("Use write only for new files or complete rewrites.");
  rules.push("Be concise in your responses", "Show file paths clearly when working with files");
  return [
    "You are an expert coding assistant operating inside Lemma, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.",
    `Guidelines:\n${rules.map((rule) => `- ${rule}`).join("\n")}`,
  ].join("\n\n");
}

interface EnvironmentFacts {
  readonly cwd: string;
  /** The session this turn belongs to, so the agent can inspect its own log. */
  readonly sessionId: string;
  /** How to run the `lemma` CLI from a shell, when the host app knows. */
  readonly cli?: string;
}

/**
 * Where and when the agent runs, and how it can inspect itself. The date has
 * day precision and the session id is fixed per session, so the system prompt
 * (and with it the provider's prompt cache) stays stable within a session and day.
 */
export function environment(facts: EnvironmentFacts, now: Date = new Date()): string {
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return [
    "<environment>",
    `Current working directory: ${facts.cwd}`,
    `Current date: ${date}`,
    `Platform: ${os.platform()} (${os.arch()})`,
    `Lemma session: ${facts.sessionId}`,
    ...(facts.cli === undefined
      ? []
      : [
          `Lemma CLI: \`${facts.cli}\` inspects and changes the host you run in: \`status\`, \`plugins\` (\`plugins enable|disable <id>\` turns one on or off; \`reload\` applies config edits), \`session show <id>\`, \`inspect <session> --filter "is:error tool:bash turn:2"\`, and \`inspect <session> --request last\` (add \`--system\`, \`--tools\`, \`--diff\`, or \`--rebuilt\` to see exactly what you were sent and which plugin contributed each part). Add \`--json\` for structured output; \`--help\` lists the rest.`,
        ]),
    "</environment>",
  ].join("\n");
}

export const baseSection = (source: string, toolNames: ReadonlySet<string>, override?: string): SystemSection => ({
  id: "base",
  source,
  text: override ?? basePrompt(toolNames),
});

export const environmentSection = (source: string, facts: EnvironmentFacts): SystemSection => ({ id: "environment", source, text: environment(facts) });

const TITLE_CHARS = 60;

/** A session title from the first prompt: its text, whitespace collapsed, cut at a word near 60 characters. */
export function titleFrom(content: PromptContent): string | undefined {
  const text = content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") return undefined;
  if (text.length <= TITLE_CHARS) return text;
  const cut = text.slice(0, TITLE_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${space > TITLE_CHARS / 2 ? cut.slice(0, space) : cut}…`;
}
