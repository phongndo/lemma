/** A branch name for a new worktree from the first message: `lemma/fix-login-redirect`. */
export const branchSlug = (text: string): string => {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5);
  const slug = words.join("-").replace(/-+/g, "-").slice(0, 40).replace(/-+$/, "");
  return `lemma/${slug === "" ? "task" : slug}`;
};
