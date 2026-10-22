import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { desktopPackageName, packageName } from "./dist-config.ts";
import type { Target } from "./dist-config.ts";

/*
 * The Homebrew tap's formula and cask for a release (docs/installation.md#homebrew): `lemma.rb`, the `lemma` command
 * from each platform's archive, and `lemma-cask.rb`, the desktop app from macOS's disk image, which links the `lemma`
 * inside it. The nightly workflow attaches both to each release, made from its checksums, and the tap
 * (phongndo/homebrew-tap) takes them up from each stable one; it also installs both from its own files before
 * publishing (`--base-url file://…`).
 *
 *   node scripts/homebrew.ts --version 0.2.7                              both, from dist/'s checksums, into dist/
 *   node scripts/homebrew.ts --version 0.2.7 --base-url file://$PWD/dist  the files where they are, as CI installs them
 *     --formula <path> --cask <path>                                      what is named alone, where it says
 */

const DESC = "Agent harness in which every part is a plugin";
const HOMEPAGE = "https://github.com/phongndo/lemma";

/** Where a release's files are: GitHub's release, or `base` (a directory's `file://` URL, as CI tests them). */
const releaseUrl = (version: string, base?: string) => base ?? `${HOMEPAGE}/releases/download/v${version}`;

/** The SHA-256 a `.sha256` file beside a release's file says, for `name`. */
export const checksumOf = (sums: string, name: string): string => {
  const line = sums.split("\n").find((entry) => entry.trim().split(/\s+/)[1] === name);
  const hex = line?.trim().split(/\s+/)[0];
  if (hex === undefined || !/^[0-9a-f]{64}$/.test(hex)) throw new Error(`No SHA-256 for ${name}`);
  return hex;
};

/**
 * The formula: each platform's archive in `libexec`, with what installed it (`install.json`, which `lemma update`
 * reads to update with brew), and `bin/lemma` linked to its command.
 */
export const formula = (version: string, sha256: Readonly<Record<Target, string>>, base?: string): string => {
  const url = (target: Target) => `${releaseUrl(version, base)}/${packageName(version, target)}.tar.gz`;
  return `class Lemma < Formula
  desc "${DESC}"
  homepage "${HOMEPAGE}"
  version "${version}"
  license "MIT"

  on_macos do
    depends_on arch: :arm64
    depends_on macos: :ventura

    on_arm do
      url "${url("darwin-arm64")}"
      sha256 "${sha256["darwin-arm64"]}"
    end
  end

  on_linux do
    on_arm do
      url "${url("linux-arm64")}"
      sha256 "${sha256["linux-arm64"]}"
    end

    on_intel do
      url "${url("linux-x64")}"
      sha256 "${sha256["linux-x64"]}"
    end
  end

  def install
    libexec.install Dir["*"]
    # What installed it: lemma update updates it with brew, and runs the lemma Homebrew links.
    (libexec/"install.json").write <<~JSON
      {"installer": "homebrew", "link": "#{HOMEBREW_PREFIX}/bin/lemma", "manager": "#{HOMEBREW_PREFIX}/bin/brew"}
    JSON
    bin.install_symlink libexec/"bin/lemma"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/lemma --version")
    assert_match '"installer": "homebrew"', shell_output("#{bin}/lemma version --json")
  end
end
`;
};

/**
 * The cask: the desktop app from macOS's disk image, and the `lemma` inside it on PATH, so the app and the command are
 * one release. `lemma update` finds the cask by its Caskroom and updates both with brew.
 */
export const cask = (version: string, sha256: string, base?: string): string => {
  const url = base === undefined ? `${HOMEPAGE}/releases/download/v#{version}` : base;
  return `cask "lemma" do
  version "${version}"
  sha256 "${sha256}"

  url "${url}/${desktopPackageName("#{version}", "darwin-arm64")}.dmg"
  name "Lemma"
  desc "${DESC}"
  homepage "${HOMEPAGE}"

  depends_on arch: :arm64
  depends_on macos: :ventura

  app "Lemma.app"
  binary "#{appdir}/Lemma.app/Contents/Resources/lemma/bin/lemma"

  zap trash: [
    "~/Library/Application Support/Lemma",
    "~/Library/Preferences/com.phongndo.lemma.plist",
    "~/Library/Saved Application State/com.phongndo.lemma.savedState",
  ]

  caveats <<~EOS
    Lemma is signed ad hoc, not with an Apple Developer ID, so macOS asks before it
    opens each new version: open System Settings > Privacy & Security, and choose
    Open Anyway beside "Lemma was blocked".
  EOS
end
`;
};

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values } = parseArgs({
    options: {
      version: { type: "string" },
      dist: { type: "string", default: fileURLToPath(new URL("../dist", import.meta.url)) },
      "base-url": { type: "string" },
      formula: { type: "string" },
      cask: { type: "string" },
    },
  });
  const version = values.version;
  if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("--version is a release's version, as 0.2.7");
  const dist = values.dist;
  const sum = async (name: string) => checksumOf(await readFile(join(dist, `${name}.sha256`), "utf8"), name);
  const base = values["base-url"];
  // What is asked for alone (a job with no disk image makes the formula), else both, into dist/.
  const both = values.formula === undefined && values.cask === undefined;
  const formulaFile = values.formula ?? (both ? join(dist, "lemma.rb") : undefined);
  const caskFile = values.cask ?? (both ? join(dist, "lemma-cask.rb") : undefined);
  if (formulaFile !== undefined) {
    const archives = { "darwin-arm64": "", "linux-arm64": "", "linux-x64": "" } as Record<Target, string>;
    for (const target of Object.keys(archives) as Target[]) archives[target] = await sum(`${packageName(version, target)}.tar.gz`);
    await writeFile(formulaFile, formula(version, archives, base));
  }
  if (caskFile !== undefined) await writeFile(caskFile, cask(version, await sum(`${desktopPackageName(version, "darwin-arm64")}.dmg`), base));
  console.log(`Wrote ${[formulaFile, caskFile].filter(Boolean).join(" and ")}`);
}
