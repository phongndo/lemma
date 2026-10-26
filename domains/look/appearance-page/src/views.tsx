import { For, Index, Show, createSignal, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";
import { fontAvailable } from "./fonts.ts";
import { onLookChange, tokenColor } from "@lemma/web/paint";
import { radioGroupKey } from "@lemma/web/keys";
import {
  CORNERS,
  SCHEMES,
  TEXT_SIZES,
  WIDTHS,
  defaultTheme,
  themeFor,
  themeTokens,
  CheckIcon,
  Markdown,
  Segmented,
  SendIcon,
  SettingRow,
  Toggle,
} from "@lemma/look";
import type { AppearanceSettings, Field, Look, Scheme, Accent, Font, Theme } from "@lemma/look";
import { usePlugin } from "@lemma/web";
import type { SlotItem } from "@lemma/web";

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
}

const SAMPLE = [
  "There are three packages: [client](https://lemma.invalid/client), [contracts](https://lemma.invalid/contracts), and [core](https://lemma.invalid/core).",
  "",
  "```ts",
  'import { boot } from "./ui/boot.tsx"; // the entry point',
  "```",
].join("\n");

/**
 * A radio group's keys, as the kit's segmented control has them: the group is one Tab stop (its checked option), and
 * the arrows, Home, and End move the focus along its options, `pick`ing the one moved to.
 */
const radioKeys = (pick: (index: number) => void) => (event: KeyboardEvent & { currentTarget: HTMLElement }) => {
  const next = radioGroupKey(event);
  if (next !== undefined) pick(next);
};

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
        In config.jsonc's plugins: <span class="tw:text-text-2">{`"look.appearance": { "config": ${config()} }`}</span>
      </p>
    </div>
  );
}

/** System, light, or dark. */
export function SchemePicker(props: { readonly deps: Deps }) {
  return (
    <SettingRow title="Scheme" description="System follows your computer's light or dark setting as it changes.">
      <Segmented label="Scheme" value={props.deps.settings().scheme ?? "system"} options={SCHEMES} onChange={(next) => props.deps.set("scheme", next)} />
    </SettingRow>
  );
}

/**
 * The themes offered for `scheme`, as cards that show each in its own colors: its background and text, a line of code,
 * and its accent. The one showing is marked in the app's accent.
 */
export function ThemeCards(props: { readonly deps: Deps; readonly scheme: Scheme }) {
  const field = props.scheme === "light" ? "lightTheme" : "darkTheme";
  const offered = () => props.deps.choices().themes.filter((theme) => theme.scheme === props.scheme);
  const shown = () => themeFor(props.deps.settings(), props.deps.choices().themes, props.scheme);
  const fallback = () => defaultTheme(props.deps.choices().themes, props.scheme);
  const title = props.scheme === "light" ? "Light theme" : "Dark theme";
  const pick = (theme: SlotItem<Theme>) => props.deps.set(field, theme.id === fallback()?.id ? undefined : theme.id);
  /** The group's Tab stop: the theme showing, or the first while none of these is. */
  const checked = () =>
    Math.max(
      0,
      offered().findIndex((theme) => theme.id === shown()?.id),
    );
  const description = () =>
    missingNote(props.deps, field, fallback()?.title ?? "the stylesheet's own") ??
    (props.scheme === "light"
      ? "Shown in the light scheme, and by day when following the system."
      : "Shown in the dark scheme, and by night when following the system.");
  return (
    <div class="theme-setting">
      <div class="setting-text">
        <div class="setting-title">{title}</div>
        <div class="setting-desc">{description()}</div>
      </div>
      {/* By place, not by object: a theme plugin starting again offers its themes anew, and the focused card stays. */}
      <div role="radiogroup" aria-label={title} class="theme-cards" onKeyDown={radioKeys((index) => pick(offered()[index]!))}>
        <Index each={offered()}>
          {(theme, index) => (
            <button
              type="button"
              role="radio"
              class="theme-card"
              aria-checked={shown()?.id === theme().id}
              aria-label={theme().title}
              tabIndex={index === checked() ? 0 : -1}
              onClick={() => pick(theme())}
            >
              <span class="theme-card-sample" data-theme={props.scheme} style={themeTokens(theme())} aria-hidden="true">
                <span class="theme-card-top">
                  <span class="theme-card-type">Aa</span>
                  <span class="theme-card-accent" />
                </span>
                <span class="theme-card-code">
                  <span class="theme-card-keyword">let</span> x = <span class="theme-card-string">"lemma"</span>
                </span>
              </span>
              <span class="theme-card-name">
                {theme().title}
                <Show when={shown()?.id === theme().id}>
                  <CheckIcon />
                </Show>
              </span>
            </button>
          )}
        </Index>
      </div>
    </div>
  );
}

