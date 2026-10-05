// The fixture over stdio. FIXTURE_ERA=legacy offers only the 2025 protocol; FIXTURE_NOISY=1 writes a line that is
// not a message to stdout first.
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { makeFixture } from "./fixture.ts";

if (process.env["FIXTURE_NOISY"] === "1") process.stdout.write("fixture: hello from stdout\n");
process.stderr.write(
  `fixture: started in ${process.cwd()}${process.env["FIXTURE_SECRET"] === undefined ? "" : ` with secret ${process.env["FIXTURE_SECRET"]}`}\n`,
);
await makeFixture({ legacy: process.env["FIXTURE_ERA"] === "legacy" }).connect(new StdioServerTransport());
