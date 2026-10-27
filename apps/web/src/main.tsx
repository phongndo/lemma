import { connect, describeError } from "@lemma/client";
import { preloadPaint } from "@lemma/web/paint";
import { takeToken } from "./lib/token.ts";
import { bundled } from "./bundled.ts";
import { boot } from "./ui/boot.tsx";
import { contractModules } from "./ui/contracts.ts";
import { NewThreadRoute, ThreadRoute } from "@lemma/sessions";
import { SettingsRoute } from "@lemma/settings";
import "./styles.css";

const start = async () => {
  const params = new URLSearchParams(location.search);
  // The last look any plugin painted, so a dark theme does not flash light while the plugins start; `?safe` starts
  // from the system's, whatever the last look was.
  preloadPaint(!params.has("safe"));
  const token = takeToken();
  // The host lists its clients by what they say they are: this page in the desktop app's window, or in a browser.
  const client = "lemmaDesktop" in window ? "desktop" : "web";
  const host = await connect({ url: location.href, token, client });
  // `?safe` runs the app as shipped, ignoring the rows and the plugin directories: the way back from a broken customization.
  // The api for web halves loads only when one needs it, keeping it out of the app's own bundle.
  const api = () => import("./ui/api.ts").then((module) => module.api);
  // The addresses links from outside the page name: the thread routes `lemma open` and deep links use, and settings.
  const appRoutes = [NewThreadRoute, ThreadRoute, SettingsRoute];
  await boot({ host, token, bundled, appRoutes, api, contracts: contractModules, element: document.getElementById("root")!, safe: params.has("safe") });
};

start().catch((error) => {
  // Nothing may be rendered to report it, so say it plainly in the page.
  console.error(error);
  document.getElementById("root")!.textContent = `Lemma could not start: ${describeError(error)}`;
});
