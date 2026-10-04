import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * This installation's stable ID (pi-ai's device ID), kept in `<home>/device-id` and made on first use. OpenAI's
 * ChatGPT sign-in names the installation by it, so every later login must send the same one.
 */
export function deviceId(home: string): string {
  const path = join(home, "device-id");
  const stored = (): string | undefined => {
    try {
      const id = readFileSync(path, "utf8").trim();
      return UUID.test(id) ? id : undefined;
    } catch {
      return undefined;
    }
  };
  const create = (flag: "wx" | "w") => {
    const id = randomUUID();
    writeFileSync(path, `${id}\n`, { flag, mode: 0o600 });
    return id;
  };
  const found = stored();
  if (found !== undefined) return found;
  mkdirSync(home, { recursive: true });
  try {
    // Exclusive: when two processes race, both keep the ID the first one wrote.
    return create("wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Written meanwhile, or holding something that is not an ID, which a new one replaces.
    return stored() ?? create("w");
  }
}
