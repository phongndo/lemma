# @lemma/plugin-credentials

Provides `Credentials` over `auth.json` at `Paths.auth`: a JSON object mapping provider id to a pi-ai-shaped `Credential`. Requires `Paths`. No config. Environment variables and provider login flows belong to the LLM plugin; this plugin only stores.

## Behavior

- **Reads** (`read`, `list`) take no lock; writes are atomic renames, so a reader sees an old or new file, never a partial one. A missing or blank file is an empty store.
- **Writes** (`modify`, `remove`) queue in-process, then take `auth.json.lock` and **re-read the file inside the lock**, so a token refresh in one process and a login in another cannot overwrite each other. `update` runs under both locks; returning `undefined` leaves the entry unchanged and writes nothing.
- Only the changed entry is replaced; every other entry, including ones this version cannot decode, is written back verbatim. OAuth credentials keep provider-specific fields (account ids, base URLs).
- Files: temp file created `0600` in the same directory, fsynced, then renamed over `auth.json` (which therefore stays `0600`); the directory is created `0700`.
- **Corrupt** file (not a JSON object) or an invalid entry for the requested provider: `CredentialError { reason: "Corrupt" }`. The file is never overwritten in that state; fix or remove it by hand.

## Lock

`auth.json.lock` is created with `O_EXCL` and holds `{ pid, host, nonce }`. The holder touches it every 10s (a heartbeat that stops with the lock even when the work under it runs uninterruptibly, as a token refresh does), so a lock is abandoned when its process is gone (same host) or it has not been touched for 30s; a waiter then removes exactly that lock (matched by content) and retries. Waiting polls with jitter and fails `Locked` after 10s. This is a cooperation convention between processes using this plugin, not protection against other programs. `withFileLock`, `readStore`, `writeStore`, and `decodeEntry` are exported for tools that must edit the file consistently.

Because `update` runs under the file lock, a slow update (a network refresh) delays every other write; keep interactive steps such as login prompts outside `modify` and store the result with it.
