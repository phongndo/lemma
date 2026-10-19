/**
 * Whether the app takes `binding` (`mod+shift+]`) from a web page that has focus: only one held with a modifier, or a
 * function key (`f5`). A plain key (`n`, `shift+a`) is the page's, as what is typed in it.
 */
export const takenFromPages = (binding: string): boolean => {
  const parts = binding.toLowerCase().split("+");
  const key = parts.at(-1) ?? "";
  return parts.slice(0, -1).some((part) => part === "mod" || part === "ctrl" || part === "alt" || part === "meta" || part === "cmd") || /^f\d{1,2}$/.test(key);
};
