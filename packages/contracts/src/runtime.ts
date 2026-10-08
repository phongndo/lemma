/*
 * The runtime's contracts: what the host and the web app give every plugin
 * (paths, host control, interaction, inspectors, addresses), config forms, and
 * the host's status and kernel views. Their imports reach no domain module
 * (sessions, models, tools); `addresses` does declare the web app's routes,
 * the thread routes among them. `@lemma/contracts/runtime`.
 */

export * from "./addresses.ts";
export * from "./config.ts";
export * from "./host.ts";
export * from "./inspectors.ts";
export * from "./interaction.ts";
export * from "./kernel.ts";
export * from "./status.ts";
