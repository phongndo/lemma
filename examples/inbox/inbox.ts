import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Effect, Schema } from "effect";
import { definePlugin } from "@lemma/core/plain";
import { AgentRequestHook } from "@lemma/agent";
import { customEvents, deriveMessages } from "@lemma/sessions";
import type { SessionEvent } from "@lemma/sessions";
import { ToolResult, Tools } from "@lemma/tools";

/**
 * Inbox triage: messages arrive as files in a folder of the project (`inbox/`, a message a file: header lines, a blank
 * line, then the body, as an email is), and the agent sorts them. What is new reaches the model as a `context` event,
 * appended before the request that follows its arrival: the log keeps what the model was shown and when, the
 * transcript shows it where it happened, and the request still rebuilds from the log. A branch shows each message
 * once: a `custom` event records which it showed (`customEvents`). Two tools read a message in full and file it in a
 * folder; the `triage` profile its package brings (`"resources": { "profiles": "./profiles" }`) narrows the agent to
 * them.
 *
 * A folder plugin, written the way a user writes one: link or copy the folder into `~/.lemma/plugins/`. It imports
 * only packages the host supplies, and is written with promises (`@lemma/core/plain`).
 */

const Config = Schema.Struct({
  dir: Schema.String.pipe(Schema.withDecodingDefaultType(Effect.sync(() => "inbox"))).annotate({
    title: "Inbox folder",
    description: "The folder of messages, relative to the session's directory.",
  }),
});

/** The `custom` event kind recording the messages a branch has shown the model. */
export const SHOWN = "inbox.shown";

export interface Message {
  /** Its file's name in the inbox. */
  readonly id: string;
  /** Its header lines (`From: …`) up to the first that is none, by lowercased name. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const MESSAGE_FILE = /\.(md|txt|eml)$/;

/** A message file's headers and body. */
export const parseMessage = (id: string, text: string): Message => {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const headers: Record<string, string> = {};
  let at = 0;
  for (; at < lines.length; at++) {
    const header = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[at]!);
    if (header === null) break;
    headers[header[1]!.toLowerCase()] = header[2]!.trim();
  }
  return {
    id,
    headers,
    body: lines
      .slice(lines[at] === "" ? at + 1 : at)
      .join("\n")
      .trim(),
  };
};

/** The messages in `dir`, by name; a folder that is not there has none, and its subfolders (where filed ones go) are skipped. */
export const readInbox = async (dir: string): Promise<readonly Message[]> => {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const names = entries.filter((entry) => entry.isFile() && MESSAGE_FILE.test(entry.name)).map((entry) => entry.name);
  return Promise.all(names.sort().map(async (name) => parseMessage(name, await fs.readFile(path.join(dir, name), "utf8"))));
};

/** The messages `branch` has shown the model. */
export const shownOn = (branch: readonly SessionEvent[]): ReadonlySet<string> =>
  new Set(
    customEvents(branch, SHOWN).flatMap((data) => {
      const ids = (data as { readonly ids?: unknown }).ids;
      return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
    }),
  );

const preview = (body: string): string => {
  const lines = body
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(0, 3)
    .join("\n");
  return lines.length > 300 ? `${lines.slice(0, 300)}…` : lines;
};

/** What the model is told of new messages: each one's id, sender, subject, and first lines. */
export const announce = (messages: readonly Message[]): string =>
  [
    `New in the inbox (${messages.length}); read one in full with inbox_read, and file it with inbox_file:`,
    ...messages.map(
      (message) =>
        `<message id="${message.id}" from="${message.headers["from"] ?? "unknown"}" subject="${message.headers["subject"] ?? ""}">\n${preview(message.body)}\n</message>`,
    ),
  ].join("\n");

/** `id` as a message file of the inbox, never a path out of it. */
const messageFile = (dir: string, id: string): string => {
  if (path.basename(id) !== id || !MESSAGE_FILE.test(id)) throw new Error(`"${id}" is not a message's id`);
  return path.join(dir, id);
};

const text = (value: string) => new ToolResult({ content: [{ type: "text", text: value }] });

export default definePlugin({
  id: "inbox",
  version: "0.1.0",
  uses: ["lemma/agent@1", "lemma/sessions@1", "lemma/tools@1"],
  config: Config,
  setup: (_deps, { add, on, run, config }) => {
    const inbox = (cwd: string) => path.resolve(cwd, config.dir);

    // Each request, so a message that arrives during a turn is seen at its next step; in `shape`, so a profile's
    // `select` and compaction's `fit` see the request it is part of.
    on(
      AgentRequestHook,
      async (draft, next) => {
        const shown = shownOn(draft.branch);
        const fresh = (await readInbox(inbox(draft.cwd))).filter((message) => !shown.has(message.id));
        if (fresh.length === 0) return next(draft);
        const appended = [
          await run(
            draft.append({
              type: "context",
              source: "inbox",
              content: [{ type: "text", text: announce(fresh) }],
              display: fresh.length === 1 ? "1 new message" : `${fresh.length} new messages`,
              turnId: draft.turnId,
            }),
          ),
          await run(draft.append({ type: "custom", kind: SHOWN, data: { ids: fresh.map((message) => message.id) } })),
        ];
        // Handed on with what it appended, so the handlers after it size and select the request it is part of.
        const branch = [...draft.branch, ...appended];
        return next({ ...draft, branch, history: deriveMessages(branch) });
      },
      { phase: "shape" },
    );

    add(Tools, {
      name: "inbox_read",
      description: "Reads a message of the inbox in full: its headers and body.",
      input: Schema.Struct({ id: Schema.String.annotate({ description: "The message's id, as it was announced" }) }),
      execute: async ({ id }, { cwd }) => text(await fs.readFile(messageFile(inbox(cwd), id), "utf8")),
    });

    add(Tools, {
      name: "inbox_file",
      description: "Files a message of the inbox in a folder (reply, later, done), moving it out of the inbox.",
      input: Schema.Struct({
        id: Schema.String.annotate({ description: "The message's id, as it was announced" }),
        folder: Schema.String.annotate({ description: "The folder to file it in: reply, later, done, or one the user named" }),
      }),
      execute: async ({ id, folder }, { cwd }) => {
        if (!/^[\w-]+$/.test(folder)) throw new Error(`"${folder}" is not a folder's name: letters, digits, _ and -`);
        const dir = inbox(cwd);
        const from = messageFile(dir, id);
        await fs.mkdir(path.join(dir, folder), { recursive: true });
        await fs.rename(from, path.join(dir, folder, id));
        return text(`Filed ${id} in ${folder}`);
      },
    });
  },
});
