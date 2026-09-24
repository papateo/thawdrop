#!/usr/bin/env bash
# Publishes the current state of this repo to the PUBLIC GitHub repo without
# exposing the private history.
#
#   origin  private remote, full history — day-to-day work goes here
#   github  public (papateo/thawdrop) — receives one clean commit per sync
#
# Each run takes the files tracked at HEAD (so .gitignore'd things — keys,
# builds, .env, IDE files — are never included), wraps them in ONE new commit
# authored with the GitHub noreply address, and stacks it on top of what's
# already public. Private commit messages, authors and old file versions
# (e.g. the DMG that used to be tracked) never reach GitHub.
#
# Usage:
#   ./scripts/publish-public.sh "Release notes / commit message"        # dry run
#   ./scripts/publish-public.sh --push "Release notes / commit message" # publish

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

PUBLIC_REMOTE="${PUBLIC_REMOTE:-github}"
PUBLIC_BRANCH="${PUBLIC_BRANCH:-main}"
AUTHOR_NAME="${PUBLIC_AUTHOR_NAME:-Muh. Syafiudin}"
AUTHOR_EMAIL="${PUBLIC_AUTHOR_EMAIL:-322349928+papateo@users.noreply.github.com}"

push=false
if [ "${1:-}" = "--push" ]; then
  push=true
  shift
fi
message="${1:-}"
if [ -z "$message" ]; then
  echo "Give a commit message, e.g.: $0 \"Add folder sharing\"" >&2
  exit 1
fi

# Only what is committed at HEAD is published; say so if there's other work in
# progress, so it isn't a surprise that it's missing.
if ! git diff --quiet HEAD --; then
  echo "Note: these uncommitted changes are NOT included in the public commit:" >&2
  git diff --name-only HEAD -- | sed 's/^/  /' >&2
  echo >&2
fi

if ! git remote get-url "$PUBLIC_REMOTE" >/dev/null 2>&1; then
  echo "Remote '$PUBLIC_REMOTE' not found. Add it with:" >&2
  echo "  git remote add $PUBLIC_REMOTE git@github.com:papateo/thawdrop.git" >&2
  exit 1
fi

# Build on top of the public branch if it exists, so the public history is a
# normal fast-forward-only line. ls-remote exits 2 when the branch simply doesn't exist yet (fine: first
# publish) but any other failure (SSH, auth, network) must stop us — otherwise a
# broken connection would look like an empty repo.
parent=""
status=0
git ls-remote --exit-code --heads "$PUBLIC_REMOTE" "$PUBLIC_BRANCH" >/dev/null 2>&1 || status=$?
if [ "$status" -eq 0 ]; then
  git fetch -q "$PUBLIC_REMOTE" "$PUBLIC_BRANCH"
  parent="$(git rev-parse FETCH_HEAD)"
elif [ "$status" -ne 2 ]; then
  echo "Could not reach '$PUBLIC_REMOTE' (is SSH set up? try: ssh -T git@github.com)." >&2
  exit 1
fi

tree="$(git rev-parse 'HEAD^{tree}')"
if [ -n "$parent" ] && [ "$(git rev-parse "$parent^{tree}")" = "$tree" ]; then
  echo "Public repo already matches HEAD — nothing to publish."
  exit 0
fi

new_commit="$(
  GIT_AUTHOR_NAME="$AUTHOR_NAME" GIT_AUTHOR_EMAIL="$AUTHOR_EMAIL" \
  GIT_COMMITTER_NAME="$AUTHOR_NAME" GIT_COMMITTER_EMAIL="$AUTHOR_EMAIL" \
    git commit-tree "$tree" ${parent:+-p "$parent"} -m "$message"
)"

echo "Public commit: $new_commit"
echo "  author : $AUTHOR_NAME <$AUTHOR_EMAIL>"
echo "  parent : ${parent:-none (first public commit)}"
echo "  files  : $(git ls-tree -r --name-only "$new_commit" | wc -l | tr -d ' ')"

if [ "$push" != true ]; then
  echo
  echo "Dry run — nothing was pushed. Inspect with:  git show --stat $new_commit"
  echo "Publish with:  $0 --push \"$message\""
  exit 0
fi

git push "$PUBLIC_REMOTE" "$new_commit:refs/heads/$PUBLIC_BRANCH"
echo "Pushed to $PUBLIC_REMOTE/$PUBLIC_BRANCH."
