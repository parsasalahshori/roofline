#!/bin/bash
# Keeps this Mac's ~/roofline-demo in step with GitHub, every few minutes (run by launchd; see autosync-install.sh).
# - Committed work on the current branch is pushed.
# - New work on GitHub is pulled, but only as a fast-forward and only when there are no unsaved edits.
# - Branches that are not checked out (e.g. real-lookups) are fast-forwarded too.
# - If both Macs changed the same branch (diverged), or a merge is half done, it changes nothing and notifies you.
REPO="${ROOFLINE_REPO:-$HOME/roofline-demo}"
LOG="$HOME/Library/Logs/roofline-autosync.log"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
say() { echo "$(date '+%F %T') $*" >> "$LOG"; }
notify() { say "NOTICE $*"; osascript -e "display notification \"$*\" with title \"Roofline sync\"" >/dev/null 2>&1; }
cd "$REPO" 2>/dev/null || { say "no repo at $REPO"; exit 0; }
LOCK="$REPO/.git/autosync.lock"
mkdir "$LOCK" 2>/dev/null || exit 0
trap 'rmdir "$LOCK"' EXIT
g="$(git rev-parse --git-dir)"
if [ -e "$g/MERGE_HEAD" ] || [ -d "$g/rebase-merge" ] || [ -d "$g/rebase-apply" ]; then say "merge/rebase in progress: skipped"; exit 0; fi
git fetch -q origin 2>>"$LOG" || { say "fetch failed (offline?)"; exit 0; }

branch="$(git branch --show-current)"
[ -n "$branch" ] || { say "detached HEAD: skipped"; exit 0; }
if ! git rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1; then
  if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then git branch -q --set-upstream-to="origin/$branch"
  else git push -q -u origin "$branch" 2>>"$LOG" && say "pushed new branch $branch"; exit 0; fi
fi
read -r ahead behind < <(git rev-list --left-right --count HEAD...'@{u}')
dirty="$(git status --porcelain --untracked-files=no | wc -l | tr -d ' ')"
if [ "$ahead" != 0 ] && [ "$behind" != 0 ]; then
  notify "$branch changed on both Macs. Ask Claude to merge it."
elif [ "$ahead" != 0 ]; then
  git push -q origin "$branch" 2>>"$LOG" && say "pushed $ahead commit(s) on $branch" || notify "Push of $branch failed: see $LOG"
elif [ "$behind" != 0 ]; then
  if [ "$dirty" = 0 ]; then git merge -q --ff-only '@{u}' 2>>"$LOG" && say "pulled $behind commit(s) into $branch"
  else say "$branch is $behind behind GitHub, but has unsaved edits: not pulled yet"; fi
fi

# Other local branches that track GitHub and are not checked out anywhere: fast-forward only.
for b in $(git for-each-ref --format='%(refname:short)' refs/heads); do
  [ "$b" = "$branch" ] && continue
  git worktree list --porcelain | grep -qx "branch refs/heads/$b" && continue
  up="$(git rev-parse --abbrev-ref "$b@{u}" 2>/dev/null)" || continue
  if git merge-base --is-ancestor "$b" "$up" 2>/dev/null && [ "$(git rev-parse "$b")" != "$(git rev-parse "$up")" ]; then
    git update-ref "refs/heads/$b" "$up" && say "fast-forwarded $b"
  fi
done
exit 0
