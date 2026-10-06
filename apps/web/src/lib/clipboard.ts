import type { NotifyService } from "../ui/contracts.ts";

/**
 * Puts `text` on the clipboard; resolves whether it worked. Pages served over
 * plain HTTP from another machine (a host on a LAN or Tailscale address) are
 * not a secure context and have no `navigator.clipboard`, so a hidden text
 * area and the older copy command stand in; call it from a click.
 */
export const copyText = async (text: string): Promise<boolean> => {
  try {
    if (navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* denied: try the fallback */
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  document.body.append(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    focused?.focus();
  }
};

/** Copies `text`, then says so in a toast: `Copied <text>`, or that the clipboard refused it. */
export const copyAndTell = async (notify: Pick<NotifyService, "toast">, text: string): Promise<void> => {
  notify.toast((await copyText(text)) ? { level: "info", message: `Copied ${text}` } : { level: "error", message: "Could not copy to the clipboard" });
};
