// The worker's side of an isolate (isolate.ts): loads the tools module it is given, lists its tools, and runs one per
// message. It imports nothing but Node's own, so it starts fast and shares nothing with the host.
import { parentPort, workerData } from "node:worker_threads";

const tools = (await import(workerData.module)).default;

parentPort.on("message", async ({ id, type, name, input }) => {
  try {
    if (type === "list") {
      parentPort.postMessage({ id, value: tools.map(({ name, description, parameters }) => ({ name, description, parameters })) });
      return;
    }
    const tool = tools.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`No tool named ${name}`);
    const out = await tool.execute(input);
    parentPort.postMessage({ id, value: typeof out === "string" ? out : JSON.stringify(out) });
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
