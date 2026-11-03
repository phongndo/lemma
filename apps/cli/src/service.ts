import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { buildKind } from "@lemma/host/paths";

/** The OS's service manager for the user, which keeps a host running for `lemma service`: systemd on Linux, launchd on macOS. */
export interface ServiceManager {
  readonly name: string;
  /** Where its definition goes. */
  readonly file: string;
  readonly render: (command: readonly string[], env: Readonly<Record<string, string>>, log: string) => string;
  readonly install: (start: boolean) => readonly string[];
  /** Stops the service and removes its definition. */
  readonly uninstall: () => void;
  readonly stop: () => void;
  /** Stops the host it runs and starts it again, from its definition; what went wrong, if anything. */
  readonly restart: () => readonly string[];
  readonly status: () => { readonly installed: boolean; readonly enabled: boolean; readonly active: boolean };
}

/**
 * The service's names, one per profile and kind, so an installed Lemma's and a checkout's never replace or stop each
 * other: a release's default is `lemma` (launchd's `dev.lemma.host`), another profile's `lemma-<profile>`
 * (`dev.lemma.host.<profile>`); a checkout's `dev-lemma` (`dev.lemma.dev-host`) and `dev-lemma-<profile>`, which no
 * release's name can be.
 */
const NAMES = { release: { unit: "lemma", label: "dev.lemma.host" }, checkout: { unit: "dev-lemma", label: "dev.lemma.dev-host" } }[buildKind];
const unitOf = (profile: string | undefined) => `${profile === undefined ? NAMES.unit : `${NAMES.unit}-${profile}`}.service`;
const labelOf = (profile: string | undefined) => (profile === undefined ? NAMES.label : `${NAMES.label}.${profile}`);

const run = (command: string, args: readonly string[]) => spawnSync(command, args, { encoding: "utf8" });

/** A word for systemd's command line: quoted when it has to be. */
const systemdWord = (word: string) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `"${word.replace(/(["\\])/g, "\\$1")}"`);

const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The service manager's view of the service for `profile` (the default's when undefined). */
export const serviceManager = (profile?: string): ServiceManager | undefined => {
  if (process.platform === "linux") {
    const unit = unitOf(profile);
    const file = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user", unit);
    const systemctl = (...args: string[]) => run("systemctl", ["--user", ...args]);
    return {
      name: "systemd",
      file,
      render: (command, env) =>
        [
          "[Unit]",
          `Description=Lemma host${buildKind === "checkout" ? " from a checkout" : ""}${profile === undefined ? "" : ` (profile ${profile})`}`,
          "",
          "[Service]",
          "WorkingDirectory=%h",
          ...Object.entries(env).map(([key, value]) => `Environment=${systemdWord(`${key}=${value}`)}`),
          `ExecStart=${command.map(systemdWord).join(" ")}`,
          "Restart=on-failure",
          "RestartSec=2",
          "",
          "[Install]",
          "WantedBy=default.target",
          "",
        ].join("\n"),
      install: (start) => {
        const said: string[] = [];
        for (const args of [["daemon-reload"], start ? ["enable", "--now", unit] : ["enable", unit]]) {
          const result = systemctl(...args);
          if (result.status !== 0) said.push(`systemctl --user ${args.join(" ")}: ${(result.stderr || result.error?.message || "failed").trim()}`);
        }
        return said;
      },
      uninstall: () => {
        systemctl("disable", "--now", unit);
        rmSync(file, { force: true });
        systemctl("daemon-reload");
      },
      stop: () => {
        systemctl("stop", unit);
      },
      restart: () => {
        const result = systemctl("restart", unit);
        return result.status === 0 ? [] : [`systemctl --user restart ${unit}: ${(result.stderr || result.error?.message || "failed").trim()}`];
      },
      status: () => ({
        installed: existsSync(file),
        enabled: systemctl("is-enabled", unit).stdout.trim() === "enabled",
        active: systemctl("is-active", unit).stdout.trim() === "active",
      }),
    };
  }
  if (process.platform === "darwin") {
    const label = labelOf(profile);
    const file = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
    const domain = `gui/${userInfo().uid}`;
    return {
      name: "launchd",
      file,
      render: (command, env, log) =>
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
          '<plist version="1.0">',
          "<dict>",
          `  <key>Label</key><string>${label}</string>`,
          `  <key>WorkingDirectory</key><string>${xml(homedir())}</string>`,
          "  <key>ProgramArguments</key>",
          "  <array>",
          ...command.map((word) => `    <string>${xml(word)}</string>`),
          "  </array>",
          "  <key>EnvironmentVariables</key>",
          "  <dict>",
          ...Object.entries(env).map(([key, value]) => `    <key>${xml(key)}</key><string>${xml(value)}</string>`),
          "  </dict>",
          "  <key>RunAtLoad</key><true/>",
          "  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
          // What it prints before its own log is open, a failure to start among it.
          `  <key>StandardOutPath</key><string>${xml(log)}</string>`,
          `  <key>StandardErrorPath</key><string>${xml(log)}</string>`,
          "</dict>",
          "</plist>",
          "",
        ].join("\n"),
      install: (start) => {
        if (!start) return [];
        run("launchctl", ["bootout", `${domain}/${label}`]);
        const result = run("launchctl", ["bootstrap", domain, file]);
        return result.status === 0 ? [] : [`launchctl bootstrap ${domain} ${file}: ${(result.stderr || "failed").trim()}`];
      },
      uninstall: () => {
        run("launchctl", ["bootout", `${domain}/${label}`]);
        rmSync(file, { force: true });
      },
      stop: () => {
        // KeepAlive restarts only an unsuccessful exit: a host stopped by SIGTERM exits cleanly and stays down.
        run("launchctl", ["kill", "SIGTERM", `${domain}/${label}`]);
      },
      restart: () => {
        const result = run("launchctl", ["kickstart", "-k", `${domain}/${label}`]);
        return result.status === 0 ? [] : [`launchctl kickstart -k ${domain}/${label}: ${(result.stderr || "failed").trim()}`];
      },
      status: () => {
        const loaded = run("launchctl", ["print", `${domain}/${label}`]);
        return { installed: existsSync(file), enabled: loaded.status === 0, active: loaded.status === 0 && /state = running/.test(loaded.stdout) };
      },
    };
  }
  return undefined;
};
