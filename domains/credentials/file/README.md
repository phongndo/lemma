# credentials.file

Provides `Credentials` over `<Paths.home>/auth.json` (`~/.lemma/auth.json`
unless `$LEMMA_HOME` moves the home): a JSON object mapping provider id to a
pi-ai-shaped `Credential`. No config: no config file, a project's included,
decides where keys are written. Environment variables and provider login flows
belong to the LLM plugin; this plugin only stores.

## Behavior

- **Reads** (`read`, `list`) take no lock. Writes are atomic renames, so a
  reader sees an old or new file, never a partial one. A missing or blank file
  is an empty store.
- **Writes** (`modify`, `remove`) queue in-process, then take `auth.json.lock`
  and **re-read the file inside the lock**. So a token refresh in one process
  and a login in another cannot overwrite each other.
- **`update`** runs under both locks. Returning `undefined` leaves the entry
  unchanged and writes nothing.
- **Other entries** are written back verbatim, including ones this version
  cannot decode. Only the changed entry is replaced. OAuth credentials keep
  provider-specific fields (account ids, base URLs).
- **Files.** A temp file is created `0600` in the same directory, fsynced, then
  renamed over `auth.json`, which so stays `0600`. The directory is created
  `0700`.
- **Corrupt.** A file that is not a JSON object, or an invalid entry for the
  requested provider, fails `CredentialError { reason: "Corrupt" }`. The file is
  never overwritten in that state: fix or remove it by hand.

## Lock

`auth.json.lock` is created with `O_EXCL` and holds `{ pid, host, nonce }`.

- The holder touches it every 10s. The heartbeat stops with the lock, even when
  the work under it runs uninterruptibly, as a token refresh does.
- A lock is abandoned when its process is gone (same host), or it has not been
  touched for 30s. A waiter then removes exactly that lock, matched by content,
  and retries.
- Waiting polls with jitter, and fails `Locked` after 10s.
- It is a convention between processes using this plugin, not protection against
  other programs.

`withFileLock`, `readStore`, `writeStore`, and `decodeEntry` are exported for
tools that must edit the file consistently.

A slow `update` (a network refresh) delays every other write, because it runs
under the file lock. Keep interactive steps such as login prompts outside
`modify`, and store their result with it.
