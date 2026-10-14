/**
 * The services a `core.run` task runs with, recording which it resolved, so a
 * failure drains and interrupts only the tasks that used what it revokes.
 * Copying the whole context conservatively counts as resolving all of it.
 *
 * Effect has no API to observe a service lookup. This relies on its
 * `Context.makeUnsafe` keeping the map it is given and resolving a service
 * through that map's `get`, so a lookup is seen and a key deleted later is
 * gone for the task (revoked), and on a context that stops looking there (it
 * flattened the map into a copy) having iterated it first, which counts as
 * resolving everything. `tests/tracked.test.ts` checks both against the
 * Effect release installed, and fails when an upgrade changes either.
 */
export class TrackedServices extends Map<string, unknown> {
  readonly read = new Set<string>();
  override get(key: string): unknown {
    this.read.add(key);
    return super.get(key);
  }
  private all(): void {
    for (const key of super.keys()) this.read.add(key);
  }
  override entries() {
    this.all();
    return super.entries();
  }
  override values() {
    this.all();
    return super.values();
  }
  override [Symbol.iterator]() {
    this.all();
    return super[Symbol.iterator]();
  }
  override forEach(callback: (value: unknown, key: string, map: Map<string, unknown>) => void, thisArg?: unknown): void {
    this.all();
    super.forEach(callback, thisArg);
  }
}
