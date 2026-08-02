# Terminal-checkpoint feasibility result

## Decision

**Stop — archived August 1, 2026.**

The feasibility gate ran against Lemma commit `35d51f1` and pinned Ghostty commit
`55a3e33ab26a23d75b274b23c7f76d837db00578` (`libghostty-vt` reports `0.1.0-dev`). A bounded
Lemma-owned reconstructive-VT prototype proves the transaction envelope, replica side-effect role,
validation shape, and measurement harness. It also produces deterministic counterexamples showing
that the pinned API cannot export enough state for checkpoint-plus-tail equivalence.

This is a `Stop` outcome, not a partially successful production checkpoint. The resulting
architecture decision selected authoritative server rendering for 1.0 and rejected smart terminal
replication. The temporary prototype, replica role, tests, and benchmark target were then removed
from the main build; this report retains the evidence behind that decision.

## What was implemented during the gate

The feasibility work added:

- explicit authoritative and replica roles to `lemma::vt::Terminal`;
- replica suppression of PTY responses, bells, title-change effects, and mode-dependent key encoding;
- bounded history observations through the Lemma adapter;
- a 16 MiB-capped, versioned, big-endian prototype envelope with dimensions, sequence, semantics
  fingerprint, active-history metadata, payload length, and payload digest;
- candidate-only import that validates every envelope bound before constructing an unpublished
  replica;
- full Ghostty formatter extras for the prototype's reconstructive VT payload;
- eight focused tests covering bounded active-screen/history replay, role suppression,
  malformed/version/semantics/corruption/capacity/allocation rejection, and three required negative
  continuation observations; and
- a release measurement executable covering empty, shell-like, alternate-screen editor-like, and
  maximum-retained-history states at 80x24 and 240x80, including zstd and explicitly partial
  quota-allocator evidence.

The prototype was deliberately named `checkpoint_prototype`, carried active-screen-only and
reconstructive-VT flags, and was never connected to a daemon endpoint or production protocol. It is
no longer present in the production source tree.

## Prototype value model

The 72-byte prototype header is followed by one bounded formatted-VT payload:

| Offset | Width | Value |
| ---: | ---: | --- |
| 0 | 4 | `LCPF` magic |
| 4 | 2 | prototype format version |
| 6 | 2 | header bytes |
| 8 | 4 | exact required flags |
| 12 | 4 | payload bytes, at most 16 MiB |
| 16 | 8 | caller-supplied pane sequence fence |
| 24 | 8 | Lemma prototype plus Ghostty-version semantics fingerprint |
| 32 | 2 | columns |
| 34 | 2 | rows |
| 36 | 4 | cell width in pixels |
| 40 | 4 | cell height in pixels |
| 44 | 8 | active-history first row, currently zero |
| 52 | 8 | rows included by the active-screen formatter |
| 60 | 8 | FNV-1a payload digest |
| 68 | 4 | configured scrollback byte quota |

No pointer, allocator identity, Zig/C struct image, or private Ghostty enum is encoded. Unknown
versions, semantics, flags, dimensions, lengths, history ranges, digests, retention quotas, or
allocation bounds are rejected before terminal creation. Import writes only into a fresh replica
candidate and rejects allocator-failure counter changes or retained-history mismatches, so those
failures cannot mutate a published terminal. The pinned `ghostty_terminal_vt_write` API returns
`void`, however, so other apply failures still cannot be reported reliably; this prevents a
production transactional-publication guarantee.

The value model is structurally useful but semantically insufficient: the payload is formatted VT,
not a complete terminal checkpoint.

## State inventory

“Ready” means required before presentation, “history” means eligible for later range hydration, and
“omit” means deliberately client-local or unsupported. Bounds below are the required Lemma contract,
not a claim that the current Ghostty C API exposes the value.

