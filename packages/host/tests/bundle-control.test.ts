import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Effect } from "effect";
import { readDiscovery } from "@lemma/contracts/discovery";
import type { RuntimeEvent } from "@lemma/contracts/runtime";
import { connect } from "../../client/src/host.ts";
import type { Host } from "../../client/src/host.ts";
import { settled, startLemma } from "../../../scripts/e2e.ts";
import type { Lemma } from "../../../scripts/e2e.ts";

describe("real host feature controls", () => {
  let lemma: Lemma;
  let host: Host;
  let configPath: string;
  const events: RuntimeEvent[] = [];
  beforeAll(async () => {
    lemma = await startLemma("lemma-bundles-", {
      prepare: async (home) => {
        configPath = join(home, "config.jsonc");
        const config = JSON.parse(await readFile(configPath, "utf8"));
        delete config.plugins.transport;
        config.plugins.compaction = { required: true };
        await mkdir(join(home, "plugins"));
        await writeFile(
          join(home, "plugins", "policy.mjs"),
          `import { definePlugin } from ${JSON.stringify(import.meta.resolve("@lemma/core"))}; import { Layer } from ${JSON.stringify(import.meta.resolve("effect"))}; export default definePlugin({ id: "bundle-policy", layer: Layer.empty });`,
        );
        config.bundleDefinitions = [
          { id: "policy-feature", title: "Policy feature", host: ["bundle-policy"], ui: [] },
          { id: "test-feature", title: "Test feature", host: ["project-context"], ui: ["diagrams"] },
          { id: "transport-base", title: "Transport base", host: ["transport"], ui: [], defaults: { plugins: { transport: { config: { port: 0 } } } } },
          {
            id: "transport-extra",
            title: "Transport customization",
            host: ["transport"],
            ui: [],
            enabledByDefault: false,
            defaults: { plugins: { transport: { config: { staticDir: join(home, "custom-web") } } } },
          },
        ];
        await writeFile(configPath, JSON.stringify(config));
      },
    });
    const discovery = await Effect.runPromise(readDiscovery(lemma.home));
    if (discovery === undefined) throw new Error(lemma.output());
    host = await connect({ url: discovery.url, token: discovery.token, onEvent: (event) => events.push(event) });
  }, 60_000);
  afterAll(async () => {
    await host?.close();
    await lemma?.stop();
  });

  test("coordinates desired host and UI rows, publishes metadata, and honors explicit member overrides", async () => {
    // project-context also belongs to workspace, so deselect both owners.
    await host.host.configureBundles({ "test-feature": { enabled: false }, workspace: { enabled: false } });
    const ui = await host.ui.composition();
    expect(ui.plugins.diagrams).toMatchObject({ enabled: false });
    expect(ui.bundles?.find((bundle) => bundle.id === "test-feature")).toMatchObject({ enabled: false, customized: false, scope: "user" });
    expect((await host.host.plugins()).find((plugin) => plugin.id === "project-context")).toMatchObject({ enabled: false });
    expect(
      await settled(
        async () => events.some((event) => event.type === "ui-changed" && event.ui.bundles?.some((bundle) => bundle.id === "test-feature" && !bundle.enabled)),
        Boolean,
      ),
    ).toBe(true);
    await host.host.configure({ "project-context": { enabled: true } });
    expect(JSON.parse(await readFile(configPath, "utf8")).plugins["project-context"].enabled).toBe(true);
    expect((await host.ui.composition()).bundles?.find((bundle) => bundle.id === "test-feature")?.customized).toBe(true);
    await host.host.configureBundles({ "test-feature": { enabled: true }, workspace: { enabled: true } });
  }, 30_000);

  test("rejects unknown, untrusted, pinned, and required changes without retaining rejected rows", async () => {
    const before = await readFile(configPath, "utf8");
    await expect(host.host.configureBundles({ absent: { enabled: false } })).rejects.toMatchObject({ code: "ReloadError" });
    await expect(host.host.configureBundles({ "test-feature": { enabled: false } }, { scope: "project" })).rejects.toMatchObject({ code: "ReloadError" });
    await expect(host.host.configureBundles({ compaction: { enabled: false } })).rejects.toMatchObject({ code: "ReloadError" });
    await expect(host.host.configureBundles({ "policy-feature": { enabled: false } })).rejects.toMatchObject({ code: "ReloadError" });
    await expect(host.host.configureBundles({ "transport-base": { enabled: false } })).rejects.toMatchObject({ code: "ReloadError" });
    expect(await readFile(configPath, "utf8")).toBe(before);
    expect((await host.host.plugins()).find((plugin) => plugin.id === "compaction")?.state).toBe("active");
  }, 30_000);

  test("answers before applying a transport-affecting feature and exposes it after the restart", async () => {
    const previous = await Effect.runPromise(readDiscovery(lemma.home));
    expect(await host.host.configureBundles({ "transport-extra": { enabled: true } })).toMatchObject({ deferred: true });
    const discovery = await settled(
      () => Effect.runPromise(readDiscovery(lemma.home)),
      (value) => value.url !== previous?.url,
    );
    expect(discovery, lemma.output()).toBeDefined();
    if (discovery === undefined) return;
    await host.close();
    host = await connect({ url: discovery.url, token: discovery.token });
    expect((await host.ui.composition()).bundles?.find((bundle) => bundle.id === "transport-extra")).toMatchObject({ enabled: true });
  }, 30_000);
});
