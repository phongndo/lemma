/**
 * Which icon a file gets: its type, by its whole name first (`package.json`,
 * `Dockerfile`), then by its extensions from the longest (`d.ts`, then `ts`).
 * The tables are Pierre's (`@pierre/trees`, Apache-2.0; see `lib/file-glyphs.ts`),
 * with T3 Code's additions and lemma's own (Nix, TOML, pnpm, Cargo, Go modules).
 * Pure: the `file-icons` plugin draws what this picks.
 */

/** Lower-case file names, and the type each gets. */
export const FILE_NAMES: Readonly<Record<string, string>> = {
  ".babelrc": "babel",
  ".babelrc.json": "babel",
  ".bash_profile": "bash",
  ".bashrc": "bash",
  ".browserslistrc": "browserslist",
  ".dockerignore": "docker",
  ".eslintignore": "eslint",
  ".eslintrc": "eslint",
  ".eslintrc.cjs": "eslint",
  ".eslintrc.js": "eslint",
  ".eslintrc.json": "eslint",
  ".eslintrc.yaml": "eslint",
  ".eslintrc.yml": "eslint",
  ".gitattributes": "git",
  ".gitignore": "git",
  ".gitkeep": "git",
  ".gitmodules": "git",
  ".npmrc": "npm",
  ".oxlintrc.json": "oxc",
  ".postcssrc": "postcss",
  ".postcssrc.json": "postcss",
  ".postcssrc.yaml": "postcss",
  ".postcssrc.yml": "postcss",
  ".prettierignore": "prettier",
  ".prettierrc": "prettier",
  ".prettierrc.cjs": "prettier",
  ".prettierrc.js": "prettier",
  ".prettierrc.json": "prettier",
  ".prettierrc.mjs": "prettier",
  ".prettierrc.toml": "prettier",
  ".prettierrc.yaml": "prettier",
  ".prettierrc.yml": "prettier",
  ".stylelintignore": "stylelint",
  ".stylelintrc": "stylelint",
  ".stylelintrc.cjs": "stylelint",
  ".stylelintrc.js": "stylelint",
  ".stylelintrc.json": "stylelint",
  ".stylelintrc.mjs": "stylelint",
  ".stylelintrc.yaml": "stylelint",
  ".stylelintrc.yml": "stylelint",
  ".terraform.lock.hcl": "terraform",
  ".zprofile": "bash",
  ".zshenv": "bash",
  ".zshrc": "bash",
  "agents.md": "markdown",
  authors: "text",
  "babel.config.cjs": "babel",
  "babel.config.js": "babel",
  "babel.config.json": "babel",
  "babel.config.mjs": "babel",
  "biome.json": "biome",
  "biome.jsonc": "biome",
  "bootstrap.bundle.js": "bootstrap",
  "bootstrap.bundle.min.js": "bootstrap",
  "bootstrap.css": "bootstrap",
  "bootstrap.js": "bootstrap",
  "bootstrap.min.css": "bootstrap",
  "bootstrap.min.js": "bootstrap",
  "bun.lock": "bun",
  "bun.lockb": "bun",
  "bunfig.toml": "bun",
  "cargo.lock": "rust",
  "cargo.toml": "rust",
  changelog: "text",
  "claude.md": "claude",
  "compose.yaml": "docker",
  "compose.yml": "docker",
  contributors: "text",
  "docker-compose.override.yml": "docker",
  "docker-compose.yaml": "docker",
  "docker-compose.yml": "docker",
  dockerfile: "docker",
  "eslint.config.cjs": "eslint",
  "eslint.config.js": "eslint",
  "eslint.config.mjs": "eslint",
  "eslint.config.mts": "eslint",
  "eslint.config.ts": "eslint",
  "flake.lock": "nix",
  gemfile: "ruby",
  "go.mod": "go",
  "go.sum": "go",
  license: "text",
  "next.config.js": "nextjs",
  "next.config.mjs": "nextjs",
  "next.config.mts": "nextjs",
  "next.config.ts": "nextjs",
  "package-lock.json": "npm",
  "package.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "pnpm-workspace.yaml": "pnpm",
  "postcss.config.cjs": "postcss",
  "postcss.config.js": "postcss",
  "postcss.config.mjs": "postcss",
  "postcss.config.ts": "postcss",
  "prettier.config.cjs": "prettier",
  "prettier.config.js": "prettier",
  "prettier.config.mjs": "prettier",
  rakefile: "ruby",
  "readme.md": "markdown",
  "stylelint.config.cjs": "stylelint",
  "stylelint.config.js": "stylelint",
  "stylelint.config.mjs": "stylelint",
  "svgo.config.cjs": "svgo",
  "svgo.config.js": "svgo",
  "svgo.config.mjs": "svgo",
  "svgo.config.ts": "svgo",
  "tailwind.config.cjs": "tailwind",
  "tailwind.config.js": "tailwind",
  "tailwind.config.mjs": "tailwind",
  "tailwind.config.ts": "tailwind",
  "tsconfig.json": "typescript",
  "vite.config.js": "vite",
  "vite.config.mjs": "vite",
  "vite.config.mts": "vite",
  "vite.config.ts": "vite",
  "webpack.config.babel.js": "webpack",
  "webpack.config.cjs": "webpack",
  "webpack.config.js": "webpack",
  "webpack.config.mjs": "webpack",
  "webpack.config.ts": "webpack",
};

