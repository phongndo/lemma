import { it } from "vitest";
import { original } from "./crash.ts";

it("resumes a turn cut off after any of its events, answering every call once and repeating none that is unsafe", async () => {
  const { lines, events, resumeFrom } = await original();
  for (let cut = 0; cut < lines.length; cut++) {
    await resumeFrom(lines.slice(0, cut), `cut after event ${cut} (${events[cut - 1]?.data.type ?? "none"})`);
  }
}, 60_000);
