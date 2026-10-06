import { beforeEach } from "vitest";
import { run } from "../src/cli.ts";

/** Runs the CLI in-process against `home`, collecting what it writes. */
export const invoke = async (argv: readonly string[], home: string, cwd = "/", env: Readonly<Record<string, string>> = {}) => {
  let out = "";
  const err: string[] = [];
  const code = await run(argv, {
    env: { LEMMA_HOME: home, ...env },
    cwd,
    out: (text) => {
      out += `${text}\n`;
    },
    write: (text) => {
      out += text;
    },
    err: (text) => err.push(text),
  });
  return { code, out: out.replace(/\n$/, ""), err: err.join("\n") };
};

/** A failing test prints `output()`: what went wrong in a host shows only in what it printed. */
export const printOnFailure = (output: () => string | undefined) =>
  beforeEach(({ onTestFailed }) => {
    onTestFailed(() => {
      const printed = output();
      if (printed !== undefined) console.error(printed);
    });
  });
