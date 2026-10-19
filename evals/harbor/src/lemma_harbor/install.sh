#!/usr/bin/env bash
# Installs Lemma into $LEMMA_EVAL_ROOT for a Harbor trial: Node.js, the pnpm the
# checkout names, and the production dependencies of the `lemma` command and the
# host it starts. lemma_harbor.agent uploads the checkout as lemma.tar.gz and
# runs this as root in the task's container; the task's user only reads it.
set -euo pipefail

root=${LEMMA_EVAL_ROOT:?}
node_version=${LEMMA_EVAL_NODE_VERSION:?}

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *)
    echo "lemma: no Node.js build for $(uname -m)" >&2
    exit 1
    ;;
esac
if [ -e /etc/alpine-release ] || compgen -G "/lib/ld-musl-*" >/dev/null; then
  echo "lemma: this image's C library is musl; Node.js's Linux builds need glibc" >&2
  exit 1
fi

mkdir -p "$root/node" "$root/src" "$root/bin"
curl -fsSL --retry 3 "https://nodejs.org/dist/v$node_version/node-v$node_version-linux-$arch.tar.gz" |
  tar -xz -C "$root/node" --strip-components=1
tar -xzf "$root/lemma.tar.gz" -C "$root/src"

# Only for the install: the agent's commands keep the task's PATH, and its own Node.js, if any.
export PATH="$root/node/bin:$PATH"
pnpm_version=$(node -p 'require(process.argv[1]).packageManager.split("@")[1]' "$root/src/package.json")
npm install --global --prefix "$root/pnpm" --no-fund --no-audit --loglevel=error "pnpm@$pnpm_version"
# The CLI's package and what it needs, which is the host and its bundled plugins: not the web app or the desktop app.
(cd "$root/src" && CI=true "$root/pnpm/bin/pnpm" install --frozen-lockfile --prod --filter "@lemma/cli-app..." --store-dir "$root/pnpm-store")

cat >"$root/bin/lemma" <<EOF
#!/bin/sh
exec "$root/node/bin/node" --conditions=lemma-source "$root/src/apps/cli/src/main.ts" "\$@"
EOF
chmod 755 "$root/bin/lemma"
chmod -R a+rX "$root"
"$root/bin/lemma" --version
