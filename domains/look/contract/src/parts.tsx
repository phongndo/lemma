import type { ConfigField, ConfigValues } from "@lemma/contracts";
import { definePart, partView } from "@lemma/web";
import type { JSX } from "solid-js";
import { ConfigFormFallback, IconFallback, SearchFieldFallback, SegmentedFallback, ToggleFallback } from "./fallbacks.tsx";

/*
 * Parts: the pieces plugins draw with, and the pieces of the big views. Each
 * is a region slot (see `definePart`): wherever a plugin uses one, the first
 * item by order renders, so any plugin, a user's web half too, replaces a part everywhere
 * by adding an item with a lower order than the default (`DEFAULT_PART_ORDER`).
 * The `kit` plugin supplies the shared parts; a view supplies its own.
 * Plugins draw these through `ui/parts.tsx`, never by importing a component.
 * The parts the always-on plugins draw (`shell`, `pages`, `settings`, and
 * `plugins-page`) declare a plain fallback (`ui/fallbacks.tsx`), which renders
 * while nothing provides them, so with `kit` off the Plugins page still
 * searches, switches plugins, and edits their settings.
 */

export interface MarkdownProps {
  readonly text: string;
  readonly class?: string;
  /** Still arriving: a code block whose fence has not closed is incomplete. */
  readonly streaming?: boolean;
}

/** Model text as sanitized markdown; fenced code renders through `CodeBlocks`. */
export const MarkdownPart = definePart<MarkdownProps>("markdown");

export interface DialogProps {
  readonly title?: JSX.Element;
  readonly label?: string;
  readonly onClose?: (() => void) | undefined;
  readonly children: JSX.Element;
  readonly footer?: JSX.Element;
  readonly class?: string;
  readonly labelledBy?: string;
  /** False keeps it open when the backdrop is clicked: closing would lose work a stray click should not (a login under way). */
  readonly closeOnBackdrop?: boolean;
}

/** A modal: backdrop, Escape to close, focus kept inside. */
export const DialogPart = definePart<DialogProps>("dialog");

export type Placement = "top-start" | "top-end" | "bottom-start" | "bottom-end";

export interface PopoverProps {
  readonly label: string;
  readonly trigger: JSX.Element;
  readonly triggerClass?: string;
  readonly placement?: Placement;
  readonly disabled?: boolean;
  /** Tooltip for the trigger; defaults to `label`. */
  readonly tip?: string;
  readonly menuClass?: string;
  readonly onOpen?: () => void;
  /** Receives a handle for opening the menu from elsewhere (a shortcut, say). */
  readonly controller?: (handle: { readonly open: () => void }) => void;
  readonly children: (close: () => void) => JSX.Element;
}

/** A button that opens a menu of `menuitem`/`option` elements. */
export const PopoverPart = definePart<PopoverProps>("popover");

export interface SearchFieldProps {
  readonly value: string;
  readonly onInput: (value: string) => void;
  readonly placeholder: string;
  /** Its accessible name. */
  readonly label: string;
  /** Keys it does not handle itself: Escape with text in it clears it. */
  readonly onKeyDown?: (event: KeyboardEvent) => void;
  readonly ref?: (input: HTMLInputElement) => void;
  /** The page's controls after the field: a filter menu, a count. */
  readonly children?: JSX.Element;
}

/**
 * A page's search (the settings sections'): an underlined field with an icon, and room for the page's controls.
 * Its fallback is a plain search input.
 */
export const SearchFieldPart = definePart<SearchFieldProps>("search-field", SearchFieldFallback);

export interface CopyButtonProps {
  /** What it puts on the clipboard. */
  readonly text: string;
  /** Its accessible name and tooltip: `Copy response`. */
  readonly label: string;
  readonly class?: string;
}

/** An icon button that copies its text and says for a moment whether that worked. */
export const CopyButtonPart = definePart<CopyButtonProps>("copy-button");

export interface ToggleProps {
  readonly label: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange: (checked: boolean) => void;
}

/** An on/off switch. Its fallback is a plain checkbox. */
export const TogglePart = definePart<ToggleProps>("toggle", ToggleFallback);

export interface SettingRowProps {
  readonly title: string;
  readonly description?: string | undefined;
  readonly children: JSX.Element;
}

export const SettingRowPart = definePart<SettingRowProps>("setting-row");

export interface SegmentedProps {
  readonly label: string;
  readonly value: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly onChange: (value: string) => void;
}

/** One of a few options, side by side. */
export const SegmentedPart = definePart<SegmentedProps>("segmented", SegmentedFallback);

export interface ConfigFormProps {
  readonly fields: readonly ConfigField[];
  readonly config: ConfigValues | undefined;
  /** Where the fields are written, for the note under the form. */
  readonly file: string;
  readonly disabled?: boolean;
  readonly onSave: (values: Readonly<Record<string, unknown>>) => Promise<void>;
}

/**
 * A plugin's settings, projected from its config Schema. Its fallback is a text input per field, read as
 * `lemma plugins config` reads a value.
 */
export const ConfigFormPart = definePart<ConfigFormProps>("config-form", ConfigFormFallback);

