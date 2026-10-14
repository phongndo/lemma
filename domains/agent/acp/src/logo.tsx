import { For, Show, createSignal } from "solid-js";
import { BotIcon } from "@lemma/look";
import type { HarnessLogo } from "@lemma/agent";

/** A harness's mark (`HarnessLogo`): its paths in its color, an image's shape in the text's color, or an image. */
export function Logo(props: { logo: HarnessLogo; size?: number }) {
  const size = () => props.size ?? 16;
  const image = () => ("image" in props.logo ? props.logo.image : undefined);
  // One that fails to load leaves the generic mark.
  const [failed, setFailed] = createSignal<string>();
  return (
    <Show when={image()} fallback={<Drawn logo={props.logo} size={size()} />}>
      {(src) => (
        <Show when={src() !== failed()} fallback={<BotIcon />}>
          <img class="harness-logo" src={src()} alt="" width={size()} height={size()} onError={() => setFailed(src())} />
        </Show>
      )}
    </Show>
  );
}

function Drawn(props: { logo: HarnessLogo; size: number }) {
  const size = () => props.size;
  return (
    <Show
      when={"viewBox" in props.logo ? props.logo : undefined}
      fallback={
        <span
          class="harness-logo-mask"
          aria-hidden="true"
          style={{ width: `${size()}px`, height: `${size()}px`, "mask-image": `url("${(props.logo as { mask: string }).mask}")` }}
        />
      }
    >
      {(vector) => (
        <svg
          class="harness-logo"
          width={size()}
          height={size()}
          viewBox={vector().viewBox}
          aria-hidden="true"
          style={vector().color === undefined ? {} : { color: vector().color! }}
        >
          <For each={vector().paths}>{(path) => <path d={path.d} fill="currentColor" {...(path.evenOdd === true ? { "fill-rule": "evenodd" } : {})} />}</For>
        </svg>
      )}
    </Show>
  );
}
