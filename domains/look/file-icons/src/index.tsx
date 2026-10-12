import { Schema } from "effect";
import { Show, createMemo } from "solid-js";
import { FILE_GLYPHS } from "./file-glyphs.ts";
import { DEFAULT_FILE_TYPE, fileType, parseFileTypeRules } from "./file-icons.ts";
import { FileIconPart, Icon } from "@lemma/look";
import { Slots, defineWebPlugin } from "@lemma/web";
import type { FileIconProps } from "@lemma/look";
import styles from "./file-icons.css?inline";

const FileIconsConfig = Schema.Struct({
  rules: Schema.optional(Schema.Array(Schema.String)).annotate({
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
export default defineWebPlugin({
  id: "look.file-icons",
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
    // A better default: first among the defaults, so it shows over `kit`'s, and any replacement still shows over it.
    slots.add(FileIconPart, { id: "file-icons", phase: "default", order: -1, component: TypedFileIcon });
  },
});
