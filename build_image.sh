#!/usr/bin/env bash
# VOS adaptation: run on a build host after syncing the authoritative local checkout.
#
# One command, no sheet bookkeeping: the host architecture decides which release
# sheets this image satisfies, the local commit names the tag, and a single build
# is recorded for every sheet of that architecture. MCPHub has no accelerator
# dependency, so the CUDA and CPU rows of one architecture are the same artifact.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHEET=""; COMMIT=""; BUILD_ONLY=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sheet) SHEET="$2"; shift 2 ;;
    --commit) COMMIT="$2"; shift 2 ;;
    --images) [[ "$2" == mcphub ]] || { echo 'Only mcphub is supported' >&2; exit 1; }; shift 2 ;;
    --build-only) BUILD_ONLY=true; shift ;;
    -h|--help)
      cat <<'EOF'
Usage: build_image.sh [--commit <sha>] [--build-only] [--sheet <sheet>]

Builds this checkout for the host architecture only. Everything else is inferred:
  --commit    source commit in the tag; defaults to the local HEAD
  --build-only  build and verify without pushing or recording the release sheet
  --sheet     limit the released sheets to one entry (default: every sheet of
              this architecture)
EOF
      exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

case "$(uname -m)" in
  x86_64|amd64)
    ARCH=amd64; NATIVE=x86_64
    PREFIX=amd_cpu
    DEFAULT_SHEETS='AMD_with_mxn100 AMD_with_cuda' ;;
  aarch64|arm64)
    ARCH=arm64; NATIVE=aarch64
    PREFIX=arm_cpu
    DEFAULT_SHEETS='ARM_without_cuda ARM_with_cuda l4t thor_spark' ;;
  *)
    echo "Unsupported build architecture: $(uname -m)" >&2; exit 1 ;;
esac

if [[ -z "$COMMIT" ]]; then
  COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
  [[ -n "$COMMIT" ]] || { echo 'Pass the source commit with --commit (not a git checkout)' >&2; exit 1; }
fi
[[ "$COMMIT" =~ ^[a-f0-9]{7,40}$ ]] || { echo "Not a commit hash: $COMMIT" >&2; exit 1; }
SHORT_COMMIT="${COMMIT:0:10}"

if [[ -n "$SHEET" ]]; then
  declare -a SHEETS=("$SHEET")
else
  read -r -a SHEETS <<< "$DEFAULT_SHEETS"
fi

BUILD_ROOT="${MCPHUB_BUILD_ROOT:-$HOME/dev/build/mcphub}"
mkdir -p "$BUILD_ROOT"
REPOSITORY=swr.cn-southwest-2.myhuaweicloud.com/ictrek/mcphub
TAG="${PREFIX}_$(TZ=Asia/Shanghai date +%Y%m%d_%H%M%S)_${SHORT_COMMIT}"
IMAGE="$REPOSITORY:$TAG"
LOG="$BUILD_ROOT/build-$PREFIX.log"

# Reuse an image already built here for the same architecture and commit: the
# release sheets of one architecture differ only in their table row.
find_reusable_image() {
  local want_arch="$1" tag arch
  while read -r tag; do
    [[ "$tag" == *_"$SHORT_COMMIT" ]] || continue
    arch="$(docker image inspect "$REPOSITORY:$tag" --format '{{.Architecture}}' 2>/dev/null || true)"
    [[ "$arch" == "$want_arch" ]] || continue
    printf '%s\n' "$tag"
    return 0
  done < <(docker images "$REPOSITORY" --format '{{.Tag}}' 2>/dev/null || true)
  return 1
}

echo "host $(uname -m) → linux/$ARCH, sheets: ${SHEETS[*]}, commit $SHORT_COMMIT"
REUSED=false
if REUSE_TAG="$(find_reusable_image "$ARCH")"; then
  echo "Reusing $REPOSITORY:$REUSE_TAG (same architecture and commit; nothing to rebuild)"
  docker tag "$REPOSITORY:$REUSE_TAG" "$IMAGE"
  REUSED=true
else
  CONTEXT="$(mktemp -d "$BUILD_ROOT/context.XXXXXX")"
  trap 'rm -rf "$CONTEXT"' EXIT
  tar -C "$ROOT" --exclude=.git --exclude=node_modules --exclude=dist --exclude=coverage -cf - . | tar -C "$CONTEXT" -xf -
  echo "Building $IMAGE for linux/$ARCH — full log: $LOG"
  # tee, not a redirect: the build takes minutes on a slow link and silence reads
  # as a hang. pipefail (set above) keeps a failed build fatal through the pipe.
  docker buildx build --load --provenance=false --sbom=false --platform "linux/$ARCH" \
    --progress=plain --target vos --build-arg INSTALL_EXT=false -t "$IMAGE" \
    -f "$CONTEXT/Dockerfile" "$CONTEXT" </dev/null 2>&1 | tee -a "$LOG"
fi
# The image must contain the compiled VOS backend, frontend and a non-root runtime.
docker run --rm --entrypoint bash "$IMAGE" -lc 'test -f dist/services/vosAuthService.js && test -f frontend/dist/index.html && id mcphub && ! command -v dockerd'
PYTHONDONTWRITEBYTECODE=1 python3 "$ROOT/scripts/verify-vos-runtime.py" --image "$IMAGE"
docker run --rm "$IMAGE" node scripts/verify-vos-demo.mjs
if [[ "$BUILD_ONLY" != true ]]; then
  docker push "$IMAGE"
  docker manifest inspect "$IMAGE" >/dev/null
  for sheet in "${SHEETS[@]}"; do
    python3 "$ROOT/ictrek.app/scripts/record_image.py" --sheet "$sheet" --component mcphub --repository "$REPOSITORY" --tag "$TAG"
  done
fi
echo "Image: $IMAGE (published=$([[ "$BUILD_ONLY" == false ]] && echo true || echo false), reused=$REUSED, sheets=${SHEETS[*]})"