/** A plugin of the look's, on or off: what it draws, and its switch. Gone while no plugin has its id. */
export function PluginSwitch(props: { readonly title: string; readonly description: string; readonly on: boolean; readonly onChange: (on: boolean) => void }) {
  return (
    <SettingRow title={props.title} description={props.description}>
      <Toggle label={props.title} checked={props.on} onChange={props.onChange} />
    </SettingRow>
  );
}

/** An accent's swatch: ringed in muted text while checked, and in the focus ring's color while focused. */
const DOT =
  "tw:size-6 tw:shrink-0 tw:rounded-full tw:border-0 tw:p-0 tw:shadow-[inset_0_0_0_1px_var(--border-strong)] tw:outline-2 tw:outline-offset-2 tw:outline-transparent tw:aria-checked:outline-text-3 tw:focus-visible:outline-(--focus-ring)";
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
  /** The checked option: the theme's own (0), an offered accent, or another color (last). */
  const checked = () => (value() === undefined ? 0 : custom() ? accents().length + 1 : accents().findIndex((accent) => accent.id === value()) + 1);
  /** The option with focus, while one has it. Moving to another color only focuses it, so the focused option, not the checked one, is the group's one Tab stop. */
  const [focused, setFocused] = createSignal<number>();
  const stop = (index: number) => ((focused() ?? checked()) === index ? 0 : -1);
  // Moving to another color only focuses it: picking one opens the color picker, which Enter or Space does.
  const pick = (index: number) => {
    if (index === 0) props.deps.set("accent", undefined);
    else if (index <= accents().length) props.deps.set("accent", accents()[index - 1]!.id);
  };
  return (
    <SettingRow title="Accent" description={missingNote(props.deps, "accent", "the theme's accent") ?? "Buttons, links, and selection."}>
      <div
        role="radiogroup"
        aria-label="Accent"
        class="tw:flex tw:items-center tw:gap-2.5"
        onKeyDown={radioKeys(pick)}
        onFocusIn={(event) => {
          const index = [...event.currentTarget.querySelectorAll("[role=radio]")].indexOf(event.target as Element);
          if (index >= 0) setFocused(index);
        }}
        onFocusOut={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(undefined);
        }}
      >
        <button
          role="radio"
          aria-checked={value() === undefined}
          tabIndex={stop(0)}
          aria-label="The theme's own"
          data-tip="The theme's own"
          data-theme={scheme()}
          style={own()}
          class={`${DOT} tw:bg-accent`}
          onClick={() => props.deps.set("accent", undefined)}
        />
        <Index each={accents()}>
          {(accent, index) => (
            <button
              role="radio"
              aria-checked={value() === accent().id}
              tabIndex={stop(index + 1)}
              aria-label={accent().title}
              data-tip={accent().title}
              class={DOT}
              style={{ background: colorOf(accent()) }}
              onClick={() => props.deps.set("accent", accent().id)}
            />
          )}
        </Index>
        <button
          role="radio"
          aria-checked={custom()}
          tabIndex={stop(accents().length + 1)}
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
  onCleanup(usePlugin().listen(document.fonts, "loadingdone", recheck));
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
          class="field"
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
            class="field"
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
