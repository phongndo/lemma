import type { Component, JSX } from "solid-js";
import { splitProps } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { IconName, IconProps } from "../ui/contracts.ts";

/** Small stroke icons (16px grid), inheriting `currentColor`. */
const Icon = (props: { children: JSX.Element; size?: number; class?: string }) => (
  <svg
    class={`icon ${props.class ?? ""}`}
    width={props.size ?? 16}
    height={props.size ?? 16}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {props.children}
  </svg>
);

export const PlusIcon = () => (
  <Icon>
    <path d="M8 3.5v9M3.5 8h9" />
  </Icon>
);
export const StopIcon = () => (
  <Icon>
    <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" />
  </Icon>
);
export const SendIcon = () => (
  <Icon>
    <path d="M8 13V3.5M4 7.5l4-4 4 4" />
  </Icon>
);
export const ChevronIcon = (props: { class?: string }) => (
  <Icon {...props}>
    <path d="M6 4l4 4-4 4" />
  </Icon>
);
export const ChevronDownIcon = () => (
  <Icon>
    <path d="M4 6l4 4 4-4" />
  </Icon>
);
export const CheckIcon = () => (
  <Icon>
    <path d="M3.5 8.5l3 3 6-7" />
  </Icon>
);
export const XIcon = () => (
  <Icon>
    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
  </Icon>
);
export const KeyIcon = () => (
  <Icon>
    <circle cx="5.5" cy="10.5" r="2.5" />
    <path d="M7.5 8.5L13 3M11 5l1.5 1.5M9.5 6.5L11 8" />
  </Icon>
);
export const PuzzleIcon = () => (
  <Icon>
    <path d="M3 5.5h2.5a1.5 1.5 0 113 0H11v2.5a1.5 1.5 0 110 3V13H3z" />
  </Icon>
);
export const CopyIcon = () => (
  <Icon>
    <rect x="5.5" y="5.5" width="7" height="7" rx="1.5" />
    <path d="M10.5 5.5V4a1.5 1.5 0 00-1.5-1.5H4A1.5 1.5 0 002.5 4v5A1.5 1.5 0 004 10.5h1.5" />
  </Icon>
);
export const CodeIcon = () => (
  <Icon>
    <path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" />
  </Icon>
);
export const ImageIcon = () => (
  <Icon>
    <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
    <circle cx="6" cy="6.5" r="1" />
    <path d="M13.5 10.5l-3-3-6 5.5" />
  </Icon>
);
export const AlertIcon = () => (
  <Icon>
    <path d="M8 2.5l6 10.5H2z" />
    <path d="M8 6.5v3M8 11.5v.01" />
  </Icon>
);
export const SidebarIcon = () => (
  <Icon>
    <rect x="2" y="3" width="12" height="10" rx="2" />
    <path d="M6 3v10" />
  </Icon>
);
export const MenuIcon = () => (
  <Icon>
    <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
  </Icon>
);
/** Lines of a log, each with its marker. */
export const LogIcon = () => (
  <Icon>
    <path d="M6 4.5h7M6 8h7M6 11.5h7M3 4.5h.5M3 8h.5M3 11.5h.5" />
  </Icon>
);

