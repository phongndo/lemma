import { createSignal, onCleanup, untrack } from "solid-js";
import { HTML_THEME_VARIABLES, HtmlMessages, htmlBootstrap, htmlThemeCss, withHtmlBootstrap } from "@lemma/tools/html";
import { usePlugin } from "@lemma/web";
import { currentTheme, currentToken, onLookChange } from "@lemma/web/paint";
import { frameHeight, openable, SHRINK_MS } from "./page.ts";

/** The app's theme now, as a page's CSS: its tokens' values, which name no other token once computed. */
export const appThemeCss = (): string => htmlThemeCss(Object.fromEntries(HTML_THEME_VARIABLES.map((name) => [name, currentToken(name)])), currentTheme());

/**
 * A page in a frame of its own: `sandbox="allow-scripts allow-forms"` and never `allow-same-origin`, so its scripts run
 * in an opaque origin with no reach into the app, its cookies, or its storage, and it opens no window and navigates no
 * page but its own (a form submits in the frame, so a page's form handlers work). Its bootstrap (`@lemma/tools/html`)
 * carries the app's theme, then follows it; the frame takes the height the page reports (`frameHeight`), and opens the
 * web links the page hands it as the app opens links, in the person's browser, only for a click in it just now: a
 * page's script alone opens nothing.
 */
export function HtmlFrame(props: { html: string; title: string; height?: number | undefined }) {
  const plugin = usePlugin();
  let frame: HTMLIFrameElement | undefined;
  const sizing = frameHeight(props.height);
  const [height, setHeight] = createSignal(sizing.height);
  // Made once: a new `srcdoc` would load the page again, so theme changes go to it as messages.
  const srcdoc = untrack(() => withHtmlBootstrap(props.html, htmlBootstrap(appThemeCss())));
  onCleanup(
    plugin.listen(window, "message", (event: MessageEvent) => {
      // Only this frame's page speaks for it: another frame's messages, or the app's own, are not its.
      if (frame === undefined || event.source !== frame.contentWindow) return;
      const data = event.data as { readonly type?: unknown; readonly height?: unknown; readonly href?: unknown } | null;
      if (data?.type === HtmlMessages.height && typeof data.height === "number") {
        setHeight(sizing.report(data.height, performance.now()));
        if (sizing.shrinking) plugin.after(SHRINK_MS, () => void setHeight(sizing.settle(performance.now())));
      }
      // Only a link the person just clicked in this frame: the click focused the frame and activated the app, which a
      // page's script posting on its own, or a click elsewhere in the app a moment before, does not do both of.
      else if (data?.type === HtmlMessages.open && openable(data.href) && document.activeElement === frame && navigator.userActivation?.isActive !== false)
        window.open(data.href, "_blank", "noopener,noreferrer");
    }),
  );
  onCleanup(
    onLookChange(plugin.action("follow the look in a page", () => frame?.contentWindow?.postMessage({ type: HtmlMessages.theme, css: appThemeCss() }, "*"))),
  );
  return (
    <iframe
      ref={(element) => (frame = element)}
      class="html-frame"
      title={props.title}
      sandbox="allow-scripts allow-forms"
      referrerPolicy="no-referrer"
      srcdoc={srcdoc}
      style={{ height: `${height()}px` }}
    />
  );
}
