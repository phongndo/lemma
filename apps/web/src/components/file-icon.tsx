import type { FileIconProps } from "../ui/contracts.ts";
import { Icon } from "../ui/parts.tsx";

/** The default `file-icon` part: the plain `file` and `folder` icons, whatever the type. */
export const PlainFileIcon = (props: FileIconProps) => <Icon name={props.kind === "directory" ? "folder" : "file"} class={props.class ?? ""} />;
