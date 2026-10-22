#!/bin/sh
# Installs a Lemma release (docs/installation.md): curl -fsSL https://raw.githubusercontent.com/phongndo/lemma/main/scripts/install.sh | sh
set -eu

channel=${LEMMA_CHANNEL:-}
version=${LEMMA_VERSION:-}
api_url=${LEMMA_RELEASE_API_URL:-https://api.github.com/repos/phongndo/lemma}
install_dir=${LEMMA_INSTALL_DIR:-"$HOME/.local/bin"}
data_dir=${LEMMA_DATA_DIR:-"$HOME/.local/share/lemma"}

fail() {
  printf 'lemma install: %s\n' "$*" >&2
  exit 1
}
for command in curl tar mktemp; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
if command -v sha256sum >/dev/null 2>&1; then
  checksum() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  checksum() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  fail "shasum or sha256sum is required to verify the download"
fi

case "$(uname -s)" in
  Darwin) platform=darwin ;;
  Linux) platform=linux ;;
  *) fail "Lemma runs on macOS and Linux" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "Lemma runs on arm64 and x86_64" ;;
esac
[ "$platform-$arch" != darwin-x64 ] || fail "Lemma's macOS releases are for Apple silicon"
case "$install_dir:$data_dir" in
  /*:/*) ;;
  *) fail "LEMMA_INSTALL_DIR and LEMMA_DATA_DIR must be absolute paths" ;;
esac

temporary=$(mktemp -d)
pending=""
locked=""
cleanup() {
  rm -rf "$temporary"
  if [ -n "$pending" ]; then rm -rf "$pending"; fi
  # Its own lock only: one taken back from it (below) is another installer's now.
  if [ -n "$locked" ] && [ "$(cat "$locked/pid" 2>/dev/null || true)" = "$$" ]; then rm -rf "$locked"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# One install at a time, from before it reads the command it replaces: another would prune the release this one puts
# together, switch the command under it, or change which release is the one before. A directory is the lock, as mkdir
# is atomic, naming its installer in a file renamed into place, so another reads the pid whole or not at all. A lock
# whose installer is gone (killed past its cleanup) is taken back: moved aside, which one installer alone can do, and
# removed once it is seen to be that one.
mkdir -p "$data_dir/releases" "$install_dir"
lock="$data_dir/install.lock"
take_lock() {
  mkdir "$lock" 2>/dev/null || return 1
  locked=$lock
  printf '%s\n' "$$" >"$lock/pid.new" && mv "$lock/pid.new" "$lock/pid"
}
if ! take_lock; then
  holder=$(cat "$lock/pid" 2>/dev/null || true)
  [ -n "$holder" ] || fail "another install is under way"
  if kill -0 "$holder" 2>/dev/null; then fail "another install (pid $holder) is under way"; fi
  stale="$lock.$$"
  mv "$lock" "$stale" 2>/dev/null || fail "another install is under way"
  if [ "$(cat "$stale/pid" 2>/dev/null || true)" != "$holder" ]; then
    mv "$stale" "$lock" 2>/dev/null || true
    fail "another install is under way"
  fi
  rm -rf "$stale"
  printf 'lemma install: took back the lock an install that stopped (pid %s) left\n' "$holder" >&2
  take_lock || fail "another install is under way"
fi

# Replace only a command this installer put there, never another package manager's or a user's own.
destination="$install_dir/lemma"
previous=""
if [ -e "$destination" ] || [ -L "$destination" ]; then
  [ -L "$destination" ] || fail "$destination already exists; choose another LEMMA_INSTALL_DIR"
  previous=$(readlink "$destination")
  case "$previous" in
    "$data_dir"/releases/*/bin/lemma) ;;
    *) fail "$destination is not this installer's; update it the way it was installed, or choose another LEMMA_INSTALL_DIR" ;;
  esac
fi

# Every build is a release: stable is the one marked latest, which only a promotion moves; nightly is the newest. The
# channel is recorded with the release, for `lemma update` to follow. A version given with no channel is pinned: it
# follows none.
[ -n "$version" ] || channel=${channel:-stable}
case "$channel" in
  stable | nightly | "") ;;
  *) fail "LEMMA_CHANNEL must be stable or nightly" ;;
