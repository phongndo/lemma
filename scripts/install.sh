#!/bin/sh
set -eu

version=${LEMMA_VERSION:-latest}
install_dir=${LEMMA_INSTALL_DIR:-"$HOME/.local/bin"}
data_dir=${LEMMA_DATA_DIR:-"$HOME/.local/share/lemma"}

fail() { printf 'lemma install: %s\n' "$*" >&2; exit 1; }
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
  *) fail "supported systems are macOS and Linux" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "supported architectures are arm64 and x86_64" ;;
esac
case "$install_dir:$data_dir" in
  /*:/*) ;;
  *) fail "LEMMA_INSTALL_DIR and LEMMA_DATA_DIR must be absolute paths" ;;
esac

# Only replace a launcher that this installer owns, never Homebrew or another
# package manager's command, nor a user's executable.
destination="$install_dir/lemma"
if [ -e "$destination" ] || [ -L "$destination" ]; then
  [ -L "$destination" ] || fail "$destination already exists; choose a different LEMMA_INSTALL_DIR"
  case "$(readlink "$destination")" in
    "$data_dir"/releases/*/bin/lemma) ;;
    *) fail "$destination is managed elsewhere; update it with its package manager or choose another LEMMA_INSTALL_DIR" ;;
  esac
fi

if [ "$version" = latest ]; then
  metadata=$(curl -fsSL https://api.github.com/repos/phongndo/lemma/releases/latest) || fail "no latest release is available; set LEMMA_VERSION to a published tag"
  version=$(printf '%s\n' "$metadata" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
fi
case "$version" in v*) tag=$version ;; *) tag="v$version" ;; esac
printf '%s\n' "$tag" | LC_ALL=C grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' || fail "invalid release version: $version"

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
curl -fsSL --retry 3 "$base_url/$asset.sha256" -o "$temporary/$asset.sha256" || fail "could not download the checksum"
expected=$(awk -v name="$asset" 'NF == 2 && $2 == name && length($1) == 64 && $1 !~ /[^0-9a-f]/ {print $1}' "$temporary/$asset.sha256")
[ -n "$expected" ] && [ "$(checksum "$temporary/$asset")" = "$expected" ] || fail "checksum verification failed"
tar -xzf "$temporary/$asset" -C "$temporary"
[ -x "$temporary/$package/bin/lemma" ] && [ -x "$temporary/$package/runtime/bin/node" ] || fail "archive does not contain Lemma and its runtime"

mkdir -p "$data_dir/releases" "$install_dir"
pending=$(mktemp -d "$data_dir/releases/$tag-$platform-$arch.XXXXXX")
cp -R "$temporary/$package/." "$pending/"
# Fail before switching the command if the platform cannot run this runtime.
"$pending/bin/lemma" --version
ln -s "$pending/bin/lemma" "$temporary/lemma"
mv -f "$temporary/lemma" "$destination"
pending=""

printf '\nInstalled %s\nRun in a project: lemma serve\n' "$destination"
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) printf '\nAdd this directory to your shell PATH: %s\n' "$install_dir" ;;
esac
printf 'To update, rerun this installer, then restart Lemma.\n'
