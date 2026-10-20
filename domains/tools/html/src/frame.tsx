import { createSignal, onCleanup, onMount, untrack } from "solid-js";
import { HTML_THEME_VARIABLES, HtmlMessages, htmlBootstrap, htmlThemeCss, withHtmlBootstrap } from "@lemma/tools/html";
import { usePlugin } from "@lemma/web";
import { currentTheme, currentToken, onLookChange } from "@lemma/web/paint";
import { frameHeight, openable, SETTLE_MS, SHRINK_MS } from "./page.ts";

/** The app's theme now, as a page's CSS: its tokens' values, which name no other token once computed. */
export const appThemeCss = (): string => htmlThemeCss(Object.fromEntries(HTML_THEME_VARIABLES.map((name) => [name, currentToken(name)])), currentTheme());

export interface HtmlFrameProps {
  readonly html: string;
  readonly title: string;
  /** The most the frame grows to, the rest scrolling inside it: the call's `height`. */
  readonly height?: number | undefined;
  /** It fills its box, the page scrolling inside it (full screen, a tab of the pane), rather than taking the page's height. */
  readonly fill?: boolean | undefined;
  /** The height the frame took before at about `width`, to start at rather than grow to (`recallHeight`). */
  readonly known?: ((width: number) => number | undefined) | undefined;
  /** The frame now takes `height` at `width`, for `known` to say the next time it is drawn. */
  readonly onHeight?: ((width: number, height: number) => void) | undefined;
  /** The person followed a link to a place in the page, which is now `top` px below the frame's top (within the frame): bring it into view. */
  readonly onReveal?: ((top: number) => void) | undefined;
  /** Escape was pressed in the page, which did not take it. */
  readonly onEscape?: (() => void) | undefined;
}

/**
 * A page in a frame of its own: `sandbox="allow-scripts allow-forms"` and never `allow-same-origin`, so its scripts run
 * in an opaque origin with no reach into the app, its cookies, or its storage, and it opens no window and navigates no
 * page but its own (a form submits in the frame, so a page's form handlers work). Its bootstrap (`@lemma/tools/html`)
 * carries the app's theme, then follows it; the frame takes the height the page reports (`frameHeight`), starting at
 * the one it took before, unless it fills its box; and it opens the web links the page hands it as the app opens links,
 * in the person's browser, and brings into view the places in the page it links to, each only for a click in it just
 * now: a page's script alone opens and moves nothing, and moves the view no further than the frame. Escape pressed in
 * it goes to `onEscape` (closing the page over the app), only while it has focus. It is named focusable (`tabindex`),
 * so a dialog keeping focus inside it (full screen) counts the page among its stops.
 */
export function HtmlFrame(props: HtmlFrameProps) {
  const plugin = usePlugin();
  let frame: HTMLIFrameElement | undefined;
  const fill = untrack(() => props.fill === true);
  const sizing = frameHeight(untrack(() => props.height));
  const [height, setHeight] = createSignal(sizing.height);
  // Made once: a new `srcdoc` would load the page again, so theme changes go to it as messages.
  const srcdoc = untrack(() => withHtmlBootstrap(props.html, htmlBootstrap(appThemeCss())));
  /** The person just clicked in this frame: the click focused it and activated the app, which a page's script posting on its own, or a click elsewhere in the app a moment before, does not do both of. */
  const clicked = () => frame !== undefined && document.activeElement === frame && navigator.userActivation?.isActive !== false;
  /** Tells `onHeight` the height the frame has come to, once it is the page's own (`settled`) at a width it has. */
  const took = () => {
    if (frame !== undefined && sizing.settled(performance.now()) && frame.clientWidth > 0) props.onHeight?.(frame.clientWidth, sizing.height);
  };
  onMount(() => {
    // A frame with no width (hidden, or not laid out) would recall the height of the narrowest width it was drawn at.
    const width = frame?.clientWidth ?? 0;
    const known = fill || width === 0 ? undefined : props.known?.(width);
    if (known !== undefined) setHeight(sizing.guess(known));
  });
  onCleanup(
    plugin.listen(window, "message", (event: MessageEvent) => {
      // Only this frame's page speaks for it: another frame's messages, or the app's own, are not its.
      if (frame === undefined || event.source !== frame.contentWindow) return;
      const data = event.data as { readonly type?: unknown; readonly height?: unknown; readonly href?: unknown; readonly top?: unknown } | null;
      if (data?.type === HtmlMessages.height && typeof data.height === "number") {
        if (fill) return;
        setHeight(sizing.report(data.height, performance.now()));
        plugin.after(SETTLE_MS, took);
        if (sizing.shrinking)
          plugin.after(SHRINK_MS, () => {
            setHeight(sizing.settle(performance.now()));
            plugin.after(SETTLE_MS, took);
          });
      } else if (data?.type === HtmlMessages.open && openable(data.href) && clicked()) window.open(data.href, "_blank", "noopener,noreferrer");
      // Within the frame: a place the page says is further off moves the view no further than the frame's end.
      else if (data?.type === HtmlMessages.reveal && typeof data.top === "number" && Number.isFinite(data.top) && clicked())
        props.onReveal?.(Math.min(Math.max(0, data.top), frame.clientHeight));
      // Escape is no activation, so focus in the frame alone says the person pressed it there.
      else if (data?.type === HtmlMessages.escape && document.activeElement === frame) props.onEscape?.();
    }),
  );
  onCleanup(
    onLookChange(plugin.action("follow the look in a page", () => frame?.contentWindow?.postMessage({ type: HtmlMessages.theme, css: appThemeCss() }, "*"))),
  );
  return (
    <iframe
      ref={(element) => (frame = element)}
      class="html-frame"
      classList={{ "html-frame-fill": fill }}
      title={props.title}
      sandbox="allow-scripts allow-forms"
      referrerPolicy="no-referrer"
      tabIndex={0}
      srcdoc={srcdoc}
      style={fill ? undefined : { height: `${height()}px` }}
    />
  );
}