export const RefreshIcon = () => (
  <Icon>
    <path d="M13 8a5 5 0 11-1.5-3.5M13 2.5V5h-2.5" />
  </Icon>
);
export const ExternalIcon = () => (
  <Icon>
    <path d="M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5" />
  </Icon>
);
export const FileIcon = () => (
  <Icon>
    <path d="M4.5 2.5h4.5l2.5 2.5v7.5a1 1 0 01-1 1h-6a1 1 0 01-1-1v-9a1 1 0 011-1z" />
    <path d="M9 2.5V5h2.5" />
  </Icon>
);
export const FolderIcon = () => (
  <Icon>
    <path d="M2.5 4.5a1 1 0 011-1h3l1.5 1.5h4.5a1 1 0 011 1v6a1 1 0 01-1 1h-9a1 1 0 01-1-1z" />
  </Icon>
);
export const FolderOpenIcon = () => (
  <Icon>
    <path d="M2.5 11.5v-7a1 1 0 011-1h3l1.5 1.5h4a1 1 0 011 1v1" />
    <path d="M2.5 11.5l1.6-4.2a1 1 0 01.9-.6h8.1a.6.6 0 01.6.8l-1.4 3.7a1 1 0 01-.9.6H3.5a1 1 0 01-1-.3z" />
  </Icon>
);
export const FilterIcon = () => (
  <Icon>
    <path d="M2.5 4h11M4.5 8h7M6.5 12h3" />
  </Icon>
);
export const SearchIcon = () => (
  <Icon>
    <circle cx="7" cy="7" r="4.25" />
    <path d="M10.25 10.25L13.5 13.5" />
  </Icon>
);
export const FolderPlusIcon = () => (
  <Icon>
    <path d="M2.5 4.5a1 1 0 011-1h3l1.5 1.5h4.5a1 1 0 011 1v6a1 1 0 01-1 1h-9a1 1 0 01-1-1z" />
    <path d="M8 7.25v3.5M6.25 9h3.5" />
  </Icon>
);
export const PenSquareIcon = () => (
  <Icon>
    <path d="M13 8.5V12a1.5 1.5 0 01-1.5 1.5h-7A1.5 1.5 0 013 12V4.5A1.5 1.5 0 014.5 3H8" />
    <path d="M11.5 2.5l2 2L8 10H6V8z" />
  </Icon>
);
/** Lucide's "settings" gear, on its 24px grid. */
export const GearIcon = () => (
  <svg
    class="icon"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2.1"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
export const GitBranchIcon = () => (
  <Icon>
    <circle cx="4.5" cy="3.5" r="1.5" />
    <circle cx="4.5" cy="12.5" r="1.5" />
    <circle cx="11.5" cy="5" r="1.5" />
    <path d="M4.5 5v6M11.5 6.5c0 3-7 2.5-7 4.5" />
  </Icon>
);
export const WorktreeIcon = () => (
  <Icon>
    <circle cx="4" cy="3.5" r="1.5" />
    <circle cx="4" cy="12.5" r="1.5" />
    <circle cx="12" cy="12.5" r="1.5" />
    <path d="M4 5v6M4 8h5a3 3 0 013 3v0" />
  </Icon>
);
export const LaptopIcon = () => (
  <Icon>
    <rect x="3" y="3.5" width="10" height="7" rx="1" />
    <path d="M1.5 12.5h13" />
  </Icon>
);
export const StarIcon = (props: { filled?: boolean }) => (
  <Icon>
    <path d="M8 2.2l1.75 3.6 3.95.55-2.87 2.77.7 3.93L8 11.2l-3.53 1.85.7-3.93L2.3 6.35l3.95-.55z" fill={props.filled ? "currentColor" : "none"} />
  </Icon>
);
export const MoreIcon = () => (
  <Icon>
    <circle cx="3.5" cy="8" r="1" fill="currentColor" stroke="none" />
    <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
    <circle cx="12.5" cy="8" r="1" fill="currentColor" stroke="none" />
  </Icon>
);
export const PinIcon = (props: { filled?: boolean }) => (
  <Icon>
    <path d="M6 2.5h4M6.75 2.5v4L4.5 9.25h7L9.25 6.5v-4M8 9.25v4.25" fill={props.filled ? "currentColor" : "none"} />
  </Icon>
);
export const ArchiveIcon = () => (
  <Icon>
    <rect x="2.5" y="3" width="11" height="3" rx=".75" />
    <path d="M3.5 6v6a1 1 0 001 1h7a1 1 0 001-1V6M6.5 8.5h3" />
  </Icon>
);
export const TrashIcon = () => (
  <Icon>
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8a1 1 0 001 .9h3.8a1 1 0 001-.9l.6-8" />
  </Icon>
);
export const PencilIcon = () => (
  <Icon>
    <path d="M10.5 3l2.5 2.5L6 12.5H3.5V10z" />
  </Icon>
);
export const BrainIcon = () => (
  <Icon>
    <path d="M6 3a2 2 0 00-2 2 2 2 0 00-1 3.5A2 2 0 005 12a2 2 0 003 .5V3.5A2 2 0 006 3zM10 3a2 2 0 012 2 2 2 0 011 3.5 2 2 0 01-2 3.5 2 2 0 01-3 .5" />
  </Icon>
);
export const Spinner = () => <span class="spinner" aria-hidden="true" />;
export const ChatIcon = () => (
  <Icon>
    <path d="M3 4.5A1.5 1.5 0 014.5 3h7A1.5 1.5 0 0113 4.5v5a1.5 1.5 0 01-1.5 1.5H7l-3 2.5V11h.5A1.5 1.5 0 013 9.5z" />
  </Icon>
);
export const TrajectoryIcon = () => (
  <Icon>
    <path d="M2.5 4h4M4.5 8h6M8.5 12h5" />
    <path d="M2.5 2.5v11" stroke-opacity="0.45" />
  </Icon>
);
export const CommandIcon = () => (
  <Icon>
    <path d="M6 6V4.5A1.5 1.5 0 104.5 6H6zm0 0h4m-4 0v4m4-4V4.5A1.5 1.5 0 1111.5 6H10zm0 0v4m0 0h1.5a1.5 1.5 0 11-1.5 1.5V10zm0 0H6m0 0v1.5A1.5 1.5 0 114.5 10H6z" />
  </Icon>
);
export const SlidersIcon = () => (
  <Icon>
    <path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6" />
    <circle cx="10" cy="4.5" r="1.5" />
    <circle cx="6" cy="11.5" r="1.5" />
  </Icon>
);
export const PaletteIcon = () => (
  <Icon>
    <path d="M8 2.5a5.5 5.5 0 000 11c.9 0 1.25-.6 1.25-1.2 0-.8-.75-1.05-.75-1.8 0-.7.55-1.25 1.25-1.25h1.5A2.25 2.25 0 0013.5 7 5.5 4.5 0 008 2.5z" />
    <circle cx="5.25" cy="7.25" r=".6" fill="currentColor" />
    <circle cx="7.5" cy="5" r=".6" fill="currentColor" />
    <circle cx="10.5" cy="5.5" r=".6" fill="currentColor" />
  </Icon>
);
export const ArrowLeftIcon = () => (
  <Icon>
    <path d="M13 8H3.5M7.5 4L3.5 8l4 4" />
  </Icon>
);

/** The default icons by name. */
export const icons: Readonly<Record<IconName, Component<{ class?: string; filled?: boolean }>>> = {
  plus: PlusIcon,
  stop: StopIcon,
  send: SendIcon,
  chevron: ChevronIcon,
  "chevron-down": ChevronDownIcon,
  check: CheckIcon,
  x: XIcon,
  key: KeyIcon,
  puzzle: PuzzleIcon,
  copy: CopyIcon,
  code: CodeIcon,
  image: ImageIcon,
  alert: AlertIcon,
  sidebar: SidebarIcon,
  menu: MenuIcon,
  log: LogIcon,
  refresh: RefreshIcon,
  external: ExternalIcon,
  file: FileIcon,
  folder: FolderIcon,
  "folder-open": FolderOpenIcon,
  filter: FilterIcon,
  search: SearchIcon,
  "folder-plus": FolderPlusIcon,
  "pen-square": PenSquareIcon,
  gear: GearIcon,
  "git-branch": GitBranchIcon,
  worktree: WorktreeIcon,
  laptop: LaptopIcon,
  star: StarIcon,
  more: MoreIcon,
  pin: PinIcon,
  archive: ArchiveIcon,
  trash: TrashIcon,
  pencil: PencilIcon,
  brain: BrainIcon,
  chat: ChatIcon,
  trajectory: TrajectoryIcon,
  command: CommandIcon,
  sliders: SlidersIcon,
  palette: PaletteIcon,
  "arrow-left": ArrowLeftIcon,
  spinner: Spinner,
};

/** The default `icon` part. */
export const DefaultIcon = (props: IconProps) => {
  const [, rest] = splitProps(props, ["name"]);
  return <Dynamic component={icons[props.name]} {...rest} />;
};
