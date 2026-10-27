import { IdenticonAvatar } from "./components/avatar.tsx";
import { ConfigForm } from "./components/config-form.tsx";
import { CopyButton } from "./components/copy-button.tsx";
import { Dialog } from "./components/dialog.tsx";
import { PlainFileIcon } from "./components/file-icon.tsx";
import { DefaultIcon } from "./components/icons.tsx";
import { Markdown } from "./components/markdown.tsx";
import { ConfirmDelete, MenuItem } from "./components/menu.tsx";
import { Picture, SvgDrop } from "./components/picture.tsx";
import { Popover } from "./components/popover.tsx";
import { ProviderLogo } from "./components/provider-logo.tsx";
import { Segmented, SettingRow } from "./components/setting-row.tsx";
import { SearchField } from "./components/search-field.tsx";
import { SearchList } from "./components/search-list.tsx";
import { Toggle } from "./components/toggle.tsx";
import { ProviderLogoPart } from "@lemma/llm/web";
import {
  AvatarPart,
  ConfigFormPart,
  ConfirmDeletePart,
  CopyButtonPart,
  DialogPart,
  FileIconPart,
  IconPart,
  MarkdownPart,
  MenuItemPart,
  PicturePart,
  PopoverPart,
  SearchFieldPart,
  SearchListPart,
  SegmentedPart,
  SettingRowPart,
  SvgDropPart,
  TogglePart,
} from "@lemma/look";
import { Slots, defineWebPlugin } from "@lemma/web";
import type { Part } from "@lemma/web";
import styles from "./kit.css?inline";

/**
 * The shared parts every view draws with: markdown, dialogs, menus, search lists, toggles,
 * copy buttons, setting rows, the config form, provider logos, icons, file icons, and agents' avatars. The only plugin
 * that imports rendering components; everything else draws these parts, so
 * replacing one here (or adding one of its own from any plugin, as its items
 * are in the phase `default`) changes it everywhere.
 */
export default defineWebPlugin({
  id: "look.kit",
  styles,
  requires: { slots: Slots },
  setup: ({ slots }) => {
    const add = <P extends Record<string, any>>(part: Part<P>, component: (props: P) => any) =>
      slots.add(part, { id: `kit.${part.name.slice("part.".length)}`, phase: "default", component });
    add(MarkdownPart, Markdown);
    add(DialogPart, Dialog);
    add(PopoverPart, Popover);
    add(TogglePart, Toggle);
    add(SearchFieldPart, SearchField);
    add(SearchListPart, SearchList);
    add(CopyButtonPart, CopyButton);
    add(SettingRowPart, SettingRow);
    add(SegmentedPart, Segmented);
    add(ConfigFormPart, ConfigForm);
    add(ProviderLogoPart, ProviderLogo);
    add(PicturePart, Picture);
    add(SvgDropPart, SvgDrop);
    add(MenuItemPart, MenuItem);
    add(ConfirmDeletePart, ConfirmDelete);
    add(IconPart, DefaultIcon);
    add(FileIconPart, PlainFileIcon);
    add(AvatarPart, IdenticonAvatar);
  },
});
