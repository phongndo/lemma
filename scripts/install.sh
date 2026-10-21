#!/bin/sh
# Installs a Lemma release (docs/installation.md): curl -fsSL https://raw.githubusercontent.com/phongndo/lemma/main/scripts/install.sh | sh
set -eu

channel=${LEMMA_CHANNEL:-stable}
version=${LEMMA_VERSION:-}
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

# Every build is a release: stable is the one marked latest, which only a promotion moves; nightly is the newest.
if [ -z "$version" ]; then
  case "$channel" in
    stable)
      api=https://api.github.com/repos/phongndo/lemma/releases/latest
      none="no stable release is published yet; LEMMA_CHANNEL=nightly installs the newest nightly"
      ;;
    nightly)
      api="https://api.github.com/repos/phongndo/lemma/releases?per_page=1"
      none="no release is published yet"
      ;;
    *) fail "LEMMA_CHANNEL must be stable or nightly" ;;
  esac
  metadata=$(curl -fsSL "$api") || fail "$none"
  version=$(printf '%s\n' "$metadata" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$version" ] || fail "$none"
fi
case "$version" in v*) tag=$version ;; *) tag="v$version" ;; esac
printf '%s\n' "$tag" | LC_ALL=C grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || fail "not a release version: $version"

package="lemma-$tag-$platform-$arch"
asset="$package.tar.gz"
base_url=${LEMMA_RELEASE_BASE_URL:-"https://github.com/phongndo/lemma/releases/download/$tag"}
temporary=$(mktemp -d)
pending=""
cleanup() {
  rm -rf "$temporary"
  if [ -n "$pending" ]; then rm -rf "$pending"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'Installing Lemma %s for %s-%s\n' "$tag" "$platform" "$arch"
curl -fSL --retry 3 "$base_url/$asset" -o "$temporary/$asset" || fail "could not download $asset"
curl -fsSL --retry 3 "$base_url/$asset.sha256" -o "$temporary/$asset.sha256" || fail "could not download $asset.sha256"
expected=$(awk -v name="$asset" 'NF == 2 && $2 == name && length($1) == 64 && $1 !~ /[^0-9a-f]/ {print $1}' "$temporary/$asset.sha256")
[ -n "$expected" ] && [ "$(checksum "$temporary/$asset")" = "$expected" ] || fail "$asset does not match its checksum"
tar -xzf "$temporary/$asset" -C "$temporary"
[ -x "$temporary/$package/bin/lemma" ] && [ -x "$temporary/$package/runtime/bin/node" ] || fail "$asset holds no Lemma and runtime"

# Each install gets a directory of its own, so a host still running from the one before keeps its files.
mkdir -p "$data_dir/releases" "$install_dir"
pending=$(mktemp -d "$data_dir/releases/$package.XXXXXX")
cp -R "$temporary/$package/." "$pending/"
# Before switching the command: fails if this machine cannot run the release's runtime.
if ! "$pending/bin/lemma" --version --text >/dev/null; then
  [ ! -e /etc/NIXOS ] || fail "this machine cannot run $package: on NixOS, its Node.js needs nix-ld (programs.nix-ld.enable)"
  fail "this machine cannot run $package"
fi
ln -s "$pending/bin/lemma" "$temporary/lemma"
mv -f "$temporary/lemma" "$destination"
installed=$pending
pending=""

# Keep the release before this one, which a host may still run from, and remove those older.
for release in "$data_dir"/releases/*/; do
  release=${release%/}
  case "$release" in
    "$installed" | "${previous%/bin/lemma}") ;;
    *) rm -rf "$release" ;;
  esac
done

printf '\nInstalled Lemma %s: %s\nIn a project, run: lemma serve\n' "$tag" "$destination"
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) printf '\nAdd %s to your PATH, as in: export PATH="%s:$PATH"\n' "$install_dir" "$install_dir" ;;
esac
if [ -n "$previous" ]; then printf 'Restart a running host to use this version: lemma stop, then lemma serve.\n'; fi
