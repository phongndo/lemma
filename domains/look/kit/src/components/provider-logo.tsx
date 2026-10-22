import { Match, Show, Switch, createMemo } from "solid-js";
import { providerBrand } from "@lemma/llm/web";
import { svgSource } from "@lemma/look";
import type { ProviderLogoProps } from "@lemma/llm/web";

/**
 * A provider's logo, drawn on whatever is behind it: its brand mark (per
 * theme where the brand has two), a custom provider's own SVG, else its
 * initial. Sized by `.provider-mark`.
 */
export function ProviderLogo(props: ProviderLogoProps) {
  const logo = () => providerBrand(props.id).logo;
  // A custom provider's file, encoded once rather than on each draw.
  const custom = createMemo(() => (props.custom === undefined ? undefined : svgSource(props.custom)));
  const mono = () => {
    const l = logo();
    return l !== undefined && "mono" in l ? l.mono : undefined;
  };
  const files = () => {
    const l = logo();
    return l !== undefined && "light" in l ? l : undefined;
  };
  return (
    <span class="provider-mark" aria-hidden="true">
      <Switch fallback={<span class="provider-initial">{props.name.slice(0, 1).toUpperCase()}</span>}>
        {/* A custom provider's own file: an image, so nothing in it runs. */}
        <Match when={custom()}>{(src) => <img class="provider-logo" src={src()} alt="" />}</Match>
        {/* A bundled SVG file, not host data. */}
        <Match when={mono()}>{(svg) => <span class="provider-logo" innerHTML={svg()} />}</Match>
        <Match when={files()}>
          {(f) => (
            <>
              <img class="provider-logo" classList={{ "logo-light": f().dark !== undefined }} src={f().light} alt="" />
              <Show when={f().dark}>{(dark) => <img class="provider-logo logo-dark" src={dark()} alt="" />}</Show>
            </>
          )}
        </Match>
      </Switch>
    </span>
  );
}
