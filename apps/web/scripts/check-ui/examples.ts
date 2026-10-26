import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startHost } from "./hosts.ts";
import { boot, root, showView } from "./shared.ts";

/** An example folder plugin's files, as a user copies it into the plugin directory: all but its tests and installs. */
const folder = (name: string, dir = resolve(root, "../../examples", name)): Record<string, string> =>
  Object.fromEntries(
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !["node_modules", "tests"].includes(entry.name))
      .flatMap((entry) =>
        entry.isDirectory()
          ? Object.entries(folder(`${name}/${entry.name}`, join(dir, entry.name)))
          : entry.isFile()
            ? [[`${name}/${entry.name}`, readFileSync(join(dir, entry.name), "utf8")]]
            : [],
      ),
  );

// The examples' plugins, run as a user's would, from the plugin directory: both halves, on the host and in the page.
export const examples = async (): Promise<string> => {
  const { page, expectNoErrors } = await boot(await startHost({ files: { ...folder("todo"), ...folder("glossary") } }));
  await page.click(".thread-open:has-text('Fix flaky session log test')");
  await page.waitForSelector(".turn");
  // examples/todo adds a view of the thread and how its tool's calls show, and so does examples/glossary, which
  // docs/building.md builds.
  await showView(page, "todo").catch(() => assert.fail("examples/todo added no Todos view"));
  await page.waitForSelector(".todo-view >> text=No todos in this thread.");
  assert.equal(
    await page.evaluate(async () => {
      const { ToolViews } = (await import("/src/ui/api.ts" as string)).api.contracts;
      return (window as any).lemma.slots().get(ToolViews, "todo")?.icon;
    }),
    "check",
    "examples/todo added no view of its tool's calls",
  );
  await showView(page, "glossary").catch(() => assert.fail("examples/glossary added no Glossary view"));
  await page.waitForSelector(".glossary-view >> text=No terms in this thread yet.");
  expectNoErrors("an example's plugin");
  return "an example's plugin, copied into the plugin directory, adds a view of the thread and of its tool's calls";
};
