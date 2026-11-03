/**
 * How long the host lets stopping take in all. The core's default (its 10 second dispose deadline) would cut it short
 * of a plugin that asks for longer to close: the agent takes up to 30 seconds, letting running turns reach a point to
 * resume from.
 */
export const SHUTDOWN_TIMEOUT_MS = 40_000;

/**
 * How long what stops a host (`lemma stop` and `restart`, the desktop app quitting) waits for it to exit: its own
 * limit, and a margin, since giving up sooner would cut off what the host lets finish.
 */
export const STOP_WAIT_MS = SHUTDOWN_TIMEOUT_MS + 5_000;
