## Change

<!-- What behavior changes, and why? -->

## Verification

<!-- List commands actually run and their results, including any blocked or failing checks. -->

## Performance review

<!-- Required for changes to input routing, PTY parsing/writes, rendering/composition, layout
projection, resize, scheduling, or client output. Otherwise state why this is not applicable.
See docs/development.md#performance-review-requirement. -->

- Affected multiplier (bytes / events / panes / frames / clients):
- Baseline revision and candidate revision / working-diff identity:
- Approved host, Release profile, and retained paired-gate artifacts:
- Paired result and separate absolute-target misses:
- Relevant correctness tests and deterministic allocation/work-budget results:

<!-- Reviewer: verify the evidence covers the actual candidate before approving a hot-path change.
Shared-runner smoke timings and evidence from an older candidate are not substitutes. -->
