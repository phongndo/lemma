/*
 * The runtime's contracts: what the host and the web app give every plugin
 * (paths, host control, interaction, inspectors, channels), what clients reach
 * the host by (`RuntimeRpcs`, `RuntimeEvent`), the ways into the web app from
 * outside (`addresses`), config forms, and the host's status and kernel
 * views. They name no domain: each domain's contract is a package of its own
 * under `domains/` (`@lemma/agent`, `@lemma/sessions`, …), and nothing here,
 * nor the runtime code that imports it, reaches one:
 * `scripts/check-boundaries.ts` fails on any import that does. Node's own
 * helpers are `@lemma/contracts/fs`, `/discovery`, and `/testing`.
 */

export * from "./addresses.ts";
export * from "./channels.ts";
export * from "./config.ts";
export * from "./credit.ts";
export * from "./host.ts";
export * from "./ids.ts";
export * from "./clients.ts";
export * from "./inspectors.ts";
export * from "./interaction.ts";
export * from "./kernel.ts";
export * from "./rpc.ts";
export * from "./status.ts";
export * from "./trace.ts";
