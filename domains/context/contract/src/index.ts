/*
 * The context domain's contract: what the model is told beyond the conversation, and how a conversation is kept
 * within its model's window. Its plugins add to the agent's (`@lemma/agent`), as a plugin of your own would: prompt
 * sections (`PromptSections`), and a compaction (`AgentRequestHook`).
 */
export { CONTEXT_CONTRACT } from "./version.ts";