esac
if [ -z "$version" ]; then
  case "$channel" in
    stable)
      api="$api_url/releases/latest"
      none="no stable release is published yet; LEMMA_CHANNEL=nightly installs the newest nightly"
      ;;
    nightly)
      api="$api_url/releases?per_page=1"
      none="no release is published yet"
      ;;
  esac
  # A 404 for stable means it has none yet; any other failure (the network, a rate limit) is said as it is.
  response=$(curl -sSL -w '\n%{http_code}' "$api") || fail "could not reach $api"
  status=$(printf '%s\n' "$response" | tail -n 1)
  metadata=$(printf '%s\n' "$response" | sed '$d')
  if [ "$status" = 404 ] && [ "$channel" = stable ]; then fail "$none"; fi
  if [ "$status" != 200 ]; then
    said=$(printf '%s\n' "$metadata" | sed -n 's/.*"message"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
    fail "$api answered $status${said:+: $said}"
  fi
  version=$(printf '%s\n' "$metadata" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$version" ] || fail "$none"
fi
case "$version" in v*) tag=$version ;; *) tag="v$version" ;; esac
printf '%s\n' "$tag" | LC_ALL=C grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || fail "not a release version: $version"

package="lemma-$tag-$platform-$arch"
asset="$package.tar.gz"
base_url=${LEMMA_RELEASE_BASE_URL:-"https://github.com/phongndo/lemma/releases/download/$tag"}
printf 'Installing Lemma %s for %s-%s\n' "$tag" "$platform" "$arch"
curl -fSL --retry 3 "$base_url/$asset" -o "$temporary/$asset" || fail "could not download $asset"
curl -fsSL --retry 3 "$base_url/$asset.sha256" -o "$temporary/$asset.sha256" || fail "could not download $asset.sha256"
expected=$(awk -v name="$asset" 'NF == 2 && $2 == name && length($1) == 64 && $1 !~ /[^0-9a-f]/ {print $1}' "$temporary/$asset.sha256")
[ -n "$expected" ] && [ "$(checksum "$temporary/$asset")" = "$expected" ] || fail "$asset does not match its checksum"
tar -xzf "$temporary/$asset" -C "$temporary"
[ -x "$temporary/$package/bin/lemma" ] && [ -x "$temporary/$package/runtime/bin/node" ] || fail "$asset holds no Lemma and runtime"

# Put together inside the lock, where no pruning looks, then moved into a directory of its own under releases/, so a
# host still running from the one before keeps its files.
staged="$lock/$package"
cp -R "$temporary/$package" "$staged"
# How it was installed, which `lemma version` shows and `lemma update` installs the next release by.
json_string() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }
{
  printf '{\n'
  if [ -n "$channel" ]; then printf '  "channel": %s,\n' "$(json_string "$channel")"; fi
  printf '  "link": %s,\n  "dataDir": %s\n}\n' "$(json_string "$destination")" "$(json_string "$data_dir")"
} >"$staged/install.json"
# Before switching the command: fails if this machine cannot run the release's runtime.
if ! "$staged/bin/lemma" --version --text >/dev/null; then
  [ ! -e /etc/NIXOS ] || fail "this machine cannot run $package: on NixOS, its Node.js needs nix-ld (programs.nix-ld.enable)"
  fail "this machine cannot run $package"
fi
# A name no release has, from mktemp; the lock keeps another install from taking it between rmdir and mv.
installed=$(mktemp -d "$data_dir/releases/$package.XXXXXX")
pending=$installed
rmdir "$installed"
mv "$staged" "$installed"
ln -s "$installed/bin/lemma" "$temporary/lemma"
mv -f "$temporary/lemma" "$destination"
pending=""

# Keep the release before this one, and any a process still runs from (a host not yet restarted, however many updates
# ago it started), by the paths in its command line; remove the rest. Without ps to say which those are, keep them all.
if running=$(ps -A -o args= 2>/dev/null); then
  for release in "$data_dir"/releases/*/; do
    release=${release%/}
    case "$release" in
      "$installed" | "${previous%/bin/lemma}") continue ;;
    esac
    physical=$(CDPATH='' cd -- "$release" 2>/dev/null && pwd -P) || physical=$release
    case "$running" in
      *"$release/"* | *"$physical/"*) continue ;;
    esac
    rm -rf "$release"
  done
else
  printf 'lemma install: kept the releases before this one, as ps could not say which a running host uses\n' >&2
fi

printf '\nInstalled Lemma %s: %s\nIn a project, run: lemma serve\n' "$tag" "$destination"
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) printf '\nAdd %s to your PATH, as in: export PATH="%s:$PATH"\n' "$install_dir" "$install_dir" ;;
esac
if [ -n "$previous" ]; then printf 'Restart a running host to use this version: lemma restart\n'; fi
