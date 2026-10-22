import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Arch, build, Platform } from "electron-builder";
import type { AfterPackContext, Configuration } from "electron-builder";
import { desktopPackageName, hostTarget, packageName, parsePackageName, version } from "./dist-config.ts";
import type { Target } from "./dist-config.ts";

/*
 * Builds the desktop app of a release into `dist/`: Electron with the release's archive (scripts/dist.ts) inside it, so
 * the app runs the same files as the `lemma` command and is the same version (docs/installation.md#the-desktop-app):
 *
 *   lemma-desktop-v<version>-darwin-arm64.dmg        macOS, signed ad hoc until there is a Developer ID to sign with
 *   lemma-desktop-v<version>-linux-<arch>.AppImage   Linux, to run as it is
 *   lemma-desktop-v<version>-linux-<arch>.deb        Debian and Ubuntu, installed with apt
 *
 * each with its `.sha256`. In the app, the archive is `lemma/` among Electron's resources (`process.resourcesPath`), and
 * the app's own code is a module that loads the desktop app's main process from it (apps/desktop/src/main.ts).
 *
 *   pnpm dist:desktop                                         this machine's, from dist/'s archive at the checkout's version
 *   pnpm dist:desktop dist/lemma-v0.2.7-linux-arm64.tar.gz    each archive named, as the nightly workflow builds them
 *
 * A macOS app is built on macOS, which makes its disk image; Linux builds either architecture's, as nothing compiles.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const output = join(root, "dist");
const archives = (
  process.argv.length > 2 ? process.argv.slice(2).map((path) => resolve(path)) : [join(output, `${packageName(version, hostTarget())}.tar.gz`)]
).map((archive) => {
  const named = parsePackageName(basename(archive));
  if (named === undefined) throw new Error(`${basename(archive)} is not named as a release archive, lemma-v<version>-<target>.tar.gz`);
  const [os, cpu] = named.target.split("-") as ["darwin" | "linux", "arm64" | "x64"];
  if (os !== process.platform) throw new Error(`The desktop app for ${named.target} is built on ${os === "darwin" ? "macOS" : "Linux"}`);
  if (!existsSync(archive)) throw new Error(`No archive ${relative(process.cwd(), archive)}: \`pnpm dist\` builds it`);
  return { archive, release: named.version, target: named.target, os, cpu };
});
const electronVersion = (JSON.parse(await readFile(join(root, "apps/desktop/package.json"), "utf8")) as { devDependencies: { electron: string } })
  .devDependencies.electron;

/** The formats each platform's app comes in: macOS's disk image, and Linux's AppImage and Debian package. */
const formats = { darwin: ["dmg"], linux: ["AppImage", "deb"] } as const;

const configuration = (release: string, target: Target, app: string, out: string, archive: string, icons: string): Configuration => ({
  appId: "com.phongndo.lemma",
  productName: "Lemma",
  copyright: "Copyright © Phong Do",
  electronVersion,
  directories: { app, output: out },
  artifactName: `${desktopPackageName(release, target)}.\${ext}`,
  icon: join(root, "assets/brand/icon-dark.png"),
  // The app's code is the loader below; what it loads is the archive, whose packages are installed for the target.
  npmRebuild: false,
  nodeGypRebuild: false,
  publish: null,
  // The scheme the app opens (`DEEP_LINK_SCHEME` in @lemma/contracts): macOS reads it from the app's Info.plist, Linux
  // from its desktop entry.
  protocols: [{ name: "Lemma", schemes: ["lemma"] }],
  // Before the app is signed, so its signature covers the archive's files too.
  afterPack: async (context: AfterPackContext) => {
    const resources =
      context.electronPlatformName === "darwin"
        ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
        : join(context.appOutDir, "resources");
    // tar keeps the archive's links as they are: pnpm's, relative, within it.
    execFileSync("tar", ["-xzf", archive, "-C", resources], { stdio: "inherit" });
    await rename(join(resources, packageName(release, target)), join(resources, "lemma"));
  },
  mac: {
    target: [...formats.darwin],
    category: "public.app-category.developer-tools",
    // Ad hoc: a signature of no one, which Apple silicon requires of every app. A Developer ID's would let the app open
    // without Gatekeeper's "Open Anyway", and is needed with the hardened runtime and notarization.
    identity: "-",
    hardenedRuntime: false,
  },
  dmg: { title: `Lemma ${release}` },
  linux: {
    target: [...formats.linux],
    // Not `lemma`: the Debian package links its executable into /usr/bin, where that is the command's name.
    executableName: "lemma-desktop",
    syncDesktopName: true,
    category: "Development",
    synopsis: "An agent harness in which every part is a plugin",
    maintainer: "Phong Do <me@phongndo.com>",
    // A directory with the icon as `icon.png`, from which electron-builder makes the sizes a desktop looks an icon up
    // in, 16 to 512 pixels; the icon itself would be installed at its own size, 1254, where none looks.
    icon: icons,
  },
  deb: {
    // electron-builder's, and the two libraries Electron loads that they leave out: Mesa's buffer allocation and ALSA.
    // Ubuntu 24.04's `t64` packages provide those of them it renamed.
    depends: ["libgtk-3-0", "libnotify4", "libnss3", "libxss1", "libxtst6", "xdg-utils", "libatspi2.0-0", "libuuid1", "libsecret-1-0", "libgbm1", "libasound2"],
  },
  // The AppImage runtime that needs no libfuse2, which recent distributions leave out.
  toolsets: { appimage: "1.0.3" },
});

const temporary = await mkdtemp(join(tmpdir(), "lemma-dist-desktop-"));
try {
  await mkdir(output, { recursive: true });
  const icons = join(temporary, "icons");
  await mkdir(icons);
  await copyFile(join(root, "assets/brand/icon-dark.png"), join(icons, "icon.png"));
  for (const { archive, release, target, os, cpu } of archives) {
    // The app's own code: what Electron starts, which loads the desktop app from the archive among its resources.
    const app = join(temporary, target, "app");
    await mkdir(app, { recursive: true });
    await writeFile(
      join(app, "package.json"),
      `${JSON.stringify(
        {
          name: "lemma-desktop",
          productName: "Lemma",
          version: release,
          description: "Lemma's web app in a desktop window, with the host and the lemma command it runs",
          author: { name: "Phong Do", email: "me@phongndo.com" },
          homepage: "https://github.com/phongndo/lemma",
          license: "MIT",
          // Its desktop entry (`<executableName>.desktop`), which Linux matches its windows and its `lemma://` links to.
          desktopName: "lemma-desktop.desktop",
          type: "module",
          main: "main.js",
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(app, "main.js"),
      `// The desktop app's main process, from the release it carries (scripts/dist-desktop.ts).
import { join } from "node:path";
import { pathToFileURL } from "node:url";

await import(pathToFileURL(join(process.resourcesPath, "lemma", "apps", "desktop", "src", "main.ts")).href);
`,
    );

    const out = join(temporary, target, "out");
    const platform = os === "darwin" ? Platform.MAC : Platform.LINUX;
    await build({
      targets: platform.createTarget([...formats[os]], cpu === "arm64" ? Arch.arm64 : Arch.x64),
      config: configuration(release, target, app, out, archive, icons),
      publish: "never",
    });

    for (const format of formats[os]) {
      const name = `${desktopPackageName(release, target)}.${format}`;
      const file = join(output, name);
      await copyFile(join(out, name), file);
      const checksum = createHash("sha256")
        .update(await readFile(file))
        .digest("hex");
      await writeFile(`${file}.sha256`, `${checksum}  ${name}\n`);
      console.log(`Built ${relative(root, file)}`);
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
