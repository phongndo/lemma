/*
 * The runtime's contracts: what the host and the web app give every plugin
 * (paths, host control, interaction, inspectors, channels), what clients reach
 * the host by (`RuntimeRpcs`, `RuntimeEvent`), the ways into the web app from
 * outside (`addresses`), config forms, and the host's status and kernel
 * views. They declare no domain's routes and reach no domain module
 * (sessions, models, tools), nor does the runtime code that imports them:
 * `scripts/check-boundaries.ts` fails on any import that does.
 * `@lemma/contracts/runtime`.
 */

export * from "./addresses.ts";
export * from "./channels.ts";
export * from "./config.ts";
export * from "./host.ts";
export * from "./inspectors.ts";
export * from "./interaction.ts";
export * from "./kernel.ts";
export * from "./rpc.ts";
export * from "./status.ts";
