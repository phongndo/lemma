import type { OAuthPage } from "@earendil-works/pi-ai/utils/oauth-page";
import { signInPage as landing } from "@lemma/credentials";

/**
 * The page a browser is shown when a sign-in sends it back to the host: Lemma's (`signInPage` in `@lemma/credentials`),
 * in place of pi's (through Lemma's patch of pi-ai, `setOAuthPageRenderer`). The provider sent the browser back with a
 * code, which the host has yet to exchange (pi-ai answers some callbacks before it does), so a success says the
 * sign-in was approved and that Lemma finishes it: the app says how it ended. It offers a way back to Lemma, where the
 * client that started the sign-in said where that is.
 */

/** What the page knows of the sign-in it ends: the provider's name, and where the client said to go back to. */
export interface PageContext {
  readonly provider?: string | undefined;
  readonly returnTo?: string | undefined;
}

/** The page for what the callback server says (`page`), about the sign-in `context` names. */
export function signInPage(page: OAuthPage, context: PageContext = {}): string {
  const ok = page.type === "success";
  return landing({
    title: ok ? (context.provider === undefined ? "Approved" : `${context.provider} approved`) : page.message.replace(/\.$/, ""),
    lines: ok
      ? [`Lemma is finishing signing in${context.provider === undefined ? "" : ` to ${context.provider}`}. You can close this tab.`]
      : [page.details ?? "", "Go back to Lemma to try again."].filter((line) => line !== ""),
    badge: { ok, text: ok ? "Approved" : "Not signed in" },
    returnTo: context.returnTo,
  });
}
