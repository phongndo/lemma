import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Effect, Schema } from "effect";
import { definePlugin } from "@lemma/core/plain";
import { PromptSections } from "@lemma/agent";
import { ToolResult, Tools } from "@lemma/tools";
import { resolveToCwd } from "@lemma/tools/files";

/**
 * Writing: drafts held to the project's style guide. The guide (`STYLE.md` in the session's directory) is a section of
 * the system prompt, and the `draft_stats` tool measures a draft (words, sentences and their average length, the
 * longest, paragraphs, minutes to read), so the agent checks a draft against the guide's limits instead of guessing.
 * Its package brings the `writing` mode (`"resources"` in its manifest).
 *
 * A folder plugin, written the way a user writes one: link or copy the folder into `~/.lemma/plugins/`. It imports
 * only packages the host supplies, and is written with promises (`@lemma/core/plain`).
 */

const Config = Schema.Struct({
  guide: Schema.String.pipe(Schema.withDecodingDefaultType(Effect.sync(() => "STYLE.md"))).annotate({
    title: "Style guide",
    description: "The style guide's file, relative to the session's directory.",
  }),
});

export interface Stats {
  readonly words: number;
  readonly sentences: number;
  readonly paragraphs: number;
  readonly averageSentence: number;
  readonly longest: readonly string[];
  readonly minutes: number;
}

/** The prose of a Markdown draft: no code blocks, headings, or link targets. */
const prose = (text: string): string =>
  text
    .replace(/\r\n/g, "\n")
    .replace(/```[\s\S]*?```/g, "")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n")
    .replace(/\]\([^)]*\)/g, "]");

/** What a draft measures: sentences end at `.`, `!`, or `?` and at a paragraph's end; reading is 230 words a minute. */
export const measure = (text: string): Stats => {
  const paragraphs = prose(text)
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph !== "");
  const sentences = paragraphs.flatMap((paragraph) =>
    paragraph
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence !== ""),
  );
  const words = (sentence: string) => sentence.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
  const total = sentences.reduce((sum, sentence) => sum + words(sentence), 0);
  return {
    words: total,
    sentences: sentences.length,
    paragraphs: paragraphs.length,
    averageSentence: sentences.length === 0 ? 0 : Math.round((total / sentences.length) * 10) / 10,
    longest: [...sentences].sort((a, b) => words(b) - words(a)).slice(0, 3),
    minutes: Math.max(1, Math.round(total / 230)),
  };
};

/** The stats as the model reads them. */
export const report = (stats: Stats): string =>
  [
    `${stats.words} words in ${stats.sentences} sentences and ${stats.paragraphs} paragraphs; ${stats.averageSentence} words a sentence on average; about ${stats.minutes} min to read.`,
    ...(stats.longest.length === 0 ? [] : ["Longest sentences:", ...stats.longest.map((sentence) => `- ${sentence}`)]),
  ].join("\n");

export default definePlugin({
  id: "writing",
  version: "0.1.0",
  uses: ["lemma/agent@2", "lemma/tools@2"],
  config: Config,
  setup: (_deps, { add, config }) => {
    add(Tools, {
      name: "draft_stats",
      description: "Measures a draft (Markdown or plain text): words, sentences, their average length, the longest, paragraphs, and minutes to read.",
      input: Schema.Struct({ path: Schema.String.annotate({ description: "The draft's file" }) }),
      execute: async ({ path: file }, { cwd }) =>
        new ToolResult({ content: [{ type: "text", text: report(measure(await fs.readFile(resolveToCwd(file, cwd), "utf8"))) }] }),
    });

    // Early in the system prompt, after the mode (100) and before the project's instructions (500): it changes
    // only when the guide does.
    add(
      PromptSections,
      {
        id: "style-guide",
        text: async ({ cwd }) => {
          const guide = await fs.readFile(path.resolve(cwd, config.guide), "utf8").catch(() => undefined);
          return guide === undefined || guide.trim() === ""
            ? undefined
            : `The project's style guide (${config.guide}); follow it in what you write:\n\n${guide.trim()}`;
        },
      },
      { order: 400 },
    );
  },
});
