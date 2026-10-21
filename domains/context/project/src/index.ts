import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Effect } from "effect";
import { definePlugin, Events } from "@lemma/core";
import { Notice, Paths } from "@lemma/contracts";
import { PromptSections } from "@lemma/agent";

/** Per directory, the first of these that is a file wins (pi's order: AGENTS first, CLAUDE as the fallback). */
const CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;

interface ContextFile {
  readonly path: string;
  readonly content: string;
}

const stripBom = (text: string) => (text.startsWith("﻿") ? text.slice(1) : text);

/**
 * Finds context files and caches their contents by path, size, and mtime, so
 * a request costs a few `stat` calls and rereads only files that changed.
 */
export function makeLoader(home: string) {
  const cache = new Map<string, { readonly mtimeMs: number; readonly size: number; readonly content: string }>();

  const read = async (file: string): Promise<string | undefined> => {
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile()) return undefined;
      const hit = cache.get(file);
      if (hit !== undefined && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.content;
      const content = stripBom(await fs.readFile(file, "utf8"));
      cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, content });
      return content;
    } catch {
      // Missing or unreadable: not a context file.
      cache.delete(file);
      return undefined;
    }
  };

  const inDirectory = async (dir: string): Promise<ContextFile | undefined> => {
    for (const name of CANDIDATES) {
      const file = path.join(dir, name);
      const content = await read(file);
      if (content !== undefined) return { path: file, content };
    }
    return undefined;
  };

  /** The user-wide file from `home` first, then one per directory from the filesystem root down to `cwd`. */
  return async (cwd: string): Promise<ContextFile[]> => {
    const found: ContextFile[] = [];
    const seen = new Set<string>();
    const global = await inDirectory(home);
    if (global !== undefined) {
      found.push(global);
      seen.add(global.path);
    }
    const ancestors: ContextFile[] = [];
    for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
      const file = await inDirectory(dir);
      if (file !== undefined && !seen.has(file.path)) {
        ancestors.unshift(file);
        seen.add(file.path);
      }
      if (path.dirname(dir) === dir) break;
    }
    return [...found, ...ancestors];
  };
}

const renderSection = (files: readonly ContextFile[]): string =>
  [
    "Project-specific instructions and guidelines:",
    ...files.map(({ path: file, content }) => `<project_instructions path="${file}">\n${content}\n</project_instructions>`),
  ].join("\n\n");

/**
 * The project's instructions as a prompt section: the AGENTS.md (or CLAUDE.md) files from the user's home and from the
 * filesystem root down to the session's directory, between the agent's base prompt and its environment.
 */
export default definePlugin({
  id: "context.project",
  version: "0.1.0",
  requires: { paths: Paths },
  setup: function* ({ paths }, owner) {
    const load = makeLoader(paths.home);
    const events = yield* Events;
    const told = new Set<string>();
    /**
     * A project's `.lemma/config.jsonc` and `.lemma/plugins` apply to a host started in it (they are read once, from
     * where the host starts): a session in another project with its own is told so, once a directory, so its user is
     * not left wondering why its rows do not apply.
     */
    const tellIfOwnConfig = async (cwd: string) => {
      const dir = path.resolve(cwd);
      if (told.has(dir) || dir === path.resolve(paths.cwd)) return;
      told.add(dir);
      const own = await Promise.all(
        [fs.stat(path.join(dir, ".lemma", "config.jsonc")), fs.stat(path.join(dir, ".lemma", "plugins"))].map((found) =>
          found.then(
            () => true,
            () => false,
          ),
        ),
      );
      if (!own.includes(true)) return;
      await Effect.runPromise(
        events.publish(Notice, {
          level: "info",
          source: owner.id,
          message: `${dir}/.lemma has config or plugins of its own, which apply only to a host started there (this one started in ${paths.cwd}); its AGENTS.md, skills, and modes apply here`,
        }),
      );
    };
    yield* owner.add(
      PromptSections,
      {
        id: "project-context",
        text: async ({ cwd }) => {
          await tellIfOwnConfig(cwd).catch(() => undefined);
          const files = await load(cwd);
          return files.length === 0 ? undefined : renderSection(files);
        },
      },
      // In `body`, between the agent's base and its environment, whose date changes daily.
      { order: 500 },
    );
  },
});
