import { createEffect } from "solid-js";
import type { Accessor } from "solid-js";
import { McpChannels } from "@lemma/mcp";
import type { Exposure, McpServerChange, McpServerStatus, McpState } from "@lemma/mcp";
import { HammerIcon } from "@lemma/look";
import { PromptCommands } from "@lemma/threads";
import type { ClientService, NotifyService, SlotsService } from "@lemma/web";
import { EXPOSURES, LABELS, TOOL_EXPOSURES } from "./exposures.ts";
import { statusOf } from "./items.ts";

/**
 * `/mcp …` in the prompt: each subcommand over the servers as they are now, offered by name with their state. Its
 * failures are the composer's to report, so it calls the host directly rather than through the page's actions, which
 * report too.
 */
export const addMcpCommand = (slots: SlotsService, client: ClientService, notify: NotifyService, state: Accessor<McpState | undefined>) => {
  const reconnect = (server: string) => client.channel.call(McpChannels.reconnect, { server });
  const configure = (server: string, change: McpServerChange) => client.channel.call(McpChannels.configure, { server, change });
  // The message `/mcp login` leaves with the page to open, by server: gone once that sign-in is.
  const signInToasts = new Map<string, number>();
  createEffect(() => {
    // Read first, whether any message waits or not, so a later change runs this again.
    const servers = state()?.servers ?? [];
    for (const [name, id] of signInToasts) {
      if (servers.find((server) => server.name === name)?.auth?.state === "signing-in") continue;
      notify.dismiss(id);
      signInToasts.delete(name);
    }
  });
  const named = (name: string | undefined) => {
    const server = state()?.servers.find((candidate) => candidate.name === name);
    if (server === undefined) throw new Error(name === undefined ? "Name a server" : `No MCP server “${name}”`);
    return server;
  };
  const servers = (which: (server: McpServerStatus) => boolean = () => true) => ({
    name: "server",
    values: () => (state()?.servers ?? []).filter(which).map((server) => ({ value: server.name, detail: statusOf(server).text })),
  });
  const exposure = (withDefault: boolean) => ({
    name: "exposure",
    values: () => (withDefault ? TOOL_EXPOSURES : EXPOSURES).map(({ value }) => ({ value })),
  });
  const exposureOf = (value: string | undefined, withDefault: boolean) => {
    const found = (withDefault ? TOOL_EXPOSURES : EXPOSURES).find((candidate) => candidate.value === value);
    if (found === undefined) throw new Error(`Choose one of ${(withDefault ? TOOL_EXPOSURES : EXPOSURES).map((candidate) => candidate.value).join(", ")}`);
    return found.value;
  };
  slots.add(PromptCommands, {
    id: "mcp",
    order: 50,
    description: "See and change the MCP servers",
    icon: HammerIcon,
    subcommands: [
      {
        name: "list",
        aliases: ["ls"],
        description: "Each server and its state",
        run: () => {
          const all = state()?.servers ?? [];
          notify.toast({
            level: "info",
            message: all.length === 0 ? "No MCP servers yet" : all.map((server) => `${server.name}: ${statusOf(server).text}`).join("\n"),
          });
        },
      },
      {
        name: "reconnect",
        description: "Close a server's connection and connect again",
        args: [servers((server) => server.enabled)],
        run: ({ args }) => reconnect(named(args[0]).name),
      },
      {
        name: "login",
        aliases: ["sign-in"],
        description: "Sign in to a remote server that asks",
        args: [servers((server) => server.auth !== undefined)],
        run: async ({ args }) => {
          const { name } = named(args[0]);
          const { url } = await client.channel.call(McpChannels.signIn, { server: name });
          const previous = signInToasts.get(name);
          if (previous !== undefined) notify.dismiss(previous);
          signInToasts.set(
            name,
            notify.toast({
              level: "info",
              message: `Approve Lemma's access to ${name} in the browser; Lemma finishes on its own. A browser on another device lands on a page that doesn't load: paste its address in Settings › Integrations › ${name}.`,
              links: [{ url, label: "Open the sign-in page" }],
            }),
          );
        },
      },
      {
        name: "logout",
        aliases: ["sign-out"],
        description: "Forget the sign-in to a server",
        args: [servers((server) => server.auth?.state === "signed-in")],
        run: ({ args }) => client.channel.call(McpChannels.signOut, { server: named(args[0]).name }),
      },
      {
        name: "enable",
        aliases: ["on"],
        description: "Turn a server on",
        args: [servers((server) => !server.enabled)],
        run: ({ args }) => configure(named(args[0]).name, { enabled: true }),
      },
      {
        name: "disable",
        aliases: ["off"],
        description: "Turn a server off",
        args: [servers((server) => server.enabled)],
        run: ({ args }) => configure(named(args[0]).name, { enabled: false }),
      },
      {
        name: "exposure",
        description: "How a server's tools reach the model",
        args: [servers(), exposure(false)],
        run: ({ args }) => configure(named(args[0]).name, { exposure: exposureOf(args[1], false) as Exposure }),
      },
      {
        name: "tool",
        description: "How one tool reaches the model",
        args: [
          servers(),
          {
            name: "tool",
            values: ({ args }) =>
              (state()?.servers.find((server) => server.name === args[0])?.tools ?? []).map((tool) => ({ value: tool.name, detail: LABELS[tool.exposure] })),
          },
          exposure(true),
        ],
        run: ({ args }) => {
          const server = named(args[0]);
          const tool = server.tools.find((candidate) => candidate.name === args[1]);
          if (tool === undefined) throw new Error(`${server.name} has no tool “${args[1] ?? ""}”`);
          const chosen = exposureOf(args[2], true);
          return configure(server.name, { tools: { [tool.name]: chosen === "default" ? null : (chosen as Exposure) } });
        },
      },
    ],
  });
};
