/*
 * A command line for a POSIX shell, as Lemma hands one to another program: the `lemma` command an agent's shell runs
 * (`cliCommand`), and what a plugin runs through `sh -c`.
 */

/** A word as a POSIX shell reads it back: as it is when it holds nothing the shell would read otherwise, else quoted. */
export const shellWord = (word: string): string => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);
