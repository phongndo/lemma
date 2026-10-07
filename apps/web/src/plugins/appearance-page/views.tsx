import { For, Show, createSignal, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";
import { fontAvailable } from "../../lib/fonts.ts";
import { onLookChange, tokenColor } from "../../lib/paint.ts";
import { CORNERS, SCHEMES, TEXT_SIZES, WIDTHS, defaultTheme, themeFor, themeTokens } from "../../model/appearance.ts";
import type { AppearanceSettings, Field, Look, Scheme } from "../../model/appearance.ts";
import type { Accent, Font, Theme } from "../../ui/contracts.ts";
import { Markdown, Segmented, SendIcon, SettingRow } from "../../ui/parts.tsx";
import type { SlotItem } from "../../ui/slots.ts";

/** What the plugins offer, by slot, in order. */
export interface Choices {
  readonly themes: readonly SlotItem<Theme>[];
  readonly accents: readonly SlotItem<Accent>[];
  readonly fonts: readonly SlotItem<Font>[];
}

export interface Deps {
  /** The `appearance` plugin's config, with what was just set. */
  readonly settings: Accessor<AppearanceSettings>;
  /** Writes one field; a default or blank value unsets it. */
  readonly set: (field: Field, value: string | undefined) => void;
  readonly choices: Accessor<Choices>;
  /** The look the settings choose, as the `appearance` plugin paints it. */
  readonly look: Accessor<Look>;
  /** The tokens `scheme` shows with, for a preview of it. */
  readonly tokensFor: (scheme: Scheme) => Record<string, string>;
}

const SAMPLE = [
  "There are three packages: [client](https://lemma.invalid/client), [contracts](https://lemma.invalid/contracts), and [core](https://lemma.invalid/core).",
  "",
  "```ts",
  'import { boot } from "./ui/boot.tsx"; // the entry point',
  "```",
].join("\n");

const missingNote = (deps: Deps, field: Field, fallback: string) => {
  const missing = deps.look().missing.find((choice) => choice.field === field);
  return missing === undefined ? undefined : `"${missing.value}" is not offered by a plugin that is on, so ${fallback} shows.`;
};

/** The look as the chat draws it, with the parts it draws with, and the config it is. */
export function Preview(props: { readonly deps: Deps }) {
  const config = () => JSON.stringify(Object.fromEntries(Object.entries(props.deps.settings()).filter(([, value]) => value !== undefined)));
  return (
    <div class="tw:grid tw:gap-2 tw:pt-1 tw:pb-3">
      <div inert class="tw:grid tw:gap-3 tw:rounded tw:border tw:border-border tw:bg-bg-sunk tw:px-4 tw:py-3.5">
        <div class="tw:justify-self-end tw:rounded tw:border tw:border-border tw:bg-bg-raised tw:px-3 tw:py-1">Show me the packages</div>
        <Markdown text={SAMPLE} />
        <div class="tw:flex tw:items-center tw:justify-between tw:rounded tw:border tw:border-border tw:bg-bg-raised tw:py-1.5 tw:pr-1.5 tw:pl-3 tw:text-text-3">
          Reply…
          <span class="tw:grid tw:size-7 tw:place-items-center tw:rounded-full tw:bg-accent tw:text-accent-fg">
            <SendIcon />
          </span>
        </div>
      </div>
      <p class="tw:m-0 tw:font-mono tw:text-xs tw:text-text-3">
        ui.appearance in config.jsonc: <span class="tw:text-text-2">{config()}</span>
      </p>
    </div>
  );
}

/** A window in `scheme` with `tokens`, in miniature. */
function Window(props: { readonly scheme: Scheme; readonly tokens: Record<string, string> }) {
  return (
    <div data-theme={props.scheme} style={props.tokens} class="tw:grid tw:flex-1 tw:content-start tw:gap-1.5 tw:bg-bg tw:p-2.5">
      <div class="tw:h-1.5 tw:w-2/5 tw:rounded-full tw:bg-accent" />
      <div class="tw:h-1.5 tw:rounded-full tw:bg-border-strong" />
      <div class="tw:h-1.5 tw:w-3/4 tw:rounded-full tw:bg-border-strong" />
    </div>
  );
}

/** System, light, or dark, each drawn in the theme it would show. */
export function SchemePicker(props: { readonly deps: Deps }) {
  const current = () => props.deps.settings().scheme ?? "system";
  return (
    <div role="radiogroup" aria-label="Scheme" class="tw:grid tw:grid-cols-3 tw:gap-3 tw:py-3">
      <For each={SCHEMES}>
        {(option) => (
          <button
            role="radio"
            aria-checked={current() === option.value}
            onClick={() => props.deps.set("scheme", option.value)}
            class="tw:group tw:grid tw:justify-items-center tw:gap-1.5 tw:border-0 tw:bg-transparent tw:p-0 tw:text-sm tw:text-text-2 tw:aria-checked:text-text"
          >
            <div class="tw:flex tw:h-[72px] tw:w-full tw:overflow-hidden tw:rounded tw:border tw:border-border-strong tw:outline-2 tw:outline-offset-2 tw:outline-transparent tw:group-aria-checked:outline-text-3">
              <Show when={option.value !== "dark"}>
                <Window scheme="light" tokens={props.deps.tokensFor("light")} />
              </Show>
              <Show when={option.value !== "light"}>
                <Window scheme="dark" tokens={props.deps.tokensFor("dark")} />
              </Show>
            </div>
            {option.label}
          </button>
        )}
      </For>
    </div>
  );
}

/** The themes offered for `scheme`, for when a plugin offers more than Lemma's own. */
export function ThemeChoice(props: { readonly deps: Deps; readonly scheme: Scheme }) {
  const field = props.scheme === "light" ? "lightTheme" : "darkTheme";
  const offered = () => props.deps.choices().themes.filter((theme) => theme.scheme === props.scheme);
  const current = () => themeFor(props.deps.settings(), props.deps.choices().themes, props.scheme)?.id;
  const fallback = () => defaultTheme(props.deps.choices().themes, props.scheme);
  const title = props.scheme === "light" ? "Light theme" : "Dark theme";
  return (
    <SettingRow title={title} description={missingNote(props.deps, field, fallback()?.title ?? "the stylesheet's own")}>
      <div role="radiogroup" aria-label={title} class="tw:flex tw:flex-wrap tw:justify-end tw:gap-2">
        <For each={offered()}>
          {(theme) => (
            <button
              role="radio"
              aria-checked={current() === theme.id}
              onClick={() => props.deps.set(field, theme.id === fallback()?.id ? undefined : theme.id)}
              class="tw:flex tw:items-center tw:gap-2 tw:rounded-sm tw:border tw:border-border tw:bg-transparent tw:py-1 tw:pr-2.5 tw:pl-1 tw:text-sm tw:text-text-2 tw:aria-checked:border-text-3 tw:aria-checked:text-text"
            >
              <span
                data-theme={props.scheme}
                style={themeTokens(theme)}
                class="tw:flex tw:h-5 tw:w-7 tw:overflow-hidden tw:rounded-sm tw:border tw:border-border-strong"
              >
                <span class="tw:flex-1 tw:bg-bg" />
                <span class="tw:w-2 tw:bg-accent" />
              </span>
              {theme.title}
            </button>
          )}
        </For>
      </div>
    </SettingRow>
  );
}

const DOT =
  "tw:size-[22px] tw:shrink-0 tw:rounded-full tw:border-0 tw:p-0 tw:shadow-[inset_0_0_0_1px_var(--border-strong)] tw:outline-2 tw:outline-offset-2 tw:outline-transparent tw:aria-checked:outline-text-3";
const WHEEL = "var(--color-wheel)";

/** The theme's own accent, the accents plugins offer, and any other color. */
export function AccentPicker(props: { readonly deps: Deps }) {
  let picker!: HTMLInputElement;
  const value = () => props.deps.settings().accent;
  const scheme = () => props.deps.look().scheme;
  const accents = () => props.deps.choices().accents;
  const custom = () => value() !== undefined && !accents().some((accent) => accent.id === value());
  const colorOf = (accent: Accent) => (typeof accent.color === "string" ? accent.color : accent.color[scheme()]);
  // The native picker takes a hex color: the accent showing, as one (a preset's is oklch, say).
  const hex = () => tokenColor("--accent");
  const own = () => themeTokens(themeFor(props.deps.settings(), props.deps.choices().themes, scheme()));
  return (
    <SettingRow title="Accent" description={missingNote(props.deps, "accent", "the theme's accent") ?? "Buttons, links, and selection."}>
      <div role="radiogroup" aria-label="Accent" class="tw:flex tw:items-center tw:gap-2.5">
        <button
          role="radio"
          aria-checked={value() === undefined}
          aria-label="The theme's own"
          data-tip="The theme's own"
          data-theme={scheme()}
          style={own()}
          class={`${DOT} tw:bg-accent`}
          onClick={() => props.deps.set("accent", undefined)}
        />
        <For each={accents()}>
          {(accent) => (
            <button
              role="radio"
              aria-checked={value() === accent.id}
              aria-label={accent.title}
              data-tip={accent.title}
              class={DOT}
              style={{ background: colorOf(accent) }}
              onClick={() => props.deps.set("accent", accent.id)}
            />
          )}
        </For>
        <button
          role="radio"
          aria-checked={custom()}
          aria-label="Another color"
          data-tip={custom() ? value() : "Another color"}
          class={DOT}
          style={{ background: custom() ? value()! : WHEEL }}
          onClick={() => {
            picker.value = hex();
            try {
              picker.showPicker();
            } catch {
              picker.click();
            }
          }}
        />
        <input
          ref={picker}
          type="color"
          tabindex="-1"
          aria-hidden="true"
          class="tw:sr-only"
          onChange={(event) => props.deps.set("accent", event.currentTarget.value)}
        />
      </div>
    </SettingRow>
  );
}

const CUSTOM = "\0custom";

/** A font offered by name (marked when it is not installed), the system's, or a font-family list of one's own. */
export function FontSetting(props: { readonly deps: Deps; readonly kind: "ui" | "mono"; readonly title: string; readonly description: string }) {
  const field = props.kind === "ui" ? "font" : "monoFont";
  const fonts = () => props.deps.choices().fonts.filter((font) => font.kind === props.kind);
  const value = () => props.deps.settings()[field];
  const [writing, setWriting] = createSignal(false);
  // Whether a font is installed can change while the page is open (a plugin declares one, a font loads): ask again then.
  const [fontsChanged, setFontsChanged] = createSignal(0);
  const recheck = () => setFontsChanged((count) => count + 1);
  onCleanup(onLookChange(recheck));
  document.fonts.addEventListener("loadingdone", recheck);
  onCleanup(() => document.fonts.removeEventListener("loadingdone", recheck));
  const label = (font: Font) => {
    fontsChanged();
    return fontAvailable(font.family) ? font.title : `${font.title} (not installed)`;
  };
  const selected = () => {
    const current = value();
    if (current === undefined) return writing() ? CUSTOM : "";
    return fonts().some((font) => font.id === current) ? current : CUSTOM;
  };
  let input: HTMLInputElement | undefined;
  return (
    <SettingRow title={props.title} description={props.description}>
      <div class="tw:grid tw:w-50 tw:gap-1.5">
        <select
          class="field tw:h-[30px] tw:text-md"
          aria-label={props.title}
          onChange={(event) => {
            const next = event.currentTarget.value;
            setWriting(next === CUSTOM);
            if (next === CUSTOM) queueMicrotask(() => input?.focus());
            else props.deps.set(field, next);
          }}
        >
          <option value="" selected={selected() === ""}>
            {props.kind === "ui" ? "System" : "System monospace"}
          </option>
          <For each={fonts()}>
            {(font) => (
              <option value={font.id} selected={selected() === font.id}>
                {label(font)}
              </option>
            )}
          </For>
          <option value={CUSTOM} selected={selected() === CUSTOM}>
            Custom…
          </option>
        </select>
        <Show when={selected() === CUSTOM}>
          <input
            ref={input}
            class="field tw:h-[30px] tw:text-md"
            aria-label={`${props.title}: a CSS font-family list`}
            spellcheck={false}
            placeholder={props.kind === "ui" ? "Inter, sans-serif" : "Iosevka, monospace"}
            value={selected() === CUSTOM ? (value() ?? "") : ""}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            onBlur={(event) => {
              setWriting(false);
              props.deps.set(field, event.currentTarget.value);
            }}
          />
        </Show>
      </div>
    </SettingRow>
  );
}

/** How wide the conversation runs. */
export function WidthSetting(props: { readonly deps: Deps }) {
  return (
    <SettingRow title="Conversation width" description="How wide the transcript and composer run on large screens.">
      <Segmented
        label="Conversation width"
        value={props.deps.settings().contentWidth ?? "default"}
        options={WIDTHS}
        onChange={(next) => props.deps.set("contentWidth", next)}
      />
    </SettingRow>
  );
}

/** Every font, in every plugin, a step smaller or larger. */
export function TextSizeSetting(props: { readonly deps: Deps }) {
  return (
    <SettingRow title="Text size" description="Every font in the app, scaled together.">
      <Segmented
        label="Text size"
        value={props.deps.settings().textSize ?? "default"}
        options={TEXT_SIZES}
        onChange={(next) => props.deps.set("textSize", next)}
      />
    </SettingRow>
  );
}

/** Every rounded corner, in every plugin, squarer or rounder. */
export function CornersSetting(props: { readonly deps: Deps }) {
  return (
    <SettingRow title="Corners" description="Every rounded corner in the app, scaled together.">
      <Segmented label="Corners" value={props.deps.settings().corners ?? "default"} options={CORNERS} onChange={(next) => props.deps.set("corners", next)} />
    </SettingRow>
  );
}
