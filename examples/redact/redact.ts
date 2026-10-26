import { Effect, Schema } from "effect";
import { definePlugin } from "@lemma/core/plain";
import { ToolExecuteHook, ToolResult } from "@lemma/tools";

/**
 * Keeps secrets a tool came across out of what the model reads: around every tool call (`ToolExecuteHook`), after the
 * tool has run, each match of a secret's pattern in its result becomes `[redacted]`. That covers the text the model
 * reads, what a script's call resolves to (`structured`), and what the transcript shows (`details`), since all three
 * are logged.
 *
 * A plugin file, written the way a user writes one: copy or link it into `~/.lemma/plugins/`. It imports only packages
 * the host supplies, and is written with promises (`@lemma/core/plain`).
 */

/** The shapes of common secrets: cloud and API keys, tokens, and private keys. */
export const SECRETS: readonly RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const Config = Schema.Struct({
  patterns: Schema.Array(Schema.String)
    .pipe(Schema.withDecodingDefaultType(Effect.sync((): readonly string[] => [])))
    .annotate({
      title: "More secrets",
      description: "Regular expressions for secrets of your own, beside the common ones; each match is redacted.",
    }),
});

/** `text` with every match of `patterns` redacted. */
export const redactText = (text: string, patterns: readonly RegExp[]): string => patterns.reduce((kept, pattern) => kept.replace(pattern, "[redacted]"), text);

/** `value` with every string in it redacted, however deep. */
const redactValue = (value: unknown, patterns: readonly RegExp[]): unknown => {
  if (typeof value === "string") return redactText(value, patterns);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, patterns));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, patterns)]));
  }
  return value;
};

/** `result` with its secrets redacted: its text, what a script sees of it, and what the transcript shows. */
export const redact = (result: ToolResult, patterns: readonly RegExp[]): ToolResult =>
  new ToolResult({
    ...result,
    content: result.content.map((part) => (part.type === "text" ? { ...part, text: redactText(part.text, patterns) } : part)),
    ...(result.structured === undefined ? {} : { structured: redactValue(result.structured, patterns) }),
    ...(result.details === undefined ? {} : { details: redactValue(result.details, patterns) }),
  });

export default definePlugin({
  id: "redact",
  version: "0.1.0",
  uses: ["lemma/tools@2"],
  config: Config,
  setup: (_deps, { config, on }) => {
    const patterns = [...SECRETS, ...config.patterns.map((source) => new RegExp(source, "g"))];
    on(ToolExecuteHook, async (call, next) => redact(await next(call), patterns));
  },
});
