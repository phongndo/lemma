import { ConfigForm } from "../components/config-form.tsx";
import { Dialog } from "../components/dialog.tsx";
import { PlainFileIcon } from "../components/file-icon.tsx";
import { DefaultIcon } from "../components/icons.tsx";
import { Markdown } from "../components/markdown.tsx";
import { Popover } from "../components/popover.tsx";
import { ProviderLogo } from "../components/provider-logo.tsx";
import { Segmented, SettingRow } from "../components/setting-row.tsx";
import { SearchField } from "../components/search-field.tsx";
import { Toggle } from "../components/toggle.tsx";
import {
  ConfigFormPart,
  DialogPart,
  FileIconPart,
  IconPart,
  MarkdownPart,
  PopoverPart,
  ProviderLogoPart,
  SegmentedPart,
  SettingRowPart,
  Slots,
  SearchFieldPart,
  TogglePart,
} from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import { DEFAULT_PART_ORDER } from "../ui/slots.ts";
import type { Part } from "../ui/slots.ts";
import styles from "./kit.css?inline";

/**
 * The shared parts every view draws with: markdown, dialogs, menus, toggles,
 * setting rows, the config form, provider logos, icons, and file icons. The only plugin
 * that imports rendering components; everything else draws these parts, so
 * replacing one here (or adding one with a lower order from any plugin or UI
 * file) changes it everywhere.
 */
export default defineUiPlugin({
  id: "kit",
  styles,
  requires: { slots: Slots },
  setup: ({ slots }, plugin) => {
    const add = <P extends Record<string, any>>(part: Part<P>, component: (props: P) => any) =>
      plugin.onCleanup(slots.add(part, { id: `kit.${part.name.slice("part.".length)}`, order: DEFAULT_PART_ORDER, component }));
    add(MarkdownPart, Markdown);
    add(DialogPart, Dialog);
    add(PopoverPart, Popover);
    add(TogglePart, Toggle);
    add(SearchFieldPart, SearchField);
    add(SettingRowPart, SettingRow);
    add(SegmentedPart, Segmented);
    add(ConfigFormPart, ConfigForm);
    add(ProviderLogoPart, ProviderLogo);
    add(IconPart, DefaultIcon);
    add(FileIconPart, PlainFileIcon);
  },
});
