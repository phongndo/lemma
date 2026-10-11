import type { FileIconProps } from "@lemma/look";
import { Icon } from "@lemma/look";

/** The default `file-icon` part: the plain `file` and `folder` icons, whatever the type. */
export const PlainFileIcon = (props: FileIconProps) => <Icon name={props.kind === "directory" ? "folder" : "file"} class={props.class ?? ""} />;
