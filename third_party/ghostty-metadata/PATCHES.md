# Local Ghostty patch ledger

Production Ghostty commit: [`b0c421fcd2e290629d4285c181b52fe2f2095f06`](PIN.json).

The upstream submodule remains clean and exactly matches `PIN.json`. Both Nix and non-Nix builds
apply the ordered, SHA-256-verified patches in `PIN.json` to a private build-tree copy. The source
revision and patch contents identify the Ghostty build cache; neither the submodule nor the Nix
store source is modified.

## Resize viewport normalization

- Patch: [`patches/resize-viewport.patch`](patches/resize-viewport.patch).
- Affected upstream commit: `b0c421fcd2e290629d4285c181b52fe2f2095f06`.
- Upstream tracking: pending. The maintainer explicitly requested keeping this fix local rather
  than publishing an issue; this is an exception to the issue-URL requirement below.
- Reason: historical viewports can violate `PageList`'s viewport-pin integrity check during
  intermediate resize growth/reflow. Lemma cannot retain its parser-injected screen-switching
  workaround because it corrupts fragmented child CSI, OSC, and UTF-8 input.
- Behavior: `PageList.resize` temporarily uses the active viewport, then restores a historical
  viewport's bounded absolute row. This preserves Lemma's existing resize viewport policy without
  switching screens or changing VT parser state. Restoration is scoped to the owning page list,
  including error returns; no borrowed screen pointer survives screen replacement.
- Regression coverage: `TerminalResizeRegressionTest` covers historical primary viewports,
  historical primary viewports while alternate is active, and fragmented child input across resize.
- Owner: Lemma terminal maintainers.
- Removal condition: upstream resize safely maintains viewport-pin invariants throughout growth
  and reflow, and the regression tests pass without the patch and without adapter normalization.
- Revalidated pin: `b0c421fcd2e290629d4285c181b52fe2f2095f06`.

## Requirements for future patches

Record each patch before applying it, including the affected commit and patch file, upstream issue
or PR URL (or an explicit maintainer-approved exception), reason Lemma cannot wait, behavior and
regression tests, owner, removal condition, and the upgrade where it was revalidated.

A patch may not silently change child-visible capabilities, snapshot compatibility, allocator
behavior, or a public `libghostty-vt` result/mode/effect contract.
