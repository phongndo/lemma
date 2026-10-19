import { describe, expect, it } from "vitest";
import { namespaceKey, rank, terms } from "../src/search.ts";

const browser = "A web browser the agent drives: open pages, read them, click, type, and take screenshots";
const tools = [
  { name: "browser_click", description: "Click one element of the page, by ref from the latest snapshot", context: browser },
  { name: "browser_press", description: "Press a key or chord on an element, or on the page without a target", context: browser },
  { name: "browser_snapshot", description: "The page as an accessibility tree, with a ref on each element to act on", context: browser },
  { name: "mcp__linear__list_issues", description: "List issues", context: "Linear's issue tracker" },
  { name: "bash", description: "Execute a bash command in the current working directory" },
];

describe("searchTools' ranking", () => {
  it("splits names and words at case changes, underscores, and dashes", () => {
    expect(terms("getModelOfType mcp__dev-radius__search")).toEqual(["get", "model", "of", "type", "mcp", "dev", "radius", "search"]);
  });

  it("ranks a word in a tool's name first, unmoved by words the query says in passing or its namespace shares", () => {
    expect(rank(tools, "click a button on the web page")[0]?.name).toBe("browser_click");
    expect(rank(tools, "accessibility tree")[0]?.name).toBe("browser_snapshot");
    expect(rank(tools, "run a shell command").map((tool) => tool.name)).toEqual(["bash"]);
  });

  it("finds a namespace's tools by what the namespace is for", () => {
    expect(rank(tools, "tracker").map((tool) => tool.name)).toEqual(["mcp__linear__list_issues"]);
  });

  it("matches nothing for no words, and a query of only small words by them", () => {
    expect(rank(tools, "  ")).toEqual([]);
    expect(rank(tools, "on").length).toBeGreaterThan(0);
  });

  it("names a namespace the same with - or _ and in any case", () => {
    expect(namespaceKey("MCP__dev-radius")).toBe(namespaceKey("mcp__dev_radius"));
  });
});
