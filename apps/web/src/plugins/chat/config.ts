import { Effect, Schema } from "effect";
import type { RouterService, ThreadsService } from "../../ui/contracts.ts";

/** The chat's settings. */
export const ChatConfig = Schema.Struct({
  expandTools: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.sync(() => false))).annotate({
    title: "Open tool calls",
    description: "Show every tool call's arguments and output instead of one quiet line.",
  }),
  foldWork: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.sync(() => true))).annotate({
    title: "Fold finished work",
    description: "Once a turn ends, fold its thinking and tool calls into one line above the answer.",
  }),
  promptRail: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.sync(() => true))).annotate({
    title: "Prompt rail",
    description:
      "Mark each of your prompts beside the chat, when there is room for them and a mouse or trackpad: point at one to preview it, click to go to it.",
  }),
});

/** What the chat's pieces share. */
export interface Chat {
  readonly threads: ThreadsService;
  readonly router: RouterService;
  readonly config: typeof ChatConfig.Type;
  readonly isOpen: (key: string, fallback: boolean) => boolean;
  readonly toggle: (key: string, fallback: boolean) => void;
  readonly pending: () => ReadonlySet<string>;
  /** The time, ticking each second while a turn runs, for elapsed-time labels. */
  readonly now: () => number;
}
