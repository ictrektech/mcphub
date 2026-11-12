#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
version_file="$root/ictrek.app/VERSION"
mode="${1:-patch}"
[[ "$#" -le 1 && ( "$mode" == patch || "$mode" == --dry-run ) ]] || {
  echo "Usage: $0 [patch|--dry-run]" >&2
  exit 1
}
version="$(python3 "$root/ictrek.app/scripts/vos_version.py" next)"
if [[ "$mode" == --dry-run ]]; then
  printf '%s\n' "$version"
  exit 0
fi
trigger="vos-mcphub-v${version}"
public_tag="v${version}"
cd "$root"
[[ -z "$(git status --porcelain)" ]] || { echo "worktree is not clean" >&2; exit 1; }
for release_tag in "$trigger" "$public_tag"; do
  git show-ref --verify --quiet "refs/tags/$release_tag" && { echo "tag exists: $release_tag" >&2; exit 1; }
done
branch="$(git symbolic-ref --quiet --short HEAD)"
remote_tags="$(git ls-remote --tags origin "refs/tags/${trigger}" "refs/tags/${public_tag}")"
[[ -z "$remote_tags" ]] || { echo "release tag already exists on origin" >&2; exit 1; }
printf '%s\n' "$version" > "$version_file"
git add ictrek.app/VERSION
git commit -m "chore: release VOS mcphub ${version}"
git tag "$trigger"
git push --atomic origin "$branch" "$trigger"
echo "Pushed ${trigger}"
