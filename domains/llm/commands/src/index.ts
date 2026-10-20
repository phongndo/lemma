import { Effect } from "effect";
import type { Context } from "effect";
import { definePlugin } from "@lemma/core";
import { Interaction } from "@lemma/contracts";
import { CommandError, Commands } from "@lemma/commands";
import type { Command } from "@lemma/commands";
import { Llm } from "@lemma/llm";

type Ask = Context.Service.Shape<typeof Interaction>;

/** A command's own dead end: nothing to choose from. Reported like any failure. */
const nothing = (command: string, message: string) => new CommandError({ command, reason: "Failed", message });

export const llmCommands = (llm: Context.Service.Shape<typeof Llm>, ask: Ask): readonly Command[] => [
  {
    id: "llm.logout",
    title: "Log out of a provider…",
    category: "Providers",
    keywords: ["sign out", "credentials", "api key"],
    run: () =>
      Effect.gen(function* () {
        const providers = (yield* llm.providers).filter((provider) => provider.configured);
        if (providers.length === 0) return yield* nothing("llm.logout", "No provider is logged in");
        const id = yield* ask.select(
          "Log out of which provider?",
          providers.map((provider) => ({
            value: provider.id,
            label: provider.name,
            ...(provider.source === undefined ? {} : { description: provider.source }),
          })),
        );
        yield* llm.logout(id);
        // Lemma forgets its copy; the provider honors the key or sign-in until it is revoked there.
        const name = providers.find((provider) => provider.id === id)?.name ?? id;
        return { message: `Logged out of ${name}. To end its access there too, revoke it with ${name}.` };
      }),
  },
];

/** The model providers' commands: log out of one. */
export default definePlugin({
  id: "llm.commands",
  version: "0.1.0",
  requires: { ask: Interaction, dependency: Llm },
  setup: ({ ask, dependency }, owner) => Effect.forEach(llmCommands(dependency, ask), (command) => owner.add(Commands, command), { discard: true }),
});
