/** Which Escape in the prompt stops a running turn: a second within `STOP_WINDOW_MS` of the first, or any. */
export type StopWith = "escape-twice" | "escape";

/** How long a first Escape waits for the second that stops the turn (`"escape-twice"`). */
export const STOP_WINDOW_MS = 1000;

export interface StopKeyHost {
  readonly mode: () => StopWith;
  /** Stops the running turn. */
  readonly cancel: () => void;
  /** Runs `fn` after `ms`, and returns what cancels it. */
  readonly after: (ms: number, fn: () => void) => () => void;
  /** A first Escape waits for its second: what the composer shows ("Escape again to stop"). */
  readonly armed: () => boolean;
  readonly setArmed: (armed: boolean) => void;
}

/**
 * Escape in the prompt while a turn runs. With `"escape-twice"`, the first arms it until the window closes or
 * `disarm` (another thread shows, the turn ends), so a second stops only the turn the first was pressed in. One held
 * down (`repeat`) does nothing, or the two presses would be one.
 */
export function createStopKey(host: StopKeyHost) {
  let closeWindow: (() => void) | undefined;
  const disarm = () => {
    closeWindow?.();
    closeWindow = undefined;
    host.setArmed(false);
  };
  const press = (repeat = false) => {
    if (repeat) return;
    const second = host.armed();
    disarm();
    if (host.mode() === "escape" || second) return void host.cancel();
    host.setArmed(true);
    closeWindow = host.after(STOP_WINDOW_MS, () => host.setArmed(false));
  };
  return { press, disarm };
}
