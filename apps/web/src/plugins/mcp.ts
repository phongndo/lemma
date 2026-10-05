import { batch, createMemo, createSignal } from "solid-js";
import { HostError } from "@lemma/contracts";
import type { McpServerInfo, McpToolInfo } from "@lemma/contracts";
import { Client, Mcp, Notify } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";

/**
 * MCP servers as the host reports them, kept current by its `mcp-changed`
 * events, and the changes this page makes. The model only: the `mcp-page`
 * plugin draws it, so a replacement view (or none) keeps the composer's
 * notices and the chat's tool titles working through `Mcp`.
 */
export default defineUiPlugin({
  id: "mcp",
  requires: { client: Client, notify: Notify },
  provides: { mcp: Mcp },
  setup: ({ client, notify }, plugin) => {
    const host = client.host;
    const [servers, setServers] = createSignal<readonly McpServerInfo[]>([]);
    const [loaded, setLoaded] = createSignal(false);
    const [unavailable, setUnavailable] = createSignal<string>();
    const [signingIn, setSigningIn] = createSignal<string>();
    const [signInUrls, setSignInUrls] = createSignal<Readonly<Record<string, string>>>({});
    const owners = createMemo(() => {
      const map = new Map<string, { readonly server: McpServerInfo; readonly tool: McpToolInfo }>();
      for (const server of servers()) for (const tool of server.tools) map.set(tool.tool, { server, tool });
      return map;
    });

    const show = (next: readonly McpServerInfo[], why?: string) =>
      batch(() => {
        setServers(next);
        setUnavailable(why);
        setLoaded(true);
      });
    /** Bumped by every list and event, so a list that took longer than a newer event cannot undo it. */
    let latest = 0;
    const refresh = async () => {
      const mine = ++latest;
      try {
        const next = await host.mcp.servers();
        if (mine === latest) show(next);
      } catch (error) {
        // The host's `mcp` plugin is off (or replaced by none): nothing to list, and the page says why.
        if (error instanceof HostError && error.code === "Unavailable") {
          if (mine === latest) show([], error.message);
          return;
        }
        throw error;
      }
    };
    const quietly = () => void refresh().catch(() => {});

    plugin.onCleanup(client.onConnect(() => void refresh().catch((error) => notify.report(error, "Could not list MCP servers"))));
    plugin.onCleanup(
      client.onEvent((event) => {
        if (event.type === "mcp-changed") {
          latest++;
          show(event.servers);
        } else if (event.type === "plugins-changed") {
          // The `mcp` plugin may have come or gone.
          quietly();
        } else if (event.type === "notice" && event.notice.source?.startsWith("mcp:")) {
          // A sign-in's page to open, for the server signing in here.
          const id = event.notice.source.slice("mcp:".length);
          const url = event.notice.links?.[0]?.url;
          if (url !== undefined && signingIn() === id) setSignInUrls((all) => ({ ...all, [id]: url }));
        }
      }),
    );

    /** Runs a change, then lists again (its event may be lost), so what asked sees it done when this resolves. */
    const change = async (action: Promise<void>) => {
      await action;
      await refresh().catch(() => {});
    };
    return {
      mcp: {
        servers,
        loaded,
        unavailable,
        save: (spec, options) => change(host.mcp.save(spec, options?.secrets === undefined ? undefined : { secrets: options.secrets })),
        remove: (id) => change(host.mcp.remove(id)),
        setEnabled: (id, enabled) => change(host.mcp.setEnabled(id, enabled)),
        setTool: (id, tool, enabled) => change(host.mcp.setTool(id, tool, enabled)),
        restart: (id) => change(host.mcp.restart(id)),
        login: async (id) => {
          const running = signingIn();
          if (running !== undefined) throw new Error(`Signing in to ${running} already: finish or cancel that first`);
          setSigningIn(id);
          try {
            await host.mcp.login(id);
          } finally {
            batch(() => {
              setSigningIn(undefined);
              setSignInUrls(({ [id]: _done, ...rest }) => rest);
            });
            // Its sign-in links are no longer useful.
            notify.dismissWhere((toast) => toast.source === `mcp:${id}` && (toast.links !== undefined || toast.code !== undefined));
            quietly();
          }
        },
        logout: (id) => change(host.mcp.logout(id)),
        signingIn,
        signInUrl: (id) => signInUrls()[id],
        logs: (id) => host.mcp.logs(id),
        toolOwner: (name) => owners().get(name),
      },
    };
  },
});
