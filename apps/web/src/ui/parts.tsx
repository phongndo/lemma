import { Show, createContext, useContext } from "solid-js";
import type { Accessor, Component, JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import {
  ChatThinkingPart,
  ChatToolPart,
  ChatTurnFooterPart,
  ChatUserPart,
  ComposerQueuedPart,
  ComposerSuggestionPart,
  ChatWorkingPart,
  ChatWorkPart,
  ConfigFormPart,
  DialogPart,
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
import type { Part, SlotsService } from "./slots.ts";

/**
 * How plugins draw parts (see `definePart`). Each export renders whatever
 * currently fills its part, so replacing a part changes it everywhere at
 * once, and a part that nothing fills renders nothing. The boot provides the
 * registry to the whole page through `SlotsContext`.
 */

export const SlotsContext = createContext<Accessor<SlotsService | undefined>>(() => undefined);

/** A component that renders `part`'s current provider with its props. */
export const partView =
  <P extends Record<string, any>>(part: Part<P>): Component<P> =>
  (props) => {
    const slots = useContext(SlotsContext);
    const item = () => slots()?.first(part);
    return (
      <Show when={item()} keyed>
        {(entry) => <Dynamic component={entry.component} {...props} />}
      </Show>
    );
  };

export const Markdown = partView(MarkdownPart);
export const Dialog = partView(DialogPart);
export const Popover = partView(PopoverPart);
export const Toggle = partView(TogglePart);
export const SearchField = partView(SearchFieldPart);
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

export const ChatUser = partView(ChatUserPart);
export const ComposerQueued = partView(ComposerQueuedPart);
export const ComposerSuggestionView = partView(ComposerSuggestionPart);
export const ChatThinking = partView(ChatThinkingPart);
export const ChatTool = partView(ChatToolPart);
export const ChatWork = partView(ChatWorkPart);
export const ChatWorking = partView(ChatWorkingPart);
export const ChatTurnFooter = partView(ChatTurnFooterPart);

export const SidebarRow = partView(SidebarRowPart);
export const ProviderRowView = partView(ProviderRowPart);

// Icons by their old names, each the icon part.
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
export const SlidersIcon = () => <Icon name="sliders" />;
export const PaletteIcon = () => <Icon name="palette" />;
export const ArrowLeftIcon = () => <Icon name="arrow-left" />;
export const Spinner = () => <Icon name="spinner" />;
