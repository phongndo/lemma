import type { CommandInfo } from "./commands.ts";
import { Context } from "effect";
import type { Accessor } from "solid-js";

export interface CommandsService {
  /** What host plugins offer to run (`lemma do`). */
  readonly list: Accessor<readonly CommandInfo[]>;
  /** Runs one in the working directory and reports how it went; resolves true when it succeeded. */
  readonly run: (command: CommandInfo) => Promise<boolean>;
}

export class Commands extends Context.Service<Commands, CommandsService>()("lemma-ui/Commands") {}
