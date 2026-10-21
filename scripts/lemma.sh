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
exec "$root/runtime/bin/node" --conditions=lemma-source "$root/apps/cli/src/main.ts" "$@"
