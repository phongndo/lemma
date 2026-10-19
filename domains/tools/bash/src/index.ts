import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import { definePlugin, Events } from "@lemma/core";
import { ModelNotice, PromptSections } from "@lemma/agent";
import { SessionRemoved } from "@lemma/sessions";
import { Tools } from "@lemma/tools";
import { DEFAULT_BASH_TIMEOUT, makeBashTool } from "./bash.ts";
import { hostJobs, jobsSection } from "./jobs.ts";

export { bashTool, BashInput, BashOutput, DEFAULT_BASH_TIMEOUT, makeBashTool } from "./bash.ts";
export type { BashDetails } from "./bash.ts";
export { makeJobs } from "./jobs.ts";
export type { Job, JobExit, Jobs } from "./jobs.ts";

const BashConfig = Schema.Struct({
  timeout: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => DEFAULT_BASH_TIMEOUT)))
    .annotate({
      title: "Default timeout",
      description: "Seconds a command may run when the model names no timeout of its own. 0: no limit.",
    }),
});

/**
 * The `bash` tool, with the default timeout its config sets, and the commands it runs in the background: listed to the
 * model while they run (a prompt section), and told to it as they exit (`ModelNotice`).
 */
export default definePlugin({
  id: "tools.bash",
  version: "0.1.0",
  config: BashConfig,
  // The key to this host's background commands, from the instance replaced.
  carry: Schema.String,
  setup: function* (_, owner) {
    const events = yield* Events;
    const key = owner.previous ?? randomUUID();
    const jobs = hostJobs(key);
    yield* owner.handoff(() => key);
    // This instance tells each exit until its replacement attaches; the last to detach stops what still runs.
    const detach = jobs.attach(({ job, text, display }) => {
      Effect.runFork(events.publish(ModelNotice, { sessionId: job.sessionId, id: job.id, source: owner.id, content: [{ type: "text", text }], display }));
    });
    yield* Effect.addFinalizer(() => Effect.sync(detach));
    yield* owner.add(Tools, makeBashTool(owner.config.timeout, jobs));
    yield* owner.add(PromptSections, { id: "tools.bash.jobs", text: ({ sessionId }) => jobsSection(jobs.running(sessionId)) });
    yield* owner.observe(SessionRemoved, ({ sessionId }) => Effect.sync(() => jobs.stop(sessionId)));
  },
});
