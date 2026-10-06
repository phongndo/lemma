/**
 * Effect yields between a fiber's steps with `setImmediate` where there is one,
 * and with `setTimeout(0)` elsewhere, which a browser delays to 4ms once
 * nested and to a second or more in a hidden tab: the app took three times as
 * long to start. A message to a channel runs as soon as the page is free. Effect
 * looks for `setImmediate` when it loads, so `main.tsx` imports this first.
 */
if (!("setImmediate" in globalThis)) {
  const tasks = new Map<number, () => void>();
  let next = 0;
  const channel = new MessageChannel();
  channel.port1.onmessage = (event: MessageEvent<number>) => {
    const task = tasks.get(event.data);
    tasks.delete(event.data);
    task?.();
  };
  Object.assign(globalThis, {
    setImmediate: (task: () => void): number => {
      const id = next++;
      tasks.set(id, task);
      channel.port2.postMessage(id);
      return id;
    },
    clearImmediate: (id: number): void => void tasks.delete(id),
  });
}
