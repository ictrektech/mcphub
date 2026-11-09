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
mkdir -p "$BUILD_ROOT/context"
rsync -a --delete --exclude .git --exclude node_modules --exclude dist --exclude coverage "$ROOT/" "$BUILD_ROOT/context/"
REPOSITORY=swr.cn-southwest-2.myhuaweicloud.com/ictrek/mcphub
TAG="${PREFIX}_$(TZ=Asia/Shanghai date +%Y%m%d_%H%M%S)_${COMMIT:0:10}"
IMAGE="$REPOSITORY:$TAG"
docker buildx build --load --provenance=false --sbom=false --platform "linux/$ARCH" \
  --target vos --build-arg INSTALL_EXT=false -t "$IMAGE" \
  -f "$BUILD_ROOT/context/Dockerfile" "$BUILD_ROOT/context" > "$BUILD_ROOT/build-$PREFIX.log" 2>&1 </dev/null
# The image must contain the compiled VOS backend, frontend and a non-root runtime.
docker run --rm --entrypoint bash "$IMAGE" -lc 'test -f dist/services/vosAuthService.js && test -f frontend/dist/index.html && id mcphub && ! command -v dockerd'
PYTHONDONTWRITEBYTECODE=1 python3 "$ROOT/scripts/verify-vos-runtime.py" --image "$IMAGE"
if [[ "$BUILD_ONLY" != true ]]; then
  docker push "$IMAGE"
  docker manifest inspect "$IMAGE" >/dev/null
  python3 "$ROOT/ictrek.app/scripts/record_image.py" --sheet "$SHEET" --component mcphub --repository "$REPOSITORY" --tag "$TAG"
fi
echo "Built image: $IMAGE (published=$([[ "$BUILD_ONLY" == false ]] && echo true || echo false))"
