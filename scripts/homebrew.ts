import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { archiveName, releaseTag, repository, targets, version } from "./dist-config.ts";
import type { Target } from "./dist-config.ts";

const directory = resolve(process.argv[2] ?? "dist");
const lines = [
  "class Lemma < Formula",
  '  desc "Extensible coding-agent harness with a web app and CLI"',
  `  homepage "https://github.com/${repository}"`,
  `  version "${version}"`,
  "",
  '  depends_on "git"',
  "",
];
for (const [platform, brewPlatform] of [
  ["darwin", "macos"],
  ["linux", "linux"],
] as const) {
  lines.push(`  on_${brewPlatform} do`);
  for (const [arch, brewArch] of [
    ["arm64", "arm"],
    ["x64", "intel"],
  ] as const) {
    const target: Target = `${platform}-${arch}`;
    if (!(target in targets)) throw new Error(`Unknown target: ${target}`);
    const asset = archiveName(target);
    const checksum = (await readFile(resolve(directory, `${asset}.sha256`), "utf8")).trim();
    const match = /^([0-9a-f]{64})  (\S+)$/.exec(checksum);
    if (match?.[2] !== asset) throw new Error(`Invalid checksum for ${asset}`);
    lines.push(
      `    on_${brewArch} do`,
      `      url "https://github.com/${repository}/releases/download/${releaseTag}/${asset}"`,
      `      sha256 "${match[1]}"`,
      "    end",
    );
  }
  lines.push("  end", "");
}
lines.push(
  "  def install",
  '    libexec.install Dir["*"]',
  '    bin.install_symlink libexec/"bin/lemma"',
  "  end",
  "",
  "  test do",
  '    assert_match "lemma #{version}", shell_output("#{bin}/lemma --version")',
  '    assert_match "Usage: lemma", shell_output("#{bin}/lemma --help")',
  "  end",
  "end",
  "",
);
await writeFile(resolve(directory, "lemma.rb"), lines.join("\n"));
console.log(resolve(directory, "lemma.rb"));
