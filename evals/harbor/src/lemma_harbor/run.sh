#!/usr/bin/env bash
# One Harbor trial's turn: starts a host in the trial's home, sends the task as
# one prompt in a new session in this directory, and stops the host, so nothing
# of Lemma's runs on while the verifier does. lemma_harbor.agent runs it as the
# task's user, in the task's directory, with the trial's config and instruction
# uploaded beside its logs. Prints the turn's result (`lemma run --json`) and
# exits 0 when the turn ran, however it ended; otherwise prints why it did not.
set -uo pipefail

root=${LEMMA_EVAL_ROOT:?}
out=${LEMMA_EVAL_OUT:?}
model=${LEMMA_EVAL_MODEL:?}
thinking=${LEMMA_EVAL_THINKING:-}
export LEMMA_HOME=${LEMMA_HOME:-$out/lemma-home}
lemma() { "$root/bin/lemma" "$@"; }

if ! lemma serve --detach >"$out/lemma-serve.log" 2>&1; then
  cat "$out/lemma-serve.log" >&2
  exit 1
fi

# A model only the live catalog knows is listed once its first refresh is done; a ref never listed fails the run below.
# The list is read whole before it is searched: `grep -q` stopping at a match would end the pipe early, and under
# pipefail lemma's failed write would read as no match.
for _ in $(seq 30); do
  listed=$(lemma models --all --quiet 2>/dev/null) && grep -qxF -- "$model" <<<"$listed" && break
  sleep 1
done

args=(run new --json --questions dismiss --model "$model")
if [ -n "$thinking" ]; then args+=(--thinking "$thinking"); fi
lemma "${args[@]}" -- "$(cat "$out/instruction.md")" >"$out/lemma-run.json" 2>"$out/lemma-run.stderr"
code=$?
echo "$code" >"$out/lemma-run.exit"
lemma stop --force >>"$out/lemma-serve.log" 2>&1
# The home is kept as the trial's artifact; the stopped host's access token need not be.
rm -f "$LEMMA_HOME/token"

if [ -s "$out/lemma-run.json" ]; then
  cat "$out/lemma-run.json"
  exit 0
fi
cat "$out/lemma-run.stderr" >&2
exit "$code"
