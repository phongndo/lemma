import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Effect, Layer } from "effect";
import { definePlugin, PluginContext } from "@lemma/core";
import { AgentRequestHook, Paths } from "@lemma/contracts";
import type { SystemSection } from "@lemma/contracts";

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

/** Places the section before the agent's `environment` section, whose date changes daily, to keep the stable prefix long. */
const insert = (sections: readonly SystemSection[], section: SystemSection): SystemSection[] => {
  const at = sections.findIndex((candidate) => candidate.id === "environment");
  return at === -1 ? [...sections, section] : [...sections.slice(0, at), section, ...sections.slice(at)];
};

export default definePlugin({
  id: "project-context",
  version: "0.1.0",
  requires: [Paths],
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const owner = yield* PluginContext;
      const load = makeLoader((yield* Paths).home);
      yield* owner.on(AgentRequestHook, (draft, next) =>
        Effect.flatMap(
          Effect.promise(() => load(draft.cwd)),
          (files) =>
            next(
              files.length === 0
                ? draft
                : {
                    ...draft,
                    sections: insert(draft.sections, { id: "project-context", source: owner.id, text: renderSection(files) }),
                  },
            ),
        ),
      );
    }),
  ),
});
