/**
 * How long the host lets stopping take in all. The core's default (its 10 second dispose deadline) would cut it short
 * of a plugin that asks for longer to close: the agent takes up to 30 seconds, letting running turns reach a point to
 * resume from. What stops a host waits a little past it, or it would cut off what the host lets finish.
 */
export const SHUTDOWN_TIMEOUT_MS = 40_000;
