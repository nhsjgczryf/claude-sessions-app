#!/usr/bin/env bash
#
# Builds the two assets that turn the APK into a self-contained Linux
# environment:
#
#   1. proot-arm64                — fully static PRoot binary so we can
#                                   chroot into Alpine without root.
#   2. alpine-rootfs.tar.zst      — Alpine Linux arm64 rootfs with bash,
#                                   tmux, nodejs, npm, and the
#                                   @anthropic-ai/claude-code package
#                                   pre-installed.
#
# Runs on GitHub Actions ubuntu-latest via QEMU user-mode emulation of
# arm64. End-to-end build is ~10-15 min (most of it static-linking
# PRoot under QEMU). Outputs land in android/app/src/main/assets/ so
# `cap sync android` then folds them into the APK.
#
# Idempotent: skips proot rebuild if the binary is already present
# (keyed on PROOT_REF). The rootfs is rebuilt every run because the
# claude-code npm tag floats.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${OUT:-$ROOT/android/app/src/main/assets}"
ALPINE_VERSION="${ALPINE_VERSION:-3.20}"
PROOT_REF="${PROOT_REF:-v5.4.0}"      # latest tagged proot release as of 2026-05
NPM_INSTALL="${NPM_INSTALL:-@anthropic-ai/claude-code}"

mkdir -p "$OUT"
cd "$ROOT"

echo "==> Output directory: $OUT"
echo "==> Alpine version:   $ALPINE_VERSION"
echo "==> PRoot ref:        $PROOT_REF"
echo "==> Will npm-install: $NPM_INSTALL"

# ---------------------------------------------------------------------
# 1. Static proot-arm64
# ---------------------------------------------------------------------
#
# proot's own build system spits out a dynamically-linked binary that
# would need libtalloc.so + libc.so present at the path we exec it
# from. Since Android exec'ing from /data/data/... has no Linux loader
# visible at /lib/ld-musl-aarch64.so.1, we MUST link statically.
# Alpine's musl + talloc-static packages make that straightforward.
#
# Output is dumped to OUT via `COPY --from=builder` into a `scratch`
# stage which gets exported as a local directory.

if [[ -x "$OUT/proot-arm64" ]]; then
  echo "==> proot-arm64 already exists; skipping rebuild"
else
  echo "==> Building static proot-arm64 (PROOT_REF=$PROOT_REF)"
  TMP_PROOT="$(mktemp -d)"
  trap 'rm -rf "$TMP_PROOT"' EXIT

  docker buildx build --platform=linux/arm64 \
    --output "type=local,dest=$TMP_PROOT" \
    --build-arg PROOT_REF="$PROOT_REF" \
    -f - "$ROOT" <<'DOCKERFILE'
# syntax=docker/dockerfile:1
FROM alpine:3.20 AS builder
ARG PROOT_REF
RUN apk add --no-cache build-base git talloc-dev talloc-static \
      linux-headers musl-dev autoconf libarchive-dev libarchive-static \
      python3
