import { Effect, Schema } from "effect";
import type { FileEntry } from "@lemma/contracts";
import { FILE_SEARCH_LIMIT, HostError } from "@lemma/contracts";
import { fileView, mentionPath } from "../model/completion.ts";
import { Client, ComposerCompletions, Slots, Workspace } from "../ui/contracts.ts";
import type { ComposerSuggestion } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import { FileTypeIcon } from "../ui/parts.tsx";

const FileMentionsConfig = Schema.Struct({
  trigger: Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.withDecodingDefaultType(Effect.sync(() => "@"))).annotate({
    title: "Trigger",
    description: "Typed at the start of a word, offers the project's files; picking one writes it after the trigger (@src/app.ts).",
  }),
  limit: Schema.Number.pipe(
    Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: FILE_SEARCH_LIMIT })),
    Schema.withDecodingDefaultType(Effect.sync(() => 50)),
  ).annotate({
    title: "Suggestions",
    description: "At most this many in the menu.",
  }),
  folders: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.sync(() => true))).annotate({
    title: "Offer folders",
    description: "Folders among the files; picking one goes on completing inside it.",
  }),
});

/** Typing waits this long for a pause before asking the host, so a burst of keys sends one search. */
const PAUSE_MS = 80;

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

const suggestion = (entry: FileEntry, query: string, trigger: string): ComposerSuggestion => {
  const view = fileView(entry, query);
  const folder = entry.kind === "directory";
  // A folder stays open, quoted or not (`@src/`, `@"my notes/`), to go on typing inside it.
  const written = mentionPath(folder ? `${entry.path}/` : entry.path, { open: folder });
  return {
    key: `${entry.kind}:${entry.path}`,
    label: view.label,
    detail: view.detail,
    matches: view.matches,
    detailMatches: view.detailMatches,
    // The `file-icon` part: by type with the `file-icons` plugin, plain without.
    icon: () => <FileTypeIcon path={entry.path} kind={entry.kind} />,
    insert: `${trigger}${written}`,
    partial: folder,
  };
};

/**
 * Mentions of the project's files in the prompt: a `ComposerCompletions`
 * source searching the working directory through the host's file search
 * (`Files.Search`). The mention is the path as text, relative to the thread's
 * directory, which the agent reads like any path the prompt names. A folder
 * typed before the last `/` that exists narrows the search to it.
 */
export default defineUiPlugin({
  id: "file-mentions",
  config: FileMentionsConfig,
  requires: { client: Client, workspace: Workspace, slots: Slots },
  setup: ({ client, workspace, slots }, plugin) => {
    const { trigger, limit, folders } = plugin.config;
    slots.add(ComposerCompletions, {
      id: "file-mentions",
      order: 100,
      trigger,
      label: "Files",
      suggest: async (typed, { signal }) => {
        // Read before any await, so the composer asks again when they change: another project, a reconnect.
        const cwd = workspace.workingDir();
        const connected = client.connected();
        const query = typed.replace(/^\.\//, "");
        if (query !== "") await pause(PAUSE_MS, signal);
        if (cwd === undefined || !connected) throw new Error("Waiting for the host…");
        signal.throwIfAborted();
        const options = { limit, ...(folders ? {} : { kind: "file" as const }) };
        // `src/ap` looks for `ap` inside `src` when there is such a folder; otherwise the whole of it is fuzzy.
        const slash = query.lastIndexOf("/");
        const inFolder =
          slash > 0
            ? await client.host.files.search(cwd, query.slice(slash + 1), { ...options, within: query.slice(0, slash) }).catch((error: unknown) => {
                if (error instanceof HostError && error.code === "NotFound") return undefined;
                throw error;
              })
            : undefined;
        const result = inFolder ?? (await client.host.files.search(cwd, query, options));
        return {
          suggestions: result.entries.map((entry) => suggestion(entry, query, trigger)),
          note: result.indexing === true ? "Still reading the project: some files may be missing" : undefined,
        };
      },
    });
  },
});
