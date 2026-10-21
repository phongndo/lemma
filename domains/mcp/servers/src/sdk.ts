export type Sdk = typeof import("@modelcontextprotocol/client") & typeof import("@modelcontextprotocol/client/stdio");

/**
 * The SDK, imported by the first connect or sign-in rather than with the plugin: with zod it is most of the code the
 * plugin loads, for servers a host may have none of. One that cannot be loaded fails the connect, saying why.
 */
let sdk: Sdk | undefined;
let loading: Promise<Sdk> | undefined;
export const loadSdk = (): Promise<Sdk> =>
  (loading ??= Promise.all([import("@modelcontextprotocol/client"), import("@modelcontextprotocol/client/stdio")]).then(
    ([client, stdio]) => (sdk = { ...client, ...stdio }),
    (error: unknown) => {
      loading = undefined;
      throw error;
    },
  ));

/** The SDK once loaded: what an error the SDK threw is checked against, since no SDK means none of its errors. */
export const loadedSdk = (): Sdk | undefined => sdk;
