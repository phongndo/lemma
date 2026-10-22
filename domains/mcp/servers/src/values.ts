/** Whether a JSON value is an object (not null, not an array): what an entry, a config, or a tool's result is read from. */
export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
