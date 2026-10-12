import type { ToolView } from "@lemma/threads";

/** How the web app shows a `bash` call: its command, as a shell line. */
export const bashView: ToolView = {
  icon: "terminal",
  summary: (args) => {
    const command = typeof args?.command === "string" ? args.command : "";
    return command === "" ? {} : { primary: command, shell: true };
  },
  streaming: "command",
  action: ["ran", "command", "commands"],
};
