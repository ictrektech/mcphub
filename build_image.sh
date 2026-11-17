#!/usr/bin/env bash
# VOS adaptation: run on a build host after syncing the authoritative local checkout.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHEET=""; COMMIT=""; BUILD_ONLY=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sheet) SHEET="$2"; shift 2 ;;
    --commit) COMMIT="$2"; shift 2 ;;
    --images) [[ "$2" == mcphub ]] || { echo 'Only mcphub is supported' >&2; exit 1; }; shift 2 ;;
    --build-only) BUILD_ONLY=true; shift ;;
    -h|--help) echo 'build_image.sh --sheet <platform-sheet> --commit <local-source-commit> [--images mcphub] [--build-only]'; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done
[[ "$COMMIT" =~ ^[a-f0-9]{7,40}$ ]] || { echo 'Pass the authoritative local source commit with --commit' >&2; exit 1; }
case "$SHEET" in
  AMD_with_mxn100) ARCH=amd64; PREFIX=amd_cpu ;;
  AMD_with_cuda) ARCH=amd64; PREFIX=amd ;;
  ARM_without_cuda) ARCH=arm64; PREFIX=arm_cpu ;;
  ARM_with_cuda) ARCH=arm64; PREFIX=arm ;;
  l4t) ARCH=arm64; PREFIX=l4t ;;
  thor_spark) ARCH=arm64; PREFIX=thor_spark ;;
  *) echo 'An explicit supported --sheet is required; see ictrek.app/README.md' >&2; exit 1 ;;
esac
BUILD_ROOT="${MCPHUB_BUILD_ROOT:-$HOME/dev/build/mcphub}"
mkdir -p "$BUILD_ROOT"
REPOSITORY=swr.cn-southwest-2.myhuaweicloud.com/ictrek/mcphub
SHORT_COMMIT="${COMMIT:0:10}"
TAG="${PREFIX}_$(TZ=Asia/Shanghai date +%Y%m%d_%H%M%S)_${SHORT_COMMIT}"
IMAGE="$REPOSITORY:$TAG"
LOG="$BUILD_ROOT/build-$PREFIX.log"

# This application has no accelerator dependency: the sheets only differ by CPU
# architecture, so the CUDA and CPU rows of one architecture are byte-identical
# images. Reuse an image already built here for the same architecture and commit
# instead of paying for the same build six times.
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

REUSED=false
if REUSE_TAG="$(find_reusable_image "$ARCH")"; then
  echo "Reusing $REPOSITORY:$REUSE_TAG for linux/$ARCH (commit $SHORT_COMMIT already built)"
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
  python3 "$ROOT/ictrek.app/scripts/record_image.py" --sheet "$SHEET" --component mcphub --repository "$REPOSITORY" --tag "$TAG"
fi
echo "Built image: $IMAGE (published=$([[ "$BUILD_ONLY" == false ]] && echo true || echo false), reused=$REUSED)"
