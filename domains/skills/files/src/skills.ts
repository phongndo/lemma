import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { SkillInfo } from "@lemma/skills";

/** A skill as found: what clients list, and its instructions (its `SKILL.md` after the frontmatter). */
export interface Skill extends SkillInfo {
  readonly body: string;
}

/** What may follow the trigger: letters, digits, `_`, `-`, and `.` inside, so a sentence's full stop is not the name's. */
const NAME = /^[A-Za-z0-9](?:[\w.-]*\w)?$/;

const stripBom = (text: string) => (text.startsWith("\uFEFF") ? text.slice(1) : text);

const unquote = (value: string) => {
  const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
  return quoted === null ? value : quoted[1] === '"' ? quoted[2]!.replace(/\\(["\\])/g, "$1") : quoted[2]!.replace(/''/g, "'");
};

/**
 * A `SKILL.md`'s frontmatter fields and body. The frontmatter is read as the flat YAML skills use: `key: value`, a
 * value quoted or not, continued on indented lines, or a block (`>`, `|`) on the indented lines after it.
 */
export const parseSkill = (text: string): { readonly fields: Readonly<Record<string, string>>; readonly body: string } => {
  const source = stripBom(text);
  const block = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (block === null) return { fields: {}, body: source.trim() };
  const fields: Record<string, string> = {};
  const lines = block[1]!.split(/\r?\n/);
  for (let at = 0; at < lines.length; at++) {
    const field = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(lines[at]!);
    if (field === null) continue;
    const [, key, first] = field as unknown as [string, string, string];
    const more: string[] = [];
    while (at + 1 < lines.length && (/^\s/.test(lines[at + 1]!) || lines[at + 1] === "")) more.push(lines[++at]!);
    const style = /^([>|])[+-]?$/.exec(first.trim());
    const continued = more.map((line) => line.trim());
    fields[key] =
      style === null
        ? unquote([first.trim(), ...continued].filter((part) => part !== "").join(" "))
        : style[1] === "|"
          ? continued.join("\n").trim()
          : continued.join(" ").replace(/\s+/g, " ").trim();
  }
  return { fields, body: source.slice(block[0].length).trim() };
};

/** `~` and `~/…` as under `home`. */
export const expandHome = (dir: string, home: string) => (dir === "~" ? home : dir.startsWith("~/") ? path.join(home, dir.slice(2)) : dir);

/**
 * Where skills are: the user's directories, the names of a project's, looked for in a session's directory and each
 * above it, and those plugins' packages bring (`resources.skills`), read on each find, as plugins come and go.
 */
export interface SkillRoots {
  readonly user: readonly string[];
  readonly project: readonly string[];
  readonly plugins?: () => Promise<readonly { readonly dir: string; readonly scope: Skill["scope"] }[]>;
}

/**
 * Finds the skills a session in a directory has, caching each `SKILL.md` by its size and mtime, so a request costs a
 * directory listing and a `stat` a skill. By name, the last found wins: plugins' packages', then the user's
 * directories, in order, then the project's from the filesystem root down to the session's directory, so the nearest
 * is used and a skill of the user's own replaces a plugin's. A directory both
 * the user's and a project's (`~/.agents/skills` above a project in the home) counts as the user's.
 */
export function makeSkillFinder(roots: SkillRoots) {
  // By scope and file; a file that is no skill is cached as none, so it is not read again until it changes.
  const cache = new Map<string, { readonly mtimeMs: number; readonly size: number; readonly skill: Skill | undefined }>();

  const read = async (file: string, folder: string, scope: Skill["scope"]): Promise<Skill | undefined> => {
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile()) return undefined;
      const key = `${scope}:${file}`;
      const hit = cache.get(key);
      if (hit !== undefined && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.skill;
      const { fields, body } = parseSkill(await fs.readFile(file, "utf8"));
      const name = fields["name"] !== undefined && NAME.test(fields["name"]) ? fields["name"] : folder;
      const skill = NAME.test(name) ? { name, description: fields["description"] ?? "", path: file, scope, body } : undefined;
      cache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, skill });
      return skill;
    } catch {
      // Missing or unreadable: no skill.
      cache.delete(`${scope}:${file}`);
      return undefined;
    }
  };

  const inDirectory = async (dir: string, scope: Skill["scope"]): Promise<readonly Skill[]> => {
    let entries: readonly string[];
    try {
      entries = (await fs.readdir(dir)).sort();
    } catch {
      return [];
    }
    const found = await Promise.all(entries.filter((entry) => !entry.startsWith(".")).map((entry) => read(path.join(dir, entry, "SKILL.md"), entry, scope)));
    return found.filter((skill): skill is Skill => skill !== undefined);
  };

  return async (cwd: string): Promise<readonly Skill[]> => {
    const dirs: { readonly dir: string; readonly scope: Skill["scope"] }[] = [
      ...((await roots.plugins?.()) ?? []),
      ...roots.user.map((dir) => ({ dir: path.resolve(dir), scope: "user" as const })),
    ];
    const ancestors: string[] = [];
    for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
      ancestors.unshift(dir);
      if (path.dirname(dir) === dir) break;
    }
    for (const dir of ancestors) for (const name of roots.project) dirs.push({ dir: path.join(dir, name), scope: "project" });
    const seen = new Set<string>();
    const unique = dirs.filter(({ dir }) => {
      if (seen.has(dir)) return false;
      seen.add(dir);
      return true;
    });
    const byName = new Map<string, Skill>();
    for (const skills of await Promise.all(unique.map(({ dir, scope }) => inDirectory(dir, scope)))) {
      for (const skill of skills) {
        byName.delete(skill.name);
        byName.set(skill.name, skill);
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  };
}

/** The system prompt's list of skills: each one's name, description, and file, for the model to read when it applies. */
export const skillsSection = (skills: readonly Skill[], trigger: string): string | undefined =>
  skills.length === 0
    ? undefined
    : [
        "Skills: instructions for particular tasks, each in a SKILL.md file. When a task matches a skill's description, read its file before you start, and follow it; paths in a skill are relative to its folder.",
        `A prompt that names a skill (${trigger}name) carries its instructions in a <skill> block.`,
        "<available_skills>",
        ...skills.map((skill) => `- ${skill.name}: ${skill.description === "" ? "(no description)" : skill.description} (${skill.path})`),
        "</available_skills>",
      ].join("\n");

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The skills a prompt names (`$review`, at the start of a word), in order, once each, that are not carried in it already. */
export const mentionedSkills = (text: string, skills: readonly Skill[], trigger: string): readonly Skill[] => {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const named = new Map<string, Skill>();
  for (const match of text.matchAll(new RegExp(`(?<=^|\\s)${escapeRegExp(trigger)}([A-Za-z0-9](?:[\\w.-]*\\w)?)`, "g"))) {
    const skill = byName.get(match[1]!);
    if (skill !== undefined && !text.includes(skillOpening(skill))) named.set(skill.name, skill);
  }
  return [...named.values()];
};

const attribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const skillOpening = (skill: Skill) => `<skill name="${attribute(skill.name)}"`;

/** A skill's instructions as a prompt carries them. */
export const skillBlock = (skill: Skill): string => `${skillOpening(skill)} path="${attribute(skill.path)}">\n${skill.body}\n</skill>`;
