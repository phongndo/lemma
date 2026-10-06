import { it } from "vitest";
import { original } from "./crash.ts";

it("resumes a resumed turn cut off again, after any of the events it logged", async () => {
  const { lines, events, resumeFrom } = await original();
  // A first crash at every fifth point, each resumed and crashed again after each event the resumption logged.
  for (let first = 1; first < lines.length; first += 5) {
    const resumed = await resumeFrom(lines.slice(0, first), `cut after event ${first}`);
    for (let second = first + 1; second < resumed.length; second++) {
      await resumeFrom(resumed.slice(0, second), `cut after event ${first} (${events[first - 1]!.data.type}), then after event ${second}`);
    }
  }
}, 120_000);
