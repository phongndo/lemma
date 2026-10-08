// First, so Effect finds it when it loads (see the file).
import "./lib/immediate.ts";
import { connect, describeError } from "@lemma/client";
import { preloadPaint } from "./lib/paint.ts";
import { takeToken } from "./lib/token.ts";
import { bundled } from "./plugins/index.ts";
import { boot } from "./ui/boot.tsx";
import { NewThreadRoute, SettingsRoute, ThreadRoute } from "./ui/contracts.ts";
import type { HostConnection } from "./ui/runtime.ts";
import "./styles.css";

const start = async () => {
  const params = new URLSearchParams(location.search);
  // The last look any plugin painted, so a dark theme does not flash light while the plugins start; `?safe` starts
  // from the system's, whatever the last look was.
  preloadPaint(!params.has("safe"));
  const token = takeToken();
  let host: HostConnection;
  // `?mock` in dev runs against an in-browser fake host (no backend needed).
  if (import.meta.env.DEV && params.has("mock")) {
    const { createMockHost } = await import("./mock.ts");
    host = createMockHost();
  } else {
    host = await connect({ url: location.href, token });
  }
  // `?safe` runs the app as shipped, ignoring `ui` rows and UI files: the way back from a broken customization.
  // The api for UI files loads only when one needs it, keeping it out of the app's own bundle.
  const api = () => import("./ui/api.ts").then((module) => module.api);
  // The addresses links from outside the page name: the thread routes `lemma open` and deep links use, and settings.
  const appRoutes = [NewThreadRoute, ThreadRoute, SettingsRoute];
  await boot({ host, token, bundled, appRoutes, api, element: document.getElementById("root")!, safe: params.has("safe") });
};

start().catch((error) => {
  // Nothing may be rendered to report it, so say it plainly in the page.
  console.error(error);
  document.getElementById("root")!.textContent = `Lemma could not start: ${describeError(error)}`;
});
