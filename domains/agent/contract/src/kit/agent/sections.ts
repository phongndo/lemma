import { Effect } from "effect";
import type { Context } from "effect";
import { awaitable } from "@lemma/core";
import type { Registries } from "@lemma/core";
import { withContribution } from "@lemma/contracts";
import { AgentError, PromptSections } from "../../agent.ts";
import type { SectionRequest, SystemSection } from "../../agent.ts";

/** A section whose plugin left, with no replacement, while the request was written: no section. */
const GONE = Symbol("gone");

/**
 * Each section's text for the request, in order (`PromptSections`), as part of its plugin's lifetime: one whose plugin
 * a reload replaced since it was listed is found again by its id, and one whose plugin has left is left out. Empty
 * text (or none) is no section; anything but text fails `Hook`, naming the section and its plugin.
 */
export const makeSections =
  (registries: Context.Service.Shape<typeof Registries>) =>
  (request: SectionRequest): Effect.Effect<readonly SystemSection[], AgentError> =>
    Effect.flatMap(registries.items(PromptSections), (items) =>
      Effect.forEach(
        items,
        (listed) => {
          const failed = (message: string, cause?: unknown) =>
            new AgentError({
              sessionId: request.sessionId,
              reason: "Hook",
              message: `The "${listed.item.id}" prompt section from ${listed.pluginId} ${message}`,
              ...(cause === undefined ? {} : { cause }),
            });
          return withContribution(
            registries,
            () => Effect.map(registries.items(PromptSections), (now) => now.find((contribution) => contribution.item.id === listed.item.id)),
            (contribution) =>
              Effect.map(
                awaitable(() => contribution.item.text(request)),
                (text: unknown) => ({ contribution, text }),
              ),
            { missing: () => GONE, expired: () => GONE },
          ).pipe(
            Effect.flatMap(({ contribution, text }): Effect.Effect<SystemSection[], AgentError> => {
              if (text === undefined || text === null || text === "") return Effect.succeed([]);
              if (typeof text !== "string") return Effect.fail(failed(`returned ${typeof text}, not text`));
              return Effect.succeed([{ id: contribution.item.id, source: contribution.pluginId, text }]);
            }),
            Effect.catchIf(
              (error) => error === GONE,
              () => Effect.succeed([]),
            ),
            Effect.mapError((cause) =>
              cause instanceof AgentError ? cause : failed(`failed: ${cause instanceof Error ? cause.message : String(cause)}`, cause),
            ),
          );
        },
        { concurrency: "unbounded" },
      ),
    ).pipe(Effect.map((written) => written.flat()));
