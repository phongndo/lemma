import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Effect, Schema } from "effect";
import { definePlugin } from "@lemma/core/plain";
import { PromptSections } from "@lemma/agent";
import { ToolResult, Tools } from "@lemma/tools";

/**
 * Research notes: the agent keeps what it finds as Markdown notes in the project (`notes/`, a note a topic), so a
 * session's findings outlast it and the next picks up where it left off. Three tools write, search, and read them, and
 * a section of the system prompt lists the notes there are, so the model knows what it has. Its package brings the
 * `research` mode and the `cite` skill (`"resources"` in its manifest).
 *
 * A folder plugin, written the way a user writes one: link or copy the folder into `~/.lemma/plugins/`. It imports
 * only packages the host supplies, and is written with promises (`@lemma/core/plain`).
 */

const Config = Schema.Struct({
  dir: Schema.String.pipe(Schema.withDecodingDefaultType(Effect.sync(() => "notes"))).annotate({
    title: "Notes folder",
    description: "The folder of notes, relative to the session's directory.",
  }),
});

/** A note's file name from its title: lowercase words joined by `-`. */
export const slug = (title: string): string => {
  const name = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (name === "") throw new Error(`"${title}" has no letters or digits to name a note by`);
  return name;
};

export interface Note {
  readonly name: string;
  readonly title: string;
  readonly text: string;
}

/** The notes in `dir`, by name; a folder that is not there has none. A note's title is its first `# ` line, else its name. */
export const readNotes = async (dir: string): Promise<readonly Note[]> => {
  const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith(".md")).sort();
  return Promise.all(
    names.map(async (file) => {
      const text = await fs.readFile(path.join(dir, file), "utf8");
      const name = file.slice(0, -3);
      return { name, title: /^# (.+)$/m.exec(text)?.[1]?.trim() ?? name, text };
    }),
  );
};

/** The lines of `notes` that hold `query`, any case, as `name:line: text`, the first `limit` of them. */
export const search = (notes: readonly Note[], query: string, limit = 50): readonly string[] => {
  const wanted = query.toLowerCase();
  const hits: string[] = [];
  for (const note of notes) {
    note.text.split("\n").forEach((line, index) => {
      if (hits.length < limit && line.toLowerCase().includes(wanted)) hits.push(`${note.name}:${index + 1}: ${line.trim()}`);
    });
  }
  return hits;
};

/** What the model is told of the notes there are, or nothing when there are none. */
export const section = (notes: readonly Note[]): string | undefined =>
  notes.length === 0
    ? undefined
    : [
        "Your research notes (read one with note_read, search them with note_search):",
        ...notes.slice(0, 100).map((note) => `- ${note.name}: ${note.title}`),
      ].join("\n");

const text = (value: string) => new ToolResult({ content: [{ type: "text", text: value }] });

export default definePlugin({
  id: "notes",
  version: "0.1.0",
  uses: ["lemma/agent@2", "lemma/tools@2"],
  config: Config,
  setup: (_deps, { add, config }) => {
    const folder = (cwd: string) => path.resolve(cwd, config.dir);

    add(Tools, {
      name: "note_write",
      description: "Writes a research note: appends to the note of that title, or starts it. Keep a note a topic, each finding with its source.",
      input: Schema.Struct({
        title: Schema.String.annotate({ description: "The note's title; the same title adds to the same note" }),
        text: Schema.String.annotate({ description: "Markdown to add" }),
        replace: Schema.optional(Schema.Boolean).annotate({ description: "Replace the note's text rather than add to it" }),
      }),
      execute: async ({ title, text: added, replace }, { cwd }) => {
        const file = path.join(folder(cwd), `${slug(title)}.md`);
        const before = replace === true ? undefined : await fs.readFile(file, "utf8").catch(() => undefined);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, before === undefined ? `# ${title.trim()}\n\n${added.trim()}\n` : `${before.trimEnd()}\n\n${added.trim()}\n`);
        return text(`${before === undefined ? "Wrote" : "Added to"} ${path.relative(cwd, file)}`);
      },
    });

    add(Tools, {
      name: "note_search",
      description: "Searches the research notes for text, any case: each line that holds it, with its note and line.",
      input: Schema.Struct({ query: Schema.String.annotate({ description: "The text to look for" }) }),
      execute: async ({ query }, { cwd }) => {
        const hits = search(await readNotes(folder(cwd)), query);
        return text(hits.length === 0 ? `No note mentions "${query}"` : hits.join("\n"));
      },
    });

    add(Tools, {
      name: "note_read",
      description: "Reads a research note in full.",
      input: Schema.Struct({ title: Schema.String.annotate({ description: "The note's title or name" }) }),
      execute: async ({ title }, { cwd }) => text(await fs.readFile(path.join(folder(cwd), `${slug(title)}.md`), "utf8")),
    });

    // Near the end of the system prompt, after the project's instructions (500) and skills (600): a new note changes
    // only what comes after it.
    add(PromptSections, { id: "notes", text: async ({ cwd }) => section(await readNotes(folder(cwd))) }, { order: 700 });
  },
});
