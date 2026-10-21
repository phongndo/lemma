#!/bin/sh
# A release's `bin/lemma` (scripts/dist.ts): the CLI on the release's own Node.js, whatever Node is on PATH.
set -eu

# Follow the installer's symlink to the release, leaving the working directory alone: it is the project the host serves.
launcher="$0"
while [ -L "$launcher" ]; do
  directory=$(CDPATH='' cd -- "$(dirname -- "$launcher")" && pwd)
  launcher=$(readlink "$launcher")
  case "$launcher" in
    /*) ;;
    *) launcher="$directory/$launcher" ;;
  esac
done
root=$(CDPATH='' cd -- "$(dirname -- "$launcher")/.." && pwd)
# The CLI's launcher (apps/cli/bin/lemma.js): its compile cache, and a host started as the host's launch says.
exec "$root/runtime/bin/node" --conditions=lemma-source "$root/apps/cli/bin/lemma.js" "$@"
