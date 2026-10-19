import { agentConformance } from "@lemma/agent/testing";
import sessions from "@lemma/sessions-files";
import tools from "@lemma/tools-registry";
import agent from "../src/index.ts";
import { host, paths, tempDir } from "./fakes.ts";

// The bundled loop meets the Agent contract a replacement is held to: the store and registry beside it, the suite's model and tool.
agentConformance("agent.loop", async () => {
  const home = await tempDir();
  return [paths(home, home), host(), sessions, tools, agent];
});