/** Lower-case extensions without their dot, and the type each gets. */
export const FILE_EXTENSIONS: Readonly<Record<string, string>> = {
  "7z": "zip",
  astro: "astro",
  avif: "image",
  bash: "bash",
  bmp: "image",
  bz2: "zip",
  c: "c",
  cc: "cpp",
  cfg: "text",
  cjs: "javascript",
  "code-workspace": "vscode",
  conf: "text",
  cpp: "cpp",
  csh: "bash",
  css: "css",
  csv: "table",
  cts: "typescript",
  cxx: "cpp",
  db: "database",
  editorconfig: "text",
  env: "text",
  "env.development": "text",
  "env.local": "text",
  "env.production": "text",
  eot: "font",
  erb: "ruby",
  fish: "bash",
  gemspec: "ruby",
  gif: "image",
  go: "go",
  gql: "graphql",
  graphql: "graphql",
  gz: "zip",
  h: "c",
  hh: "cpp",
  hpp: "cpp",
  htm: "html",
  html: "html",
  hxx: "cpp",
  icns: "image",
  ico: "image",
  ini: "text",
  inl: "cpp",
  jar: "zip",
  jpeg: "image",
  jpg: "image",
  js: "javascript",
  json: "json",
  json5: "json",
  jsonc: "json",
  jsonl: "json",
  jsx: "react",
  ksh: "bash",
  less: "css",
  log: "text",
  markdown: "markdown",
  mcp: "mcp",
  md: "markdown",
  mdx: "markdown",
  "mdx.tsx": "markdown",
  mjs: "javascript",
  mm: "cpp",
  mts: "typescript",
  nix: "nix",
  ods: "table",
  otf: "font",
  png: "image",
  postcss: "css",
  py: "python",
  pyi: "python",
  pyw: "python",
  pyx: "python",
  rake: "ruby",
  rar: "zip",
  rb: "ruby",
  rs: "rust",
  rst: "text",
  rtf: "text",
  sass: "sass",
  scss: "sass",
  sh: "bash",
  sql: "database",
  sqlite: "database",
  sqlite3: "database",
  styl: "css",
  svelte: "svelte",
  svg: "svg",
  swift: "swift",
  tar: "zip",
  tf: "terraform",
  tfstate: "terraform",
  tfvars: "terraform",
  tgz: "zip",
  tif: "image",
  tiff: "image",
  toml: "toml",
  ts: "typescript",
  tsv: "table",
  tsx: "react",
  ttf: "font",
  txt: "text",
  vue: "vue",
  war: "zip",
  wasm: "wasm",
  wast: "wasm",
  wat: "wasm",
  webp: "image",
  woff: "font",
  woff2: "font",
  xhtml: "html",
  xls: "table",
  xlsx: "table",
  xz: "zip",
  yaml: "yml",
  yml: "yml",
  zig: "zig",
  zip: "zip",
  zsh: "bash",
};

/** A file with no known type. */
export const DEFAULT_FILE_TYPE = "default";

/** A user's own matches, consulted before the tables (all of them, so `.md = text` covers `README.md` too): by lower-case name, and by extension. */
export interface FileTypeRules {
  readonly names: Readonly<Record<string, string>>;
  readonly extensions: Readonly<Record<string, string>>;
}

export const NO_RULES: FileTypeRules = { names: {}, extensions: {} };

/**
 * Rules from config lines: `.mdc = markdown` (or `*.mdc`) matches an
 * extension, `Justfile = bash` a whole name. A line without `=`, or naming a
 * type `known` rejects, is skipped.
 */
export const parseFileTypeRules = (lines: readonly string[], known: (type: string) => boolean): FileTypeRules => {
  const names: Record<string, string> = {};
  const extensions: Record<string, string> = {};
  for (const line of lines) {
    const at = line.indexOf("=");
    if (at === -1) continue;
    const pattern = line.slice(0, at).trim().toLowerCase();
    const type = line
      .slice(at + 1)
      .trim()
      .toLowerCase();
    if (pattern === "" || !known(type)) continue;
    const extension = /^\*?\.(.+)$/.exec(pattern)?.[1];
    if (extension !== undefined) extensions[extension] = type;
    else names[pattern] = type;
  }
  return { names, extensions };
};

/** A table's own entry: never one inherited from `Object.prototype` (`constructor`, `__proto__`). */
const own = (table: Readonly<Record<string, string>>, key: string): string | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

const match = (name: string, extensions: readonly string[], names: Readonly<Record<string, string>>, byExtension: Readonly<Record<string, string>>) =>
  own(names, name) ?? extensions.map((extension) => own(byExtension, extension)).find((type) => type !== undefined);

/** A path's file type: the rules' match (by name, then extension), else the tables', else `DEFAULT_FILE_TYPE`. */
export const fileType = (path: string, rules: FileTypeRules = NO_RULES): string => {
  // Either separator: a tool call's path on a Windows host has backslashes.
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1).toLowerCase();
  // `a.d.ts` → `d.ts`, `ts`: the longest first, so a compound extension can have its own type.
  const segments = name.split(".");
  const extensions = segments.slice(1).map((_, index) => segments.slice(index + 1).join("."));
  return match(name, extensions, rules.names, rules.extensions) ?? match(name, extensions, FILE_NAMES, FILE_EXTENSIONS) ?? DEFAULT_FILE_TYPE;
};