| State category | Owner and transfer phase | Required bound/policy | Pinned API and observation | Result |
| --- | --- | --- | --- | --- |
| Canonical columns, rows, and cell pixels | daemon; ready | 1–1000 cells per dimension; `u32` checked pixel products | C API exposes dimensions; prototype header round-trips them | Proven for prototype |
| Primary and alternate screens | daemon; both ready | two known screen keys; bounded visible rows/cells | formatter exposes only the active screen; no C API formats/imports an inactive screen | **Blocker** |
| Active screen identity | daemon; ready | closed primary/alternate value | current modes can recreate active screen, but not the other screen's state | Partial |
| Cell graphemes, widths, styles, protection, hyperlinks, and semantic marks | daemon; ready/history | rows/cells bounded by dimensions and retained-history policy; grapheme/string sections bounded | render iterators expose active viewport cells; formatter can replay active history “as closely as possible,” not import exact row metadata | Partial |
| Active and saved cursor state per screen | daemon; ready | two screen records with bounded coordinates and value fields | formatter emits current cursor/style/hyperlink but not complete saved cursor state | **Blocker** |
| Current, saved, and default terminal modes | daemon; ready | stable Lemma mode IDs or explicit feature bits | formatter emits current deviations only; saved/default state and mouse-mode ordering are not exported | **Blocker** |
| Scrolling margins, tab stops, rendition, charset, keyboard stack | daemon; ready | margins within grid; at most one tab bit per column; bounded stacks | formatter covers current values for the active screen, but not every saved/inactive value | Partial |
| Palette and dynamic/default colors | daemon; ready | fixed 256 palette plus bounded dynamic colors | formatter emits current palette; complete original/default/override semantics are not imported transactionally | Partial |
| Title and working-directory metadata | daemon; ready | separately capped UTF-8 byte strings | C getters expose borrowed values; full formatter emits pwd but not title | Partial |
| Previous printed character, status display, mouse ordering, focus/password and terminal flags | daemon; ready | fixed closed values | no complete C export/import surface | **Blocker** |
| UTF-8 decoder continuation | daemon; ready | fixed decoder state or bounded raw continuation | persistent C stream owns private decoder state; formatter omits it | **Blocker; tested** |
| CSI/OSC/DCS parser continuation | daemon; ready | fixed parser values plus bounded OSC/DCS payload | persistent C stream owns parser and dynamic OSC capture; no C checkpoint API | **Blocker; tested for CSI** |
| APC/Glyph/Kitty command continuation | daemon; ready or explicit unsupported reset | bounded by negotiated APC limits | handler owns dynamic protocol parsers; no export/import API | **Blocker** |
| Terminal responses | daemon only; never transferred as replica output | 64 KiB Lemma queue; sequence fence defines already-generated responses | replica callbacks now discard write-PTY effects; pending authoritative queue remains daemon-owned | Proven at adapter boundary |
| Bell/title/clipboard/notification/policy effects | daemon policy only | closed effect kinds and bounded payloads | replica role suppresses registered Lemma effects; clipboard/graphics policy still needs a complete upstream role contract | Partial |
| Retained scrollback rows | daemon; history after ready | stable range identity; configured row/byte and batch bounds | formatter includes all retained active-screen rows in one payload; no stable range/chunk import API. The adapter treats `max_scrollback` as bytes because pinned `Terminal.init` passes it to `PageList.init` as bytes despite the C header describing lines, so actual retained rows vary with width. | **Blocker; tested** |
| History completeness and missing ranges | daemon metadata; ready | bounded list of non-overlapping ranges | prototype can label one complete active range only | Partial |
| Kitty image/graphics and Glyph registrations | daemon; negotiated ready/history or explicitly unsupported | image bytes/count/storage quotas and semantics version | formatter and screen clone explicitly do not preserve all graphics state | **Blocker unless unsupported** |
| Selection, search, viewport, copy cursor | client local; omit | per-client bounds | terminal selection is not needed for parsing continuation | Deliberately omitted |
| Dirty/render cache and physical ANSI hashes | each presenter local; omit/reset | bounded by viewport | expendable presentation state; force full render after import | Deliberately omitted |

The source audit covered `Terminal.zig`, `Screen.zig`, `ScreenSet.zig`, `PageList.zig`, `Parser.zig`,
`UTF8Decoder.zig`, `stream.zig`, `stream_terminal.zig`, `apc.zig`, the formatter, and the C terminal
wrapper. The key architectural fact is that the C wrapper owns both a `ZigTerminal` and a persistent
`Stream`; a valid continuation API must transactionally cover both.

## Deterministic counterexamples

The checked test suite records the stop evidence rather than hiding it behind a common-shell smoke:

1. **Incomplete CSI:** checkpoint after `ESC [ 3 1`, then apply tail `mX`. The canonical terminal
   completes SGR and prints `X`; the reconstructed replica prints `mX` because formatter output has no
   parser continuation.
2. **Incomplete UTF-8:** checkpoint after byte `C3`, then apply `A9`. The canonical terminal completes
   `é`; the replica starts from a fresh decoder and diverges.
3. **Inactive primary screen:** write `PRIMARY`, enter alternate screen, write `ALT`, checkpoint, then
   leave alternate screen. The canonical terminal restores `PRIMARY`; the active-screen-only replica
   has no primary-screen state.
