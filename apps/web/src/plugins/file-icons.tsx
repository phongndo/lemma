import { Schema } from "effect";
import { Show, createMemo } from "solid-js";
import { FILE_GLYPHS } from "../lib/file-glyphs.ts";
import { DEFAULT_FILE_TYPE, fileType, parseFileTypeRules } from "../model/file-icons.ts";
import { FileIconPart, Slots } from "../ui/contracts.ts";
import type { FileIconProps } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import { DEFAULT_PART_ORDER } from "../ui/slots.ts";
import { Icon } from "../ui/parts.tsx";
import styles from "./file-icons.css?inline";

const FileIconsConfig = Schema.Struct({
  rules: Schema.optional(Schema.Array(Schema.String)).annotations({
    title: "Types",
    description:
      "One line per match, before the built-in ones: `.mdc = markdown` for an extension, `Justfile = bash` for a whole name. A type is an icon's name: typescript, react, javascript, rust, python, go, nix, markdown, json, yml, toml, docker, bash, image, text, default, …",
  }),
});

/**
 * Each file's type as its icon (TypeScript, Rust, Nix, Dockerfile…), in that
 * type's color: it fills the `file-icon` part over `kit`'s plain one, so
 * turning it off brings the plain icons back. Folders keep the folder icon.
 * Colors are tokens in its stylesheet, and `rules` add matches of the user's.
 */
export default defineUiPlugin({
  id: "file-icons",
  styles,
  config: FileIconsConfig,
  requires: { slots: Slots },
  setup: ({ slots }, plugin) => {
    const rules = parseFileTypeRules(plugin.config.rules ?? [], (type) => Object.hasOwn(FILE_GLYPHS, type));
    function TypedFileIcon(props: FileIconProps) {
      const type = createMemo(() => fileType(props.path, rules));
      const glyph = () => (Object.hasOwn(FILE_GLYPHS, type()) ? FILE_GLYPHS[type()]! : FILE_GLYPHS[DEFAULT_FILE_TYPE]!);
      return (
        <Show when={props.kind === "file"} fallback={<Icon name="folder" class={props.class ?? ""} />}>
          <svg
            class={`file-type ${props.class ?? ""}`}
            data-type={type()}
            width="16"
            height="16"
            viewBox={glyph().viewBox ?? "0 0 16 16"}
            aria-hidden="true"
            // The glyphs are this app's own constants (lib/file-glyphs.ts), never input.
            innerHTML={glyph().body}
          />
        </Show>
      );
    }
    // Just below the default: it replaces `kit`'s, and any replacement below `DEFAULT_PART_ORDER` still replaces it.
    plugin.onCleanup(slots.add(FileIconPart, { id: "file-icons", order: DEFAULT_PART_ORDER - 1, component: TypedFileIcon }));
  },
});
