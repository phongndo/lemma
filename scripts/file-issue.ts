/**
 * Files what CI found as a GitHub issue, or as a comment on the open issue
 * with its title: one cause gathers each time it is seen until someone fixes
 * it and closes the issue, and a run that found it need not be red to be
 * heard. It needs `gh` and a token that can write issues (`GH_TOKEN`).
 *
 *   node scripts/file-issue.ts --flakes <file>
 *   node scripts/file-issue.ts --label <label> --title <title> --body-file <file>
 *
 * `--flakes` files each check in the JSON lines `scripts/flaky.ts` wrote,
 * labelled `flaky`, titled by the check; a missing file is none.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Flake } from "./flaky.ts";

const { values } = parseArgs({
  options: { flakes: { type: "string" }, label: { type: "string" }, title: { type: "string" }, "body-file": { type: "string" } },
});

/** The labels this files under, made on first use. */
const LABELS: Readonly<Record<string, { readonly color: string; readonly description: string }>> = {
  flaky: { color: "fbca04", description: "A check that failed and then passed on a retry (scripts/flaky.ts)" },
  soak: { color: "d93f0b", description: "What the Soak workflow's long checks found" },
};

const gh = (args: readonly string[], input?: string) => execFileSync("gh", args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "inherit"] }).trim();

/** GitHub refuses a longer title. */
const titled = (title: string) => (title.length <= 250 ? title : `${title.slice(0, 249)}…`);

/** This run, linked, and what it ran on. */
const run = () => {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: id, GITHUB_WORKFLOW: workflow, GITHUB_SHA: sha } = process.env;
  const event = process.env.GITHUB_EVENT_NAME ?? "a run";
  const where = `${event} on ${process.env.GITHUB_REF_NAME ?? "?"} at ${sha?.slice(0, 7) ?? "?"}`;
  return server && repo && id ? `[${workflow ?? "a workflow"} run ${id}](${server}/${repo}/actions/runs/${id}) (${where})` : `a local run (${where})`;
};

const labelled = new Set<string>();

/** Comments `body` on the open issue labelled `label` and titled `title`, or opens one; says which. */
const fileIssue = (label: string, title: string, body: string) => {
  const known = LABELS[label];
  if (known !== undefined && !labelled.has(label)) {
    gh(["label", "create", label, "--color", known.color, "--description", known.description, "--force"]);
    labelled.add(label);
  }
  const name = titled(title);
  const open: { number: number; title: string }[] = JSON.parse(
    gh(["issue", "list", "--state", "open", "--label", label, "--limit", "1000", "--json", "number,title"]),
  );
  const found = open.find((issue) => issue.title === name);
  if (found === undefined) {
    console.log(`Opened ${gh(["issue", "create", "--title", name, "--label", label, "--body-file", "-"], body)}`);
  } else {
    console.log(`Commented on #${found.number}: ${gh(["issue", "comment", String(found.number), "--body-file", "-"], body)}`);
  }
};

const fence = (text: string) => `\`\`\`text\n${text.length <= 6000 ? text : `${text.slice(0, 6000)}\n…`}\n\`\`\``;

if (values.flakes !== undefined) {
  // One issue for each check, listing every runner and try it flaked on in this run.
  const seen = new Map<string, Flake[]>();
  const text = existsSync(values.flakes) ? readFileSync(values.flakes, "utf8") : "";
  for (const line of text.split("\n").filter((line) => line.trim() !== "")) {
    let flake: Flake | undefined;
    try {
      flake = JSON.parse(line) as Flake;
    } catch {
      flake = undefined;
    }
    if (typeof flake?.name !== "string") {
      console.warn(`Skipped a line that is no flake: ${line.slice(0, 200)}`);
      continue;
    }
    seen.set(flake.name, [...(seen.get(flake.name) ?? []), flake]);
  }
  if (seen.size === 0) console.log("No flaky checks.");
  let unfiled = 0;
  for (const [name, flakes] of seen) {
    const each = flakes.map((flake) => `On ${flake.where}, it passed on try ${flake.tries}; its failed try said:\n\n${fence(flake.error)}`);
    try {
      fileIssue("flaky", `Flaky: ${name}`, `\`${name}\` failed, then passed on a retry, in ${run()}.\n\n${each.join("\n\n")}\n`);
    } catch (error) {
      unfiled++;
      console.error(`Could not file ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (unfiled > 0) process.exit(1);
} else if (values.label !== undefined && values.title !== undefined && values["body-file"] !== undefined) {
  fileIssue(values.label, values.title, readFileSync(values["body-file"], "utf8"));
} else {
  console.error("usage: node scripts/file-issue.ts --flakes <file> | --label <label> --title <title> --body-file <file>");
  process.exit(2);
}
