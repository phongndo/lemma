import { commandInvocation, commandNodes, commandProblem, runsHere } from "@lemma/threads";
import type { PromptCommandShape, ResolvedCommand } from "@lemma/threads";

/**
 * What a prompt comes to as a command: one that runs here (a `PromptCommands` tree with a `run`: `/new`,
 * `/mcp reconnect github`) runs instead of going out, or, missing a subcommand or an argument or given images, says
 * why and stays to be fixed. Any other prompt, a command whose tree runs nothing here (the host's, `/compact`)
 * included, is sent as typed.
 */
export type CommandTurn =
  | { readonly kind: "send" }
  | { readonly kind: "refuse"; readonly problem: string }
  | { readonly kind: "run"; readonly name: string; readonly command: ResolvedCommand & { readonly text: string } };

export function commandTurn(prompt: string, commands: readonly (PromptCommandShape & { readonly id: string })[], images: number): CommandTurn {
  const command = commandInvocation(prompt, commandNodes(commands));
  if (command === undefined || !runsHere(command.root)) return { kind: "send" };
  const name = `/${command.path.join(" ")}`;
  // Never sent to the model in its place: what is wrong with it is said, and the prompt stays to be fixed.
  const problem = images > 0 ? `${name} runs here, and takes no images: remove them first` : commandProblem(command);
  return problem === undefined ? { kind: "run", name, command } : { kind: "refuse", problem };
}
