import { Layer } from "effect";
import { definePlugin } from "@lemma/core";
import { Harnesses } from "@lemma/contracts";
import { makeRegistry } from "./registry.ts";

export { recordTurn } from "./record.ts";
export type { Ended, Producer, RecordedCall, RecordedResult, RecorderServices, TurnRecorder } from "./record.ts";

export default definePlugin({
  id: "harnesses",
  version: "0.1.0",
  provides: [Harnesses],
  layer: Layer.effect(Harnesses, makeRegistry),
});