export type IconName =
  | "plus"
  | "stop"
  | "send"
  | "chevron"
  | "chevron-down"
  | "check"
  | "x"
  | "key"
  | "puzzle"
  | "copy"
  | "code"
  | "image"
  | "alert"
  | "sidebar"
  | "menu"
  | "log"
  | "refresh"
  | "external"
  | "file"
  | "folder"
  | "folder-open"
  | "filter"
  | "search"
  | "folder-plus"
  | "pen-square"
  | "gear"
  | "git-branch"
  | "worktree"
  | "laptop"
  | "star"
  | "more"
  | "pin"
  | "archive"
  | "trash"
  | "pencil"
  | "brain"
  | "chat"
  | "trajectory"
  | "command"
  | "terminal"
  | "hammer"
  | "sliders"
  | "palette"
  | "arrow-left"
  | "spinner";

export interface IconProps {
  readonly name: IconName;
  readonly class?: string;
  /** For icons with a filled state (star). */
  readonly filled?: boolean;
}

/**
 * Every icon, by name: one part, so a set replaces them all and can fall back to the defaults (`api.defaults.Icon`).
 * Its fallback is a text glyph.
 */
export const IconPart = definePart<IconProps>("icon", IconFallback);

export interface FileIconProps {
  /** The file's path or name; only its name is read. */
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly class?: string;
}

/**
 * The icon for a file or folder, wherever one is named (the composer's `@`
 * menu, a tool call's path). `kit`'s default is the plain `file` and `folder`
 * icons; the `file-icons` plugin draws each file's type, just below
 * `DEFAULT_PART_ORDER`, so a replacement below that replaces either.
 */
export const FileIconPart = definePart<FileIconProps>("file-icon");

export const Markdown = partView(MarkdownPart);

export const Dialog = partView(DialogPart);

export const Popover = partView(PopoverPart);

export const Toggle = partView(TogglePart);

export const SearchField = partView(SearchFieldPart);

export const CopyButton = partView(CopyButtonPart);

export const SettingRow = partView(SettingRowPart);

/** Typed by its options' values; the part itself takes strings. */
export const Segmented = partView(SegmentedPart) as unknown as <T extends string>(props: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly onChange: (value: T) => void;
}) => JSX.Element;

export const ConfigForm = partView(ConfigFormPart);

export const Icon = partView(IconPart);

/** A file's or folder's icon (the `file-icon` part). */
export const FileTypeIcon = partView(FileIconPart);

// Each icon by name, drawn through the `icon` part.
export const PlusIcon = () => <Icon name="plus" />;

export const StopIcon = () => <Icon name="stop" />;

export const SendIcon = () => <Icon name="send" />;

export const ChevronIcon = (props: { class?: string }) => <Icon name="chevron" {...props} />;

export const ChevronDownIcon = () => <Icon name="chevron-down" />;

export const CheckIcon = () => <Icon name="check" />;

export const XIcon = () => <Icon name="x" />;

export const KeyIcon = () => <Icon name="key" />;

export const PuzzleIcon = () => <Icon name="puzzle" />;

export const CopyIcon = () => <Icon name="copy" />;

export const CodeIcon = () => <Icon name="code" />;

export const ImageIcon = () => <Icon name="image" />;

export const AlertIcon = () => <Icon name="alert" />;

export const SidebarIcon = () => <Icon name="sidebar" />;

export const MenuIcon = () => <Icon name="menu" />;

export const LogIcon = () => <Icon name="log" />;

export const RefreshIcon = () => <Icon name="refresh" />;

export const ExternalIcon = () => <Icon name="external" />;

export const FileIcon = () => <Icon name="file" />;

export const FolderIcon = () => <Icon name="folder" />;

export const FolderOpenIcon = () => <Icon name="folder-open" />;

export const FilterIcon = () => <Icon name="filter" />;

export const SearchIcon = () => <Icon name="search" />;

export const FolderPlusIcon = () => <Icon name="folder-plus" />;

export const PenSquareIcon = () => <Icon name="pen-square" />;

export const GearIcon = () => <Icon name="gear" />;

export const GitBranchIcon = () => <Icon name="git-branch" />;

export const WorktreeIcon = () => <Icon name="worktree" />;

export const LaptopIcon = () => <Icon name="laptop" />;

export const StarIcon = (props: { filled?: boolean }) => <Icon name="star" {...props} />;

export const MoreIcon = () => <Icon name="more" />;

export const PinIcon = () => <Icon name="pin" />;

export const ArchiveIcon = () => <Icon name="archive" />;

export const TrashIcon = () => <Icon name="trash" />;

export const PencilIcon = () => <Icon name="pencil" />;

export const BrainIcon = () => <Icon name="brain" />;

export const ChatIcon = () => <Icon name="chat" />;

export const TrajectoryIcon = () => <Icon name="trajectory" />;

export const CommandIcon = () => <Icon name="command" />;

export const TerminalIcon = () => <Icon name="terminal" />;

export const HammerIcon = () => <Icon name="hammer" />;

export const SlidersIcon = () => <Icon name="sliders" />;

export const PaletteIcon = () => <Icon name="palette" />;

export const ArrowLeftIcon = () => <Icon name="arrow-left" />;

export const Spinner = () => <Icon name="spinner" />;
