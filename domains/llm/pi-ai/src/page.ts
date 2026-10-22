import type { OAuthPage } from "@earendil-works/pi-ai/utils/oauth-page";
import { deepLinkPath } from "@lemma/contracts";

/**
 * The page a browser is shown when a sign-in sends it back to the host: Lemma's, in place of pi's (through Lemma's
 * patch of pi-ai, `setOAuthPageRenderer`). It has Lemma's mark and the web app's default look (`apps/web/src/styles.css`'s
 * tokens, light or dark as the browser is). The provider sent the browser back with a code, which the host has yet to
 * exchange (pi-ai answers some callbacks before it does), so a success says the sign-in was approved and that Lemma
 * finishes it: the app says how it ended. It offers a way back to Lemma, where the client that started the sign-in
 * said where that is. What it says may come from the callback's URL, which any page can send the browser to, so it is
 * escaped; the URL's code is cleared from the address bar, and no referrer is sent from here.
 */

const ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escaped = (text: string) => text.replace(/[&<>"']/g, (char) => ESCAPES[char]!);

/** Lemma's mark, as `apps/web/public/favicon.svg` draws it. */
const MARK = `<svg class="mark" viewBox="-16 -16 664 664" aria-hidden="true"><path d="M42 0H242A42 42 0 0 1 284 42V321A27 27 0 0 0 311 348H590A42 42 0 0 1 632 390V590A42 42 0 0 1 590 632H42A42 42 0 0 1 0 590V42A42 42 0 0 1 42 0Z"/><rect x="314" width="318" height="318" rx="42"/></svg>`;

const CHECK = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>`;
const CROSS = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>`;

// The web app's default tokens, light and dark: its colors, the raised surface of a card, its font and radii.
const STYLE = `:root{--bg:#fafafa;--bg-raised:#fff;--text:#171717;--text-2:#525252;--border:rgba(0,0,0,.09);--ok:#1f8a4c;--ok-soft:rgba(31,138,76,.1);--err:#c43d3d;--err-soft:rgba(196,61,61,.08);--mark:#272828;--button:#171717;--button-text:#fafafa;--shadow:0 1px 2px rgba(0,0,0,.04),0 4px 16px rgba(0,0,0,.06);color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b0b;--bg-raised:#161616;--text:#ececec;--text-2:#a3a3a3;--border:rgba(255,255,255,.08);--ok:#4cc27f;--ok-soft:rgba(76,194,127,.12);--err:#f06d6d;--err-soft:rgba(240,109,109,.1);--mark:#f4f4f4;--button:#ececec;--button-text:#0b0b0b;--shadow:0 1px 2px rgba(0,0,0,.3),0 4px 16px rgba(0,0,0,.3)}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--text);font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{width:100%;max-width:380px;padding:32px 28px 28px;background:var(--bg-raised);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow);text-align:center}
.mark{display:block;width:36px;height:36px;margin:0 auto 24px}
.mark path,.mark rect{fill:var(--mark)}
.badge{display:inline-flex;align-items:center;gap:6px;padding:3px 10px 3px 8px;margin-bottom:14px;border-radius:999px;font-size:12px;font-weight:600;color:var(--ok);background:var(--ok-soft)}
.failed .badge{color:var(--err);background:var(--err-soft)}
.badge svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
h1{margin:0 0 6px;font-size:18px;font-weight:600;letter-spacing:-.01em}
p{margin:0;color:var(--text-2);overflow-wrap:anywhere}
p+p{margin-top:8px}
.back{display:inline-block;margin-top:20px;padding:7px 14px;border-radius:8px;background:var(--button);color:var(--button-text);font-weight:600;text-decoration:none}`;

/** Where a sign-in's page may offer to go back to: the client's own page, or the desktop app (`lemma://`, `lemma-dev://`). */
export const safeReturn = (returnTo: string | undefined): string | undefined => {
  if (returnTo === undefined) return undefined;
  try {
    const url = new URL(returnTo);
    return ["http:", "https:"].includes(url.protocol) || deepLinkPath(url.href) !== undefined ? url.href : undefined;
  } catch {
    return undefined;
  }
};

/** What the page knows of the sign-in it ends: the provider's name, and where the client said to go back to. */
export interface PageContext {
  readonly provider?: string | undefined;
  readonly returnTo?: string | undefined;
}

/** The page for what the callback server says (`page`), about the sign-in `context` names. */
export function signInPage(page: OAuthPage, context: PageContext = {}): string {
  const ok = page.type === "success";
  const title = ok ? (context.provider === undefined ? "Approved" : `${context.provider} approved`) : page.message.replace(/\.$/, "");
  const lines = ok
    ? [`Lemma is finishing signing in${context.provider === undefined ? "" : ` to ${context.provider}`}. You can close this tab.`]
    : [page.details ?? "", "Go back to Lemma to try again."].filter((line) => line !== "");
  const back = safeReturn(context.returnTo);
  const badge = ok ? `${CHECK}Approved` : `${CROSS}Not signed in`;
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>${escaped(title)} · Lemma</title>
<style>${STYLE}</style>
<script>history.replaceState(null,"",location.pathname)</script>
<body class="${ok ? "approved" : "failed"}">
<main>${MARK}<div class="badge">${badge}</div><h1>${escaped(title)}</h1>${lines.map((line) => `<p>${escaped(line)}</p>`).join("")}${
    back === undefined ? "" : `<a class="back" href="${escaped(back)}">Return to Lemma</a>`
  }</main>
</body>
</html>`;
}