# Try the requested ref, fall back to default branch. proot-me's
# release cadence is irregular so PROOT_REF defaults are best-effort.
# Cleanup the partial /proot from a failed --branch clone before
# retrying, otherwise the second clone aborts with "exists and is not
# empty".
RUN ( git clone --depth 1 --branch "${PROOT_REF}" \
        https://github.com/proot-me/proot.git /proot 2>/dev/null ) \
 || ( rm -rf /proot && \
      git clone --depth 1 https://github.com/proot-me/proot.git /proot )
WORKDIR /proot/src
# Static link. -no-pie because some musl static toolchains can't
# produce position-independent static executables. talloc-static
# provides the .a archives we need; libarchive-static is needed by
# newer proot versions that use it for `--rootfs`.
RUN make -j"$(nproc)" proot LDFLAGS="-static -no-pie" \
 || make -j"$(nproc)" proot LDFLAGS="-static"
RUN file proot && strip proot && ls -lh proot

FROM scratch
COPY --from=builder /proot/src/proot /proot-arm64
DOCKERFILE

  mv "$TMP_PROOT/proot-arm64" "$OUT/proot-arm64"
  chmod 0755 "$OUT/proot-arm64"
  echo "==> proot-arm64 size: $(ls -lh "$OUT/proot-arm64" | awk '{print $5}')"
fi

# ---------------------------------------------------------------------
# 2. Alpine rootfs with nodejs + claude-code
# ---------------------------------------------------------------------
#
# We build a single-stage image under qemu-arm64 then use `buildx
# --output type=tar` to export ONLY the final image filesystem as a
# tarball. That's the cleanest way to grab a rootfs:
#   - no docker layer overlays, no /proc/sys/dev placeholders
#   - works reliably across buildx versions (unlike the
#     `FROM scratch + COPY / /` trick, which has historically been
#     buggy when the source tree contains symlinks-to-directories)
#
# Why not `apk --root` from a docker-on-amd64 host? Because npm
# install for claude-code wants to execute arm64 binaries during
# postinstall scripts, and that only works inside the arm64 QEMU
# container.

echo "==> Building Alpine rootfs (this is the slow step under QEMU; 5-15 min)"

docker buildx build --platform=linux/arm64 \
  --output "type=tar,dest=/tmp/rootfs.tar" \
  --build-arg NPM_INSTALL="$NPM_INSTALL" \
  --build-arg ALPINE_VERSION="$ALPINE_VERSION" \
  -f - "$ROOT" <<'DOCKERFILE'
# syntax=docker/dockerfile:1
ARG ALPINE_VERSION=3.20
FROM alpine:${ALPINE_VERSION}

ARG NPM_INSTALL

# Tools the user will reach for the moment they get a shell. tmux is
# the persistence story (claude inside tmux, disconnect/reconnect at
# will). git/curl/ca-certificates are claude-code's runtime deps.
RUN apk add --no-cache \
      alpine-base bash coreutils tmux ca-certificates git curl \
      nodejs npm
# ca-certificates ships an `update-ca-certificates` hook script; we
# run it explicitly in case the package's postinstall didn't fire
# correctly under qemu. Wrapped in (...|| true) so a missing script
# doesn't blow the RUN layer.
RUN (update-ca-certificates 2>/dev/null || true)

# npm install -g claude-code. We don't bail if this fails — the rest
# of the rootfs is still useful, and the user can re-run `npm i -g
# @anthropic-ai/claude-code` from inside the shell later.
RUN npm config set fund false \
 && npm config set audit false \
 && npm config set update-notifier false \
 && (npm install -g $NPM_INSTALL || echo "WARN: npm install failed; rootfs ships without claude-code") \
 && (npm cache clean --force || true)

# Trim ~30 MB of dead weight before tarring
RUN rm -rf \
      /var/cache/apk/* \
      /usr/share/man /usr/share/doc /usr/share/info \
      /usr/share/locale \
      /root/.npm \
 && find /usr/lib -name "*.a" -delete 2>/dev/null || true \
 && find /usr/lib -name "*.la" -delete 2>/dev/null || true

# A friendlier first-prompt experience
RUN mkdir -p /root && cat > /root/.profile <<'EOF'
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export TERM="${TERM:-xterm-256color}"
export LC_ALL="${LC_ALL:-C.UTF-8}"
export LANG="${LANG:-C.UTF-8}"
export PS1='\[\e[36m\]alpine\[\e[0m\]:\w# '

if [ -t 1 ] && [ -z "$CS_WELCOMED" ]; then
  export CS_WELCOMED=1
  echo "Alpine $(cat /etc/alpine-release 2>/dev/null) on Android (claude-sessions)."
  command -v claude >/dev/null && echo "  claude:  $(claude --version 2>/dev/null || echo installed)"
  command -v tmux   >/dev/null && echo "  tmux:    available - wrap claude in 'tmux new -s work' for resume-on-reconnect"
  command -v node   >/dev/null && echo "  node:    $(node -v)"
  echo
fi
EOF

# Same for ash (busybox default) since PRoot will spawn /bin/sh which
# is symlinked to busybox ash, not bash.
RUN ln -sf /root/.profile /root/.ashrc \
 && echo 'export ENV=/root/.profile' >> /etc/profile

# Make sure /tmp exists with the right perms (some npm tools need it)
RUN mkdir -p /tmp && chmod 1777 /tmp
DOCKERFILE

echo "==> Recompressing tar with zstd -19"
# `buildx --output type=tar` writes a plain tar at /tmp/rootfs.tar.
# zstd recompresses it to the format the APK plugin expects to find.
zstd -19 --rm -f -o "$OUT/alpine-rootfs.tar.zst" /tmp/rootfs.tar

# ---------------------------------------------------------------------
# 3. Version marker for the APK
# ---------------------------------------------------------------------
# The plugin reads this at runtime to decide whether the rootfs on
# disk is current. Bumping it triggers a re-extraction on next launch.
date -u +'%Y%m%d-%H%M%S' > "$OUT/rootfs-version.txt"

echo
echo "==> Done. Assets in $OUT:"
ls -lh "$OUT/proot-arm64" "$OUT/alpine-rootfs.tar.zst" "$OUT/rootfs-version.txt"
