/**
 * Where an id's random bytes come from. A plugin that makes ids takes one when it is made, as it takes the
 * `FileSystem` it writes to: the system's secure source by default, so an id cannot be guessed from others; a
 * simulation passes a seeded one, so a run makes the same ids, and logs the same bytes, every time.
 */
export type IdSource = (size: number) => Uint8Array;

/** The system's secure source (`crypto.getRandomValues`, in Node.js and browsers alike). */
export const secureIds: IdSource = (size) => crypto.getRandomValues(new Uint8Array(size));

const base64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

/**
 * A url-safe id of `bytes` random bytes from `source` (base64url, unpadded) that never starts with `-`, so a
 * command line doesn't read it as an option.
 */
export const randomId = (source: IdSource, bytes: number): string => {
  for (;;) {
    const id = base64url(source(bytes));
    if (!id.startsWith("-")) return id;
  }
};
