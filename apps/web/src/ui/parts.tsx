import { For, createMemo } from "solid-js";
import type { Component, JSX } from "solid-js";
import {
  ChatThinkingPart,
  ChatToolPart,
  ChatTurnFooterPart,
  ChatUserPart,
  ComposerQueuedPart,
  ComposerSuggestionPart,
  ChatWorkingPart,
  ChatWorkPart,
  ChatWorkGroupPart,
  ConfigFormPart,
  CopyButtonPart,
  DialogPart,
  FileIconPart,
  IconPart,
  MarkdownPart,
  PopoverPart,
  ProviderLogoPart,
  ProviderRowPart,
  SegmentedPart,
  SettingRowPart,
  SidebarRowPart,
  SearchFieldPart,
  TogglePart,
} from "./contracts.ts";
import { highlight } from "../model/palette.ts";
import { First } from "./draw.tsx";
import type { Part } from "./slots.ts";

/**
 * How plugins draw parts (see `definePart`). Each export renders whatever
 * currently fills its part, so replacing a part changes it everywhere at
 * once, and a part that nothing fills renders its plain fallback, or nothing
 * when it declares none. The boot provides the registry to the whole page
 * through `SlotsContext`.
 */

export { Contained, Each, First, Isolated, SlotsContext } from "./draw.tsx";

/** `text` with the characters at `matches` (a search's hits) marked. */
export function Highlighted(props: { readonly text: string; readonly matches: readonly number[] }): JSX.Element {
  const parts = createMemo(() => highlight(props.text, props.matches));
  return <For each={parts()}>{(part) => (part.hit ? <mark>{part.text}</mark> : part.text)}</For>;
}

/** A component that renders `part`'s current provider with its props: its default when a replacement throws, its fallback when nothing provides it. */
export const partView =
  <P extends Record<string, any>>(part: Part<P>): Component<P> =>
  (props) => <First slot={part} props={props as never} />;

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
export const ProviderLogo = partView(ProviderLogoPart);
export const Icon = partView(IconPart);
/** A file's or folder's icon (the `file-icon` part). */
export const FileTypeIcon = partView(FileIconPart);

export const ChatUser = partView(ChatUserPart);
export const ComposerQueued = partView(ComposerQueuedPart);
export const ComposerSuggestionView = partView(ComposerSuggestionPart);
export const ChatThinking = partView(ChatThinkingPart);
export const ChatTool = partView(ChatToolPart);
export const ChatWork = partView(ChatWorkPart);
export const ChatWorkGroup = partView(ChatWorkGroupPart);
export const ChatWorking = partView(ChatWorkingPart);
export const ChatTurnFooter = partView(ChatTurnFooterPart);

export const SidebarRow = partView(SidebarRowPart);
export const ProviderRowView = partView(ProviderRowPart);

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
