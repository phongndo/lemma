import { describe, expect, it } from "vitest";
import { FILE_GLYPHS } from "../src/lib/file-glyphs.ts";
import { DEFAULT_FILE_TYPE, FILE_EXTENSIONS, FILE_NAMES, fileType, parseFileTypeRules } from "../src/model/file-icons.ts";

const known = (type: string) => Object.hasOwn(FILE_GLYPHS, type);

describe("fileType", () => {
  it("knows a file by its whole name before its extension, whatever the case", () => {
    expect(fileType("package.json")).toBe("npm");
    expect(fileType("apps/web/Dockerfile")).toBe("docker");
    expect(fileType("README.md")).toBe("markdown");
    expect(fileType("flake.lock")).toBe("nix");
    expect(fileType("LICENSE")).toBe("text");
  });

  it("tries extensions from the longest", () => {
    expect(fileType("src/app.ts")).toBe("typescript");
    expect(fileType("src/App.TSX")).toBe("react");
    expect(fileType("styles/site.scss")).toBe("sass");
    expect(fileType("flake.nix")).toBe("nix");
    expect(fileType("Cargo.toml")).toBe("rust");
    expect(fileType("pyproject.toml")).toBe("toml");
    expect(fileType(".env.local")).toBe("text");
  });

  it("falls back to the default for an unknown type or none, never to an inherited key", () => {
    expect(fileType("notes.xyz")).toBe(DEFAULT_FILE_TYPE);
    expect(fileType("Makefile")).toBe(DEFAULT_FILE_TYPE);
    expect(fileType("constructor")).toBe(DEFAULT_FILE_TYPE);
    expect(fileType("__proto__")).toBe(DEFAULT_FILE_TYPE);
    expect(fileType("a.tostring")).toBe(DEFAULT_FILE_TYPE);
  });

  it("reads a Windows path's file name", () => {
    expect(fileType("C:\\repo\\package.json")).toBe("npm");
    expect(fileType("C:\\repo\\src\\App.tsx")).toBe("react");
  });

  it("draws every type the tables name", () => {
    const missing = [...new Set([...Object.values(FILE_NAMES), ...Object.values(FILE_EXTENSIONS), DEFAULT_FILE_TYPE])].filter((type) => !known(type));
    expect(missing).toEqual([]);
  });
});

describe("parseFileTypeRules", () => {
  it("reads extensions and names, and puts them before the tables", () => {
    const rules = parseFileTypeRules([".mdc = markdown", "*.astro.ts = astro", "Justfile = bash", ".md = text"], known);
    expect(fileType("rules/style.mdc", rules)).toBe("markdown");
    expect(fileType("site.astro.ts", rules)).toBe("astro");
    expect(fileType("justfile", rules)).toBe("bash");
    expect(fileType("README.md", rules)).toBe("text");
  });

  it("skips lines without `=` or naming a type it cannot draw", () => {
    expect(parseFileTypeRules(["nonsense", ".foo = no-such-icon", " = rust", ".bar = constructor"], known)).toEqual({ names: {}, extensions: {} });
  });
});
