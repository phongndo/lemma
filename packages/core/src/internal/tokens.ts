/** What the kernel hands out to be compared by identity: a Hook, an Event, a Registry. */
const tokens = new WeakSet<object>();

/** Marks `value` as a token: a promise-based view of a service holding it leaves it as it is (`plainView`). */
export const token = <T extends object>(value: T): T => {
  tokens.add(value);
  return value;
};

export const isToken = (value: object): boolean => tokens.has(value);
