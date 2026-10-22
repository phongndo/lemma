import { describe, expect, it } from "vitest";
import { createRoot, createSignal } from "solid-js";
import type { PluginStatus } from "@lemma/contracts";
import type { NotifyService, PluginsService } from "@lemma/web";
import { configSetting } from "../src/config.ts";

/** A plugin list holding one row with a `count` field (default 8), whose writes the test settles by hand. */
const harness = (values: Record<string, unknown> = {}) => {
  const [list, setList] = createSignal<readonly PluginStatus[]>([
    {
      id: "p",
      version: "0.1.0",
      source: "bundled",
      enabled: true,
      provides: [],
      requires: [],
      state: "active",
      configFields: [{ key: "count", title: "Count", type: "integer", optional: false, default: 8 }],
      config: { values: { count: 8, ...values }, secretsSet: [] },
    },
  ]);
  const writes: { values: Readonly<Record<string, unknown>>; settle: (ok: boolean) => void }[] = [];
  const plugins = {
    list,
    setConfig: (_plugin: PluginStatus, written: Readonly<Record<string, unknown>>) =>
      new Promise((resolve, reject) =>
        writes.push({
          values: written,
          settle: (ok) => {
            if (!ok) return reject(new Error("refused"));
            const count = written.count === null ? 8 : written.count;
            setList((rows) => rows.map((row) => ({ ...row, config: { values: { count }, secretsSet: [] } })));
            resolve({});
          },
        }),
      ),
  } as unknown as PluginsService;
  const reported: string[] = [];
  const notify = { report: (_error: unknown, context?: string) => reported.push(context ?? "") } as unknown as NotifyService;
  return { plugins, notify, writes, reported, setList };
};

/** Lets a settled write's handlers run: they are a few promise steps away. */
const settled = async () => {
  for (let step = 0; step < 5; step++) await Promise.resolve();
};

describe("configSetting", () => {
  it("reads the value the plugin runs with, its default while unset, and nothing for a plugin not there", () =>
    createRoot((dispose) => {
      const { plugins, notify } = harness({ count: 3 });
      expect(configSetting<number>(plugins, notify, "p", "count").value()).toBe(3);
      expect(configSetting<number>(plugins, notify, "missing", "count").value()).toBeUndefined();
      dispose();
    }));

  it("shows a write at once, and writes the default as unset", async () => {
    const { plugins, notify, writes } = harness();
    await createRoot(async (dispose) => {
      const count = configSetting<number>(plugins, notify, "p", "count");
      count.set(5);
      expect(count.value()).toBe(5);
      expect(writes[0]!.values).toEqual({ count: 5 });
      writes[0]!.settle(true);
      await settled();
      expect(count.value()).toBe(5);
      count.set(8);
      expect(writes[1]!.values).toEqual({ count: null });
      dispose();
    });
  });

  it("unsets a field with no default, as one written over the wire, where undefined is dropped", () =>
    createRoot((dispose) => {
      const [list] = createSignal<readonly PluginStatus[]>([
        {
          id: "p",
          version: "0.1.0",
          source: "bundled",
          enabled: true,
          provides: [],
          requires: [],
          state: "active",
          configFields: [{ key: "model", title: "Model", type: "string", optional: true }],
          config: { values: { model: "a/b" }, secretsSet: [] },
        },
      ]);
      const written: Readonly<Record<string, unknown>>[] = [];
      const plugins = {
        list,
        setConfig: async (_plugin: PluginStatus, values: Readonly<Record<string, unknown>>) => void written.push(values),
      } as unknown as PluginsService;
      configSetting<string | undefined>(plugins, harness().notify, "p", "model").set(undefined);
      expect(written.map((values) => JSON.parse(JSON.stringify(values)))).toEqual([{ model: null }]);
      dispose();
    }));

  it("writes nothing for the value already running", () =>
    createRoot((dispose) => {
      const { plugins, notify, writes } = harness();
      configSetting<number>(plugins, notify, "p", "count").set(8);
      expect(writes).toHaveLength(0);
      dispose();
    }));

  it("goes back to the running value and reports a refused write", async () => {
    const { plugins, notify, writes, reported } = harness();
    await createRoot(async (dispose) => {
      const count = configSetting<number>(plugins, notify, "p", "count");
      count.set(5);
      writes[0]!.settle(false);
      await settled();
      expect(count.value()).toBe(8);
      expect(reported).toEqual(["Could not change Count"]);
      dispose();
    });
  });

  it("keeps showing a later write while an earlier one settles", async () => {
    const { plugins, notify, writes } = harness();
    await createRoot(async (dispose) => {
      const count = configSetting<number>(plugins, notify, "p", "count");
      count.set(5);
      count.set(6);
      writes[0]!.settle(true);
      await settled();
      expect(count.value()).toBe(6);
      dispose();
    });
  });

  it("writes the running value back while another write settles, as a switch flipped twice does", async () => {
    const { plugins, notify, writes } = harness();
    await createRoot(async (dispose) => {
      const count = configSetting<number>(plugins, notify, "p", "count");
      count.set(5);
      count.set(8);
      expect(count.value()).toBe(8);
      expect(writes.map((write) => write.values)).toEqual([{ count: 5 }, { count: null }]);
      for (const write of writes) write.settle(true);
      await settled();
      expect(count.value()).toBe(8);
      dispose();
    });
  });
});
