import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionPoints, walk } from "./sources.ts";

// What the docs tell a plugin author, checked against the code: the framework packages' docs link only within them,
// each domain's README names what its contract offers, the plugin guide's tables name what contracts export, and every
// hook and registry says how it composes. `pnpm check` runs it; scripts/check-boundaries.ts checks the code itself.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const domainsDir = join(root, "domains");

/** Prints a check's verdict; every check runs before the script fails. */
let failed = false;
const report = (heading: string, found: readonly string[], ok: string) => {
  if (found.length === 0) return console.log(ok);
  failed = true;
  console.error(`${heading}:\n${found.map((problem) => `  ${problem}`).join("\n")}`);
};

const isFolder = (path: string) => statSync(path).isDirectory();
const domains = readdirSync(domainsDir).filter((entry) => isFolder(join(domainsDir, entry)));
/** Each domain's packages (its contract, `domains/<domain>/contract`, and its plugins): its folders with a package.json. */
const domainPackages = domains.flatMap((domain) =>
  readdirSync(join(domainsDir, domain))
    .map((name) => join(domainsDir, domain, name))
    .filter((dir) => isFolder(dir) && existsSync(join(dir, "package.json"))),
);

// The core and the router can leave this repository as they are: their docs link within those packages only, never to
// the app's docs, so a copy of the directories keeps every link working.
const frameworks = ["packages/core", "packages/router", "packages/router-solid"].map((dir) => join(root, dir));
const linkProblems: string[] = [];
for (const home of frameworks) {
  for (const file of walk(home).filter((path) => path.endsWith(".md"))) {
    for (const match of readFileSync(file, "utf8").matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1]!.split("#")[0]!;
      if (target === "" || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const resolved = resolve(dirname(file), target);
      if (!frameworks.some((framework) => resolved === framework || resolved.startsWith(`${framework}/`))) {
        linkProblems.push(`${relative(root, file)}: links "${match[1]}", outside the framework packages`);
      }
    }
  }
}
report("Framework doc links leaving the framework packages", linkProblems, "framework doc links: ok");

// Each domain's README says what its contract offers in each of the five shapes (docs/plugins.md): an extension point
// a contract declares (a registry, hook, event, slot, part, or capability) that its README does not name is one a
// plugin author cannot find. Every domain has a README, one with no contract too (`transport`).
const docProblems: string[] = [];
for (const domain of domains) {
  if (!existsSync(join(domainsDir, domain, "README.md")))
    docProblems.push(`domains/${domain}: no README.md (its plugins, and what its contract offers in each shape)`);
}
for (const { domain, name, file } of extensionPoints(root)) {
  const readme = join(domainsDir, domain, "README.md");
  if (existsSync(readme) && !readFileSync(readme, "utf8").includes(`\`${name}\``))
    docProblems.push(`domains/${domain}/README.md: does not name \`${name}\` (${relative(root, file)})`);
}
// The plugin guide's tables (what to plug into, and coming from Pi) name extension points for a task; each name must be
// one a contract exports, so a rename or removal there cannot leave the guide pointing at nothing.
const guide = readFileSync(join(root, "docs/plugins.md"), "utf8");
const exported = new Set(
  [...domainPackages.map((dir) => join(dir, "src")), join(root, "packages/contracts/src"), join(root, "packages/web/src")]
    .flatMap((dir) => walk(dir).filter((path) => /\.(ts|tsx)$/.test(path)))
    .flatMap((file) => [...readFileSync(file, "utf8").matchAll(/^export (?:const|class|interface|type|function) (\w+)/gm)].map((match) => match[1]!)),
);
for (const heading of ["## What to plug into", "## Coming from Pi"]) {
  const start = guide.indexOf(heading);
  if (start === -1) continue;
  const section = guide.slice(start, guide.indexOf("\n## ", start + heading.length) === -1 ? undefined : guide.indexOf("\n## ", start + heading.length));
  for (const line of section.split("\n").filter((row) => row.startsWith("|"))) {
    // The Lemma column: the last cell but one in the plug-in table, the last in Pi's.
    const cells = line.split("|").slice(1, -1);
    const lemma = heading === "## Coming from Pi" ? cells.at(-1) : cells.at(-2);
    for (const [, name] of (lemma ?? "").matchAll(/`([A-Z]\w*)(?:[.(][^`]*)?`/g)) {
      if (!exported.has(name!)) docProblems.push(`docs/plugins.md: names \`${name}\` (${heading.slice(3)}), which no contract exports`);
    }
  }
}
report("Domain READMEs missing what their contracts offer", docProblems, "domain docs: ok");

// Every hook and registry a contract declares says how its handlers or items compose, and what a failing one does,
// where it is declared: an `@composition` line in the doc comment right above it. A plugin author reads it there, in
// their editor, rather than learning it from the code that reads the registry or invokes the hook.
const compositionPoint = /^export const ([A-Z]\w*)\s*=\s*(?:Hook|Registry)\.make\b/;
const compositionProblems: string[] = [];
for (const dir of [...domainPackages.filter((dir) => dir.endsWith("/contract")).map((dir) => join(dir, "src")), join(root, "packages/contracts/src")]) {
  for (const file of walk(dir).filter((path) => /\.(ts|tsx)$/.test(path))) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      const name = compositionPoint.exec(line)?.[1];
      if (name === undefined) return;
      let start = index - 1;
      if (!(lines[start] ?? "").trim().endsWith("*/")) {
        compositionProblems.push(`${relative(root, file)}:${index + 1}: \`${name}\` has no doc comment saying how it composes (\`@composition\`)`);
        return;
      }
      while (start > 0 && !lines[start]!.trim().startsWith("/**")) start--;
      if (!lines.slice(start, index).some((each) => each.includes("@composition"))) {
        compositionProblems.push(`${relative(root, file)}:${index + 1}: \`${name}\`'s doc comment does not say how it composes (\`@composition\`)`);
      }
    });
  }
}
report("Extension points that do not say how they compose", compositionProblems, "composition docs: ok");

if (failed) process.exit(1);
