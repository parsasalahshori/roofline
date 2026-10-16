#!/bin/bash
# Where is this Mac's copy of the code? Branch, unsaved changes, and ahead/behind GitHub. Changes nothing but the
# local record of GitHub (git fetch).
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO" || exit 1
git fetch -q origin 2>/dev/null || echo "(could not reach GitHub: showing the last known state)"
branch="$(git branch --show-current)"
echo "Mac:      $(scutil --get ComputerName 2>/dev/null || hostname)"
echo "Branch:   $branch   (last commit: $(git log -1 --format='%h %s, %cr'))"
changed="$(git status --porcelain | grep -vc '^??')"
new="$(git status --porcelain | grep -c '^??')"
echo "Unsaved:  $changed changed files, $new new files (not committed)"
if git rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1; then
  read -r ahead behind < <(git rev-list --left-right --count HEAD...'@{u}')
  echo "GitHub:   $ahead commit(s) here not pushed, $behind commit(s) on GitHub not pulled"
  [ "$behind" != 0 ] && echo "          -> run: git pull"
  [ "$ahead" != 0 ] && echo "          -> run: git push"
else
  echo "GitHub:   this branch is not on GitHub yet -> run: git push -u origin $branch"
fi
exit 0
