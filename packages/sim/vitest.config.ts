import { defineConfig } from "vitest/config";

// A simulated run's log names the date in the local time zone: one zone for every machine, so a seed's run is the
// same everywhere.
export default defineConfig({ test: { env: { TZ: "UTC" } } });
