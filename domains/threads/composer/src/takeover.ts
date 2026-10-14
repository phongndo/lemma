/** By takeover `key`: the ones the person let go, and the ones they took while a prompt of their own was unsent. */
export interface TakeoverChoices {
  readonly released: ReadonlySet<string>;
  readonly claimed: ReadonlySet<string>;
}

export const noChoices: TakeoverChoices = { released: new Set(), claimed: new Set() };

/**
 * Whether the takeover `key` holds the text box and the send button: not once the person let it go, nor while they
 * have a prompt of their own unsent (`ownPrompt`: written, or going out), so the box never changes under their keys,
 * unless they took it.
 */
export const holds = (choices: TakeoverChoices, key: string, ownPrompt: boolean): boolean =>
  !choices.released.has(key) && (!ownPrompt || choices.claimed.has(key));

/** The person let the takeover go (Escape, its banner's control, or a prompt of their own sent in its place). */
export const release = (choices: TakeoverChoices, key: string): TakeoverChoices => ({
  released: new Set(choices.released).add(key),
  claimed: choices.claimed,
});

/** The person took the box for the takeover (its waiting line's control): it holds the box even over their prompt. */
export const take = (choices: TakeoverChoices, key: string): TakeoverChoices => ({
  released: new Set([...choices.released].filter((other) => other !== key)),
  claimed: new Set(choices.claimed).add(key),
});
