/**
 * A random id, such as a prompt's request id. From `crypto.getRandomValues`,
 * which every page has: `crypto.randomUUID` exists only in secure contexts,
 * so a page served over plain HTTP from another machine would not have it.
 */
export const randomId = (): string => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
