# Lemma execution backlog

This is Lemma's sole mutable execution backlog through 1.0. It records current priority and concrete
completion checks. [`docs/roadmap.md`](docs/roadmap.md) owns outcome and release guidance;
[`docs/current-capabilities.md`](docs/current-capabilities.md) records audited behavior; and
[`docs/daily-driver-contract.md`](docs/daily-driver-contract.md) defines the complete quality bar.

The order below is rolling rather than a fixed phase plan. Reorder it when a bounded spike,
benchmark, user test, or dependency result changes the best next step. Do not mark behavior complete
until implementation, failure handling, bounds, tests, and user-facing documentation agree.

## Current focus — authoritative IDs and one semantic command spine

Build the identity and command boundary before adding more feature-specific interfaces.

- [ ] Move sessions, panes, and clients into bounded dense generational stores while preserving
  existing `TabId` behavior and process continuity.
- [ ] Resolve every explicit session, tab, pane, and client target at the core trust boundary; reject
  stale, cross-owner, and out-of-range IDs before mutation.
- [ ] Define bounded actor, request, and idempotency identities for built-in keys, CLI calls, attached
  clients, Lua, and automation peers.
- [ ] Define one typed command, result, and error schema shared by those origins. Keep transport and UI
  policy outside authoritative mutation.
- [ ] Carry one narrow command end to end through C++, `--format=json`, the persistent same-user
  semantic socket, and Lua before broadening the command set.
- [ ] Add golden encoding, malformed-input, capacity, stale-ID, authorization-boundary, and
  deterministic dispatch tests for that slice.

### Current-focus completion checks

- Every authoritative object reference is a validated stable ID, not a slot, pointer, or name lookup
  retained across mutation.
- The selected command has identical target resolution, result, error, and side-effect behavior from
  every supported origin.
- Untrusted payloads and extension values are bounded before they enter core state; invalid input
  cannot partially mutate topology.
- Lua and automation failure cannot delay PTY reads, ordered pane input, rendering, or process
  lifetime.
- The capability audit, protocol contract, generated/help-facing schema material, tests, and
  benchmark evidence are updated with the implementation.

## Next — bounded versioned attached-client protocol

Preserve the authoritative daemon and thin ANSI client while replacing the `lemma-v8` migration
format.

- [ ] Add an explicit version/capability handshake and actionable mismatch diagnostics.
- [ ] Frame both protocol directions, including complete bounded daemon render messages and typed
  errors.
- [ ] Represent ordered key, text/paste, focus, resize, and mouse input as bounded typed values.
- [ ] Make full-redraw epochs and lag recovery explicit without checkpoints, PTY replay, or a client
  terminal replica.
- [ ] Enforce output queue and progress-deadline policy so a blocked client cannot stall PTYs or
  unrelated sessions.
- [ ] Add golden, fragmentation/coalescing, malformed, oversized, stale-ID, mismatch, partial-write,
  lag-recovery, fuzz, and process-level isolation coverage.

### Protocol completion checks

- Attach, resize, tab change, reconnect, and lag recovery reconstruct complete visible state from
  daemon authority.
- Every existing mux process scenario still passes on the production endpoint.
- A non-reading or incompatible peer has bounded impact and receives a precise error or is
  disconnected according to documented policy.
- No checkpoint, raw PTY event tail, or client-side VT state is required for correctness.

## Rolling 1.0 capability backlog

These work streams may interleave with the current focus when an end-to-end slice needs them.

### Complete the local daily driver

- [ ] Implement plain `lemma`, dedicated help/version output, precise nonzero errors, explicit daemon
  shutdown, exit reporting, and the documented cwd/environment launch policy.
- [ ] Add session and tab naming, stable tab reorder, public pane identification, stored split ratios,
  and keyboard resize.
- [ ] Complete bounded physical input decoding and signal-safe/best-available restoration of every
  outer-terminal mode.
- [ ] Add daemon-side status, pane, separator, and overlay hit testing; route mouse actions and
  application mouse forwarding through the same typed commands as keyboard operation.
- [ ] Add per-attachment viewport, copy mode, search, selection, unread/follow state, and bounded
  clipboard policy without pausing PTY processing.
- [ ] Define and test truthful terminfo, extended-key, mouse, graphics, shell, editor, pager, REPL, and
  TUI compatibility behavior.

### Finish configuration, extensions, and automation

- [ ] Apply validated `lemma.setup` settings and declarative key/mouse maps transactionally.
- [ ] Invoke Lua commands asynchronously; deliver bounded snapshots/events/output observations; and
  add replacement-host reload that preserves the prior valid generation on failure.
- [ ] Expose explicit JSON for supported CLI operations and a separately versioned same-user semantic
  socket with discovery, deadlines, cancellation, and repair after event/output loss.
- [ ] Add typed launch, inspect, capture, wait, signal, cancel, and exit-result operations without
  screen scraping or unbounded polling.
- [ ] Add retained status/sidebar/overlay models and local versioned Lua packages.
- [ ] Ship generated command/schema/binding references, maintained configuration examples, an agent
  `SKILL.md`, and first-party workspace/worktree and agent-observer extensions that keep those
  concepts out of the kernel.

### Prove robustness and performance continuously

- [ ] Keep PTY, input, render, protocol, extension, and allocation work explicitly bounded and
  release-asserted; add fuzz and capacity coverage at every untrusted boundary.
- [ ] Expand end-to-end measurements to mouse interaction, sparse/full-screen updates, attach/full
  redraw, slow clients, resize storms, memory per pane/attachment, JSON/agent operations, and
  daemon-to-client bytes.
- [ ] Maintain comparable pinned tmux, Zellij, Herdr, and Lemma workloads and set reviewed regression
  budgets only from reproducible evidence.
- [ ] Run sanitizer, four-host, stress, output/resize flood, repeated lifecycle, extension-crash, and
  multi-day soak coverage required by the daily-driver contract.

### Package, validate remote use, and earn release readiness

- [ ] Test ordinary `ssh -t HOST lemma` operation and machine-readable commands, including resize,
  transport loss, cwd/environment, logout, and daemon-lifetime behavior.
- [ ] Produce checksummed macOS/Linux arm64/x86_64 artifacts and test install, upgrade, mismatch,
  cleanup, and uninstall outside development tooling.
- [ ] Add completions, onboarding, configuration, automation, security, compatibility,
  troubleshooting, release-note, and operational documentation.
- [ ] Recruit a focused external cohort; require sustained primary-mux use for at least 30 days and
  track reasons users return to another mux.

## Completion discipline

For every checked item, satisfy the applicable completion rule in
[`docs/daily-driver-contract.md`](docs/daily-driver-contract.md): documented behavior and failures,
keyboard/mouse and semantic-command parity, explicit resource bounds, unit/integration/adversarial
coverage, hot-path measurements, diagnostics, and release notes. Update
[`docs/current-capabilities.md`](docs/current-capabilities.md) in the same change so the backlog never
substitutes for an honest present-state audit.