4. **Progressive history:** increasing retained history increases the ready payload because the
   formatter has no stable history range export/import boundary.

These were required trace families in the gate. One counterexample was sufficient for Stop; all four
were checked before the temporary probes were removed from the production suite.

## Side-effect policy tested during the gate

The temporary `TerminalRole::authoritative` default captured PTY responses and effects and encoded
application keys from canonical modes. Temporary `TerminalRole::replica` applied terminal output for
presentation but:

- discards write-PTY callbacks;
- does not count bell or title-change effects;
- exposes no queued PTY response bytes; and
- rejects mode-dependent key encoding with `invalid_role`.

This proved the proposed adapter boundary. A future upstream contract would need to make the role
explicit for every current and future Ghostty effect, including clipboard, notifications, graphics policy,
size queries, and new callbacks, rather than relying only on the callbacks Lemma happens to register
today.

## Release measurements

`build/release/checkpoint-feasibility-results.json` was generated during the gate on Apple Silicon
macOS with Apple Clang 21 and 31 samples per distribution. Generated output and the temporary
benchmark executable were not retained after the architecture decision; the measured table is the
archived evidence.

| State | Bytes | zstd level 1 | Export p50/p99 | Import p50/p99 |
| --- | ---: | ---: | ---: | ---: |
| empty 80x24 | 5,670 | 1,011 | 23.2/24.7 us | 163.1/219.8 us |
| shell 80x24 | 13,752 | 1,291 | 123.0/143.7 us | 174.7/200.5 us |
| editor 80x24 | 7,560 | 1,152 | 38.1/38.5 us | 140.2/150.1 us |
| max retained history 80x24 | 98,389 | 1,208 | 831.9/992.0 us | 279.7/312.0 us |
| empty 240x80 | 5,827 | 1,050 | 17.4/17.8 us | 75.8/81.5 us |
| shell 240x80 | 29,909 | 1,538 | 175.3/191.3 us | 123.7/136.7 us |
| editor 240x80 | 24,837 | 1,478 | 139.1/145.8 us | 122.4/146.7 us |
| max retained history 240x80 | 96,546 | 2,118 | 627.4/672.8 us | 264.3/313.1 us |

A tiny ordered tail write measured 41–42 ns p50 in these synthetic replicas. The benchmark records
only bytes visible to Lemma's quota allocator plus an explicit approximately 16.8 MiB
measurement-buffer ceiling. Ghostty PagePool memory and Lemma's physical cell-hash array are excluded,
so these fields are not total terminal retained/peak memory. The history workloads reached the
current Ghostty retention cap (1,136 rows at 80 columns and 299 rows at 240 columns for this
configuration), demonstrating that the ready payload scales with all retained history. Compression is unusually effective because the synthetic history repeats; it is
not evidence for compressing small interactive frames.

These timings measure a known-incomplete replay payload. They are useful implementation-cost bounds,
not performance evidence for the target architecture.

## Required Ghostty work

No matching upstream Ghostty issue or patch was found during the audit, and this phase did not file
one. Lemma does not require this work for 1.0. Any future proposal to retry checkpoint replication
must assign ownership and reference a real upstream issue/patch for a complete API with at least:

1. a stable semantic checkpoint feature/version query;
2. bounded export of both terminal state and persistent stream continuation;
3. both initialized screens, complete active/saved screen state, and non-private cell/row values;
4. stable recent-to-oldest history range identity, unambiguous row/byte retention units, and bounded
   export/import batches;
5. transactional candidate import with malformed, unsupported, over-capacity, and allocation errors
   returned to the embedder;
6. explicit authoritative versus replica effect roles covering every effect;
7. an image/Glyph policy that either transfers bounded state or rejects negotiated unsupported state;
8. a test-only semantic digest/visitor sufficient to compare more than formatted ANSI; and
9. no serialization of pointers, allocator identities, private enum ordinals, or Zig struct layouts.

The acceptable shape would be a Ghostty implementation of Lemma-owned semantic values or visitor
callbacks, not a private-memory blob.

## Stop consequences

- Smart terminal replication is rejected and checkpoint/event message numbers remain unallocated.
- The server-rendered endpoint, daemon terminal authority, tests, and benchmark path are production
  foundations rather than migration scaffolding.
- Authoritative IDs, typed input, protocol framing, copy mode, and release work proceed without
  checkpoint assumptions through the rolling `TODO.md` backlog.
- Retry this gate only through a new architecture decision with arbitrary parser-boundary,
  both-screen, progressive-history, malformed, allocation-failure, side-effect, and semantic-
  equivalence evidence.
