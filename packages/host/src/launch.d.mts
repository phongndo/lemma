/** The Node.js flags the host runs with, which each launcher passes (see launch.mjs). */
export declare const HOST_FLAGS: readonly string[];
/** Those of `HOST_FLAGS` that `given` (by default this process's flags and `NODE_OPTIONS`) does not name. */
export declare function missingHostFlags(given?: readonly string[]): string[];
/** Starts this process again with the host's flags it was started without, where it can. */
export declare function relaunchWithHostFlags(): void;
/** Loads Effect from the host's bundle of it when it is fresh, from `cache`; returns whether it does. */
export declare function useEffectBundle(cache?: string): boolean;
