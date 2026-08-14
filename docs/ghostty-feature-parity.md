# Ghostty feature parity contract

## Scope and evidence

This is Lemma's product contract for `libghostty-vt`. It audits the production Ghostty commit
[`226a91658da6400140a7da3f38b825ba0395bd5d`](https://github.com/ghostty-org/ghostty/tree/226a91658da6400140a7da3f38b825ba0395bd5d/include/ghostty/vt),
which is locked by
[`third_party/ghostty-metadata/PIN.json`](../third_party/ghostty-metadata/PIN.json). Metadata lives
beside the Git submodule because the superproject cannot
version files inside a gitlink.
Ghostty defines terminal semantics; Lemma decides which semantics are product commitments.

Statuses are normative:

- **REQUIRED** — baseline behavior and a release blocker.
- **SUPPORTED** — implemented and covered, but outside the minimum profile.
- **BACKEND_SPECIFIC** — available only through the named presentation backend.
- **PERMISSION_GATED** — accepted only after explicit policy or consent.
- **INTENTIONALLY_UNSUPPORTED** — unadvertised or protocol-defined no-op, with the reason here.

“Current” means the behavior on this branch before the named milestone, not a claim that the target is
already implemented. A row is complete only when its linked regression is enabled and passing.

## Three independent contracts

### Child terminal profile

`ChildTerminalProfile` is immutable for a session. It controls the child environment, terminfo,
device attributes, query responses, color promises, keyboard guarantees, and graphics advertising.
Reattachment never changes it.

| Profile | Child identity and promises | Graphics | Release gate |
| --- | --- | --- | --- |
| `portable_v1` | `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=lemma`; only the audited xterm-compatible subset is advertised. M5 must either cover every resulting terminfo/DA promise or ship a narrower Lemma terminfo before release. | Not advertised; Kitty APC is a protocol-defined no-op. | M5 |
| `ghostty_extended_v1` | `TERM=xterm-ghostty`, true color, extended keyboard/query semantics, and only extensions explicitly marked below. It never advertises snapshots, RenderState, or another transport detail. | Kitty graphics is always advertised by this immutable profile; an attachment that cannot preserve it is rejected or requires explicit acknowledgement of the named limitation. | M7 after M6 GO |

The current spawn path hard-codes the `portable_v1` environment but does not yet expose the profile as
a typed session field. That implementation gap is release-blocking, not permission to vary the child
identity during attachment.

### Presentation backend cross-product

`PresentationBackend` belongs to each attachment. It does not alter the running child profile.

| Child profile | `ansi` | `ghostty_replica` |
| --- | --- | --- |
| `portable_v1` | **REQUIRED.** Production path and M5 release gate. | **BACKEND_SPECIFIC.** Allowed only after M6 qualifies exact-version replication; ANSI remains fallback. |
| `ghostty_extended_v1` | **BACKEND_SPECIFIC.** Allowed only when every advertised extension has an ANSI realization. Until then, reject the combination or require explicit acknowledgement naming the missing graphics behavior. | **BACKEND_SPECIFIC.** Intended M7 path; unavailable until an M6 mechanism passes convergence, ordering, and resource tests. |

No attachment may silently downgrade an already running session. A rejected combination leaves the
session and child profile unchanged.

### Host capture profile

`HostCaptureProfile` describes what the physical terminal reports to the thin client; it does not
mirror the focused child's modes.

```text
HostCaptureProfile {
  epoch,
  keyboard_capture: LegacyVT | Kitty(flags),
  bracketed_paste_capture,
  focus_capture,
  mouse_capture: Off | Press | Drag | Motion,
  mouse_coordinate_precision: Cell | Pixel,
  host_columns, host_rows, cell_width_px, cell_height_px
}
```

Policy:

1. Negotiate the richest input the host and client can decode reliably.
2. Keep keyboard, outer bracketed paste, and focus capture stable for the attachment.
3. Change mouse capture only for mux UI policy or focused-child demand; still request the richest
   reliable coordinate encoding.
4. Apply a profile atomically and ACK its epoch before events from it are accepted.
5. Attach read-time geometry and epoch to every mouse event. The server validates both before hit
   testing and pane-local translation.
6. Preserve unknown non-paste input as `RawBytes`. Paste remains an opaque typed event, and prefix
   handling runs only on decoded key events.
7. On clean exit, signal exit, protocol error, or disconnect, pop/disable every mode Lemma installed,
   including all known mouse encodings and the Kitty keyboard stack entry.

The current client has no typed profile or ACK. M3 owns this gap; see
`DISABLED_M3HostCaptureEpochIsAckedAndRestored`.

## Session theme policy

A session owns one concrete foreground, background, cursor color, and 256-entry palette captured or
configured at creation. This theme is immutable across ordinary attachment. Only an explicit user
operation may update it, and an update is a canonical session mutation.

Ghostty receives the theme through terminal color options and remains authoritative for child OSC
overrides. Each ANSI client reports its host defaults and palette. Projection then follows these
rules:

- emit reset/default only when the host default equals the session default;
- emit an indexed color only when that host palette entry equals the session entry;
- otherwise emit RGB;
- use Ghostty's effective value after child OSC overrides;
- use the resolved background for background-only cells;
- never forward a pane's OSC 4/10/11 to the physical terminal globally; and
- retain the host cursor color, apply the focused pane's effective cursor color, and restore the host
  color on pane switch or detach.

Current ANSI output does not implement this complete comparison model. M2 regressions
`DISABLED_M2SessionThemeSurvivesReattach` and
`DISABLED_M2AnsiProjectionPreservesEffectiveColorsAndCursor` characterize the gap.

## Child-visible capability matrix

| Capability | `portable_v1` | `ghostty_extended_v1` | ANSI realization / policy | Milestone and regression |
| --- | --- | --- | --- | --- |
| VT parsing, primary/alternate screens, margins, tabs, erase/insert, wrap, save/restore | **REQUIRED** | **REQUIRED** | Project canonical Ghostty cells and modes; never parse a second authoritative grid. | Existing terminal/render tests; M5 differential gate |
| UTF-8, width, grapheme clusters, combining marks, reflow | **REQUIRED** | **REQUIRED** | Preserve graphemes within the declared 256-byte projection bound; reject an invariant breach rather than truncate. | `DISABLED_M5AnsiProjectionConvergesInSecondGhostty` |
| Scrollback and viewport state | **REQUIRED** | **REQUIRED** | Ghostty owns history; Lemma owns copy-mode viewport policy and bounded compression scheduling. | M4 selection regression plus existing resize tests |
| Cursor position, visibility, shape, blink, pending wrap | **REQUIRED** | **REQUIRED** | Only focused pane presents a cursor; restore outer cursor state on detach. | M2 color/cursor regression |
| SGR styles, underline variants/colors, inverse, conceal, strike, overline | **REQUIRED** | **REQUIRED** | ANSI projection must converge in a second Ghostty terminal. | M5 differential gate |
| 16/256 colors and true color | **REQUIRED** | **REQUIRED** | Session-theme comparison rules above. | M2 color regression |
| OSC foreground/background/cursor/palette overrides and queries | **REQUIRED** | **REQUIRED** | Keep canonical effective/default values; answer through Ghostty, never global pass-through. | M2 color regression |
| Hyperlinks | **REQUIRED** | **REQUIRED** | URI maximum 8 KiB; strip control terminators; preserve link boundaries in ANSI. | M3 effects policy; M5 differential links |
| Device attributes, status/mode/size reports, ENQ and XTVERSION | **REQUIRED** for advertised subset | **REQUIRED** for extended subset | Profile-derived callbacks and Ghostty encoders; bounded PTY reply queue. | M1 adapter contracts; M5 profile tests |
| In-band resize and pixel geometry reports | **SUPPORTED** | **SUPPORTED** | Report validated pane geometry, not stale outer geometry. | M3 host geometry tests |
| Legacy and modifyOtherKeys key input | **REQUIRED** | **REQUIRED** | Typed event to Ghostty key encoder; raw fallback only when undecodable. | M3 input corpus |
| Kitty keyboard press/repeat/release, alternate keys, associated text | **SUPPORTED** when captured | **REQUIRED** | Do not fabricate fields unavailable from legacy VT. | `DISABLED_M3KittyMetadataIsPreservedWithoutFabrication` |
| Text commit / IME | **SUPPORTED** | **SUPPORTED** | Separate `TextCommit`; native host data where available. | M3 Unix path; M9 Windows |
| Bracketed paste, filtering, newline policy, injection checks | **REQUIRED** | **REQUIRED** | Opaque event to Ghostty paste API; 1 MiB payload. | `DISABLED_M3PasteIsOpaqueAndUsesGhosttyEncoder` |
| Focus in/out input | **REQUIRED** | **REQUIRED** | Stable outer capture; canonical inner mode controls Ghostty encoding. | M3 input corpus |
| X10/normal/button/any mouse, SGR/UTF-8/URXVT formats, alternate scroll | **REQUIRED** | **REQUIRED** | Semantic host event, mux hit test, pane-local Ghostty encoder. | `DISABLED_M3MouseUsesReadTimeGeometryAndPaneLocalCoordinates` |
| SGR pixel mouse | **SUPPORTED** when host geometry is known | **REQUIRED** | Validate epoch and geometry; pixel report maximum 128 bytes. | Same M3 mouse regression |
| Synchronized output mode 2026 | **REQUIRED** | **REQUIRED** | Per-pane presentation gate; 1 s liveness watchdog never mutates canonical mode. | M2 synchronized-output regressions |
| Bell | **REQUIRED** | **REQUIRED** | Typed event; client sound/visual preference. | M3 effects policy |
| Title and working-directory reports | **REQUIRED** | **REQUIRED** | 4 KiB, sanitize C0/ESC/ST, rate-limit; metadata is not emitted as raw global OSC. | `DISABLED_M3EffectsAreSanitizedBoundedAndPolicyRouted` |
| Shell integration prompt/output markers and progress | **SUPPORTED** | **SUPPORTED** | Typed bounded state; no persistent duplicate screen. | M3 effects; M4 output selection |
| Desktop notifications | **PERMISSION_GATED** | **PERMISSION_GATED** | Default deny or explicit policy; 4 KiB sanitized text and rate limit. | M3 effects regression |
| OSC 52 clipboard write | **PERMISSION_GATED** | **PERMISSION_GATED** | Default deny/prompt; 1 MiB decoded maximum. | M3 effects regression |
| Selection: cell/word/line/output/all, tracked endpoints, formatting | **SUPPORTED** | **SUPPORTED** | Ghostty owns gesture/endpoints; Lemma owns mode, bindings, overlay, and authorization. | `DISABLED_M4SelectionAnchorsTrackTerminalMutation` |
| Kitty graphics direct/PNG media, images, placements, updates, deletion, animation | **INTENTIONALLY_UNSUPPORTED** and unadvertised | **BACKEND_SPECIFIC**: qualified replica | Never raw-APC pass-through; bounded data/placement channel and response routing. | `DISABLED_M7KittyGraphicsLifecycleIsBoundedAndClipped` |
| File, temporary-file, and shared-memory graphics media | **INTENTIONALLY_UNSUPPORTED** | **PERMISSION_GATED** and backend-specific | Disabled until path/descriptor ownership and TOCTOU policy are implemented. | M7 security tests |
| SIXEL/ReGIS | **INTENTIONALLY_UNSUPPORTED** | **INTENTIONALLY_UNSUPPORTED** | Not exposed by the pinned Ghostty rendering contract and never advertised in DA. | No-op parser behavior; not applicable |
| Ghostty snapshots | **INTENTIONALLY_UNSUPPORTED** as a child capability | **INTENTIONALLY_UNSUPPORTED** as a child capability | Candidate private replication mechanism only; exact build identity, CRC, continuation and replay bounds. | M6 GO/NO-GO suite |
| Unknown sequences | **INTENTIONALLY_UNSUPPORTED** unless later classified | Same | Protocol-defined no-op where applicable; identifier/hash-only token-bucket diagnostics. | M3 effects policy |
| tmux control-mode parser | **INTENTIONALLY_UNSUPPORTED** | **INTENTIONALLY_UNSUPPORTED** | Build feature is disabled and Lemma is itself the mux. | Build-info assertion; not applicable |

## Public `libghostty-vt` API surface audit

This table accounts for every public header at the qualification commit. “Internal” means the API is
not itself child-advertised but is still governed by dependency qualification.

| Header/API family | Classification and Lemma use |
| --- | --- |
| `allocator.h`, `sys.h` | **REQUIRED internal.** Quota allocator, bounded synchronous callbacks, nonblocking adapter queues. |
| `build_info.h` | **REQUIRED internal.** Assert SIMD/graphics/tmux feature bits, version, and optimization against `PIN.json`. |
| `terminal.h` | **REQUIRED.** Canonical terminal lifecycle, options/data, VT write/continuation, resize, modes, effects, colors, scrollback, and tracked grid refs. Every option/data/effect is covered by the child matrix or an internal row here. |
| `render.h`, `screen.h`, `style.h`, `point.h` | **REQUIRED internal.** Bounded ANSI projection and future replica rendering; RenderState lifetime never crosses a blocked socket wait. |
| `key.h`, `key/event.h`, `key/encoder.h` | **REQUIRED/SUPPORTED** according to the keyboard rows. Semantic encoder is authoritative. |
| `mouse.h`, `mouse/event.h`, `mouse/encoder.h`, `focus.h`, `paste.h` | **REQUIRED** according to input rows. No hand-built inner encoding where Ghostty provides one. |
| `device.h`, `modes.h`, `size_report.h`, `color_scheme.h` | **REQUIRED** for profile-derived child replies and canonical mode queries. |
| `color.h` | **SUPPORTED internal.** Parsing/comparison utilities may be used; canonical effective colors stay in `GhosttyTerminal`. |
| `formatter.h` | **SUPPORTED internal.** Bounded diagnostics, selection output, and test comparison; never a persistent duplicate grid. |
| `grid_ref.h`, `grid_ref_tracked.h`, `selection.h` | **SUPPORTED** in M4. Tracked refs replace Lemma-owned absolute history coordinates. |
| `kitty_graphics.h` | **BACKEND_SPECIFIC/PERMISSION_GATED** as classified above. |
| `snapshot.h`, `io.h` | **BACKEND_SPECIFIC internal candidate.** M6 only; v1 has no cross-version compatibility promise. |
| `osc.h`, `sgr.h` | **SUPPORTED internal utilities.** Not exposed as independent Lemma APIs; Ghostty's terminal parser remains canonical. |
| `unicode.h` | **SUPPORTED internal utility.** Width/grapheme checks only; no second canonical text layout. |
| `wasm.h` | **INTENTIONALLY_UNSUPPORTED.** Native daemon/client product has no WASM embedding contract. |

## Numerical limits

The constants are defined in [`include/lemma/limits.hpp`](../include/lemma/limits.hpp). Protocol v1
may retain smaller limits; protocol v2 may increase only up to these reviewed ceilings.

| Item | Limit | Failure policy |
| --- | ---: | --- |
| Frame chunk | 4 MiB | End on a row/operation boundary; never split an operation. |
| Complete frame transaction | 64 MiB | Abort, invalidate physical shadow, and schedule a later full repair. |
| Queued frame bytes per attachment | 8 MiB | Abort if the next owned chunk cannot enter the queue. |
| RenderState snapshot hold | 50 ms | Abort encoding and release snapshot; canonical PTY processing continues. |
| Transaction no-progress deadline | 5 s | Abort/retire blocked transaction according to protocol generation. |
| Transaction total deadline | 30 s | Abort even if intermittent progress occurs. |
| Synchronized-output presentation timeout | 1 s | Present for liveness without clearing canonical mode 2026; count diagnostic. |
| Declared attached geometry | 500 columns × 200 rows | Reject before PTY mutation. Worst-case ANSI bound is 35,204,096 bytes, below 64 MiB. |
| Abuse-only terminal geometry | 1,000 × 1,000 | Not an attached-client promise; requires a future progressive-repair contract. |
| Structured input payload / paste / decoded clipboard | 1 MiB each | Reject the event atomically. |
| Expanded structured event batch | 4,096 events | Reject before dispatch; repeat counts contribute to expansion. |
| Pixel mouse report | 128 bytes | Reject malformed or oversized report. |
| PTY response queue | 64 KiB | Terminal-integrity failure; terminate pane visibly. |
| Title/PWD/progress/notification or unknown sequence capture | 4 KiB | Sanitize then truncate/reject according to typed effect policy; never raw-forward. |
| Hyperlink URI | 8 KiB | Reject link and strip terminators. |
| Snapshot / decoder continuation | 64 MiB / 1 MiB | Exact build + CRC required; reject and resync on any violation. |
| Graphics command chunk / decoded image | 4 MiB / 64 MiB | Reject command/image atomically and produce protocol-defined response. |
| Graphics pixels / placements | 16,777,216 pixels / 4,096 per pane | Reject before allocation or placement mutation. |
| Aggregate graphics storage | 256 MiB per session | Evict only by specified Kitty lifecycle or reject; never silent loss. |

At 500 × 200 cells, Lemma's conservative 352-byte per-cell ANSI bound plus 4 KiB fixed overhead is
35,204,096 bytes. The 64 MiB transaction ceiling therefore covers every currently declared resize;
the 4 MiB value is only a chunk bound.

## Regression ledger

M0 checks in disabled, deliberately failing specifications under
[`tests/ghostty_parity_regression_test.cpp`](../tests/ghostty_parity_regression_test.cpp). They do not
make CI green by pretending the behavior exists. A milestone removes a `DISABLED_` prefix only after
replacing `FAIL()` with an executable characterization; its exit gate requires that test to pass.
Existing terminal, renderer, protocol, allocation, and E2E tests remain active throughout.

An upgrade must also include a public-header diff, result/mode/effect review, this matrix update,
allocation census, performance comparison, and real-host smoke results. Any local patch follows
[`third_party/ghostty-metadata/PATCHES.md`](../third_party/ghostty-metadata/PATCHES.md).
