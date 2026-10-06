import { createSignal, onCleanup } from "solid-js";
import { copyText } from "../lib/clipboard.ts";
import type { CopyButtonProps } from "../ui/contracts.ts";
import { CheckIcon, CopyIcon, XIcon } from "../ui/parts.tsx";

/** An icon button that copies its text, then shows for a moment whether that worked. */
export function CopyButton(props: CopyButtonProps) {
  const [copied, setCopied] = createSignal<boolean>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  const copy = () =>
    void copyText(props.text).then((ok) => {
      setCopied(ok);
      clearTimeout(timer);
      timer = setTimeout(() => setCopied(undefined), 1500);
    });
  return (
    <button
      type="button"
      class={`icon-button ${props.class ?? ""}`}
      aria-label={props.label}
      data-tip={copied() === undefined ? props.label : copied() ? "Copied" : "Copy failed"}
      onClick={copy}
    >
      {copied() === undefined ? <CopyIcon /> : copied() ? <CheckIcon /> : <XIcon />}
    </button>
  );
}
