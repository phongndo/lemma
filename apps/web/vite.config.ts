/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Production: the host's transport plugin serves `dist`, `/rpc`, and `/api` from the same origin.
// Dev: `LEMMA_DEV_HOST` sets the bind address (default loopback), `LEMMA_HOST_URL` the host to proxy to,
// and `LEMMA_HOST_TOKEN`, when set, is sent on every proxied request, so the page works without `?token=`:
// anyone who can reach the dev server can then use the host.
const hostUrl = process.env.LEMMA_HOST_URL ?? "http://127.0.0.1:7433";
const token = process.env.LEMMA_HOST_TOKEN;
const auth = token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } };

export default defineConfig({
  plugins: [solid()],
  resolve: { conditions: ["lemma-source"] },
  server: {
    host: process.env.LEMMA_DEV_HOST ?? "127.0.0.1",
    proxy: { "/rpc": { target: hostUrl, ws: true, ...auth }, "/api": { target: hostUrl, ...auth } },
  },
  build: { target: "es2022", sourcemap: true },
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
