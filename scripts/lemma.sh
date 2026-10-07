#!/bin/sh
set -eu

# Follow the portable installer's and Homebrew's symlinks without changing the
# caller's working directory (which scopes sessions and workspace commands).
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
