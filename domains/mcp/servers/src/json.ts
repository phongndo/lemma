import { readFile } from "node:fs/promises";
import { Predicate } from "effect";
import { errorMessage } from "@lemma/contracts";
import { errorCode } from "@lemma/contracts/fs";

/**
 * The JSON object in a file this plugin reads and writes (`mcp.json`, `mcp-auth.json`): `{}` for a missing or blank
 * file. Throws, saying why, for one it cannot read, that is not JSON, or that is not an object.
 */
export async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return {};
    throw new Error(`Could not read the file: ${errorMessage(cause)}`, { cause });
  }
  let json: unknown;
  try {
    json = text.trim() === "" ? {} : JSON.parse(text);
  } catch (cause) {
    throw new Error(`The file is not valid JSON: ${errorMessage(cause)}`, { cause });
  }
  if (!Predicate.isObject(json)) throw new Error("The file is not a JSON object");
  return json;
}
