# Working on Roofline from two Macs

The code lives in one place: the private GitHub repo `parsasalahshori/roofline`. Each Mac has its own copy, and
GitHub keeps them in step. Nothing is lost as long as work is pushed.

- **MacBook Pro**: the main workshop. Build, run the app, and run agents and benchmarks here.
- **MacBook Air**: sees everything the Pro does, reviews, and makes small changes on its own branches.

## The four rules

1. **Pull before you start.** `git pull` (or ask Claude: "sync with GitHub"). The Macs are set to fast-forward
   only, so a pull can never silently merge or overwrite anything.
2. **Push when a piece is done.** Commit and push. Small and often is safest.
3. **One branch, one Mac.** Never edit the same branch on both Macs at the same time. The Pro works on `real-lookups`
   and its feature branches. If the Air needs to change something, it makes its own branch (`air/<what>`) and pushes it.
   Then the Pro merges it.
4. **Keep the code folder out of iCloud and Dropbox.** The repo lives at `~/roofline-demo`, not in Desktop or
   Documents. File-sync services fight with git and corrupt repos.

## Seeing the Pro's work live from the Air

- **Claude sessions:** sessions running on the Pro show up on the Air through Remote Control: in the Claude app's
  session list, or at claude.ai/code. You can watch them and send them messages from the Air.
- **Uncommitted work, files and the running app:**
  1. Once, on the Pro: System Settings → General → Sharing → turn on **Remote Login**.
  2. Then, from the Air: `ssh <your-user>@<Pro name>.local`. The Pro's name is shown in Sharing.
  3. Claude on the Air can then read the Pro's files, see `git status` and `git diff`, and open the Pro's running app.
     The app is local to the Pro, so open it through a tunnel: `ssh -L 4600:localhost:4600 <Pro>` gives
     http://localhost:4600 on the Air.
  4. If the Macs are on different Wi-Fi, use Tailscale (free) so the Air can still reach the Pro.
- **Pushed work:** `git pull` on the Air, any time.

## Background sync (installed on both Macs)

`scripts/new-mac/autosync.sh` runs every 3 minutes (launchd, `com.roofline.autosync`):
- It pushes any committed work on the current branch.
- It pulls new work from GitHub, as a fast-forward only, and only when there are no unsaved edits.
- It fast-forwards the other branches that track GitHub.
- If the same branch changed on both Macs, it changes nothing and shows a notification: ask Claude to merge it.
- Log: `~/Library/Logs/roofline-autosync.log`. Remove it with `bash scripts/new-mac/autosync-install.sh --remove`.

So: work on both Macs at the same time on different branches, commit as you go, and each Mac sees the other's
committed work within a few minutes. Merge finished branches into `real-lookups`.

`bash scripts/new-mac/where.sh` prints, for this Mac: the branch, uncommitted files, and how far it is ahead of or
behind GitHub. Run it on both Macs when unsure.

## What git does not carry (copy once with scripts/new-mac/make-bundle.sh)

| What | Where | Why it is not in git |
|---|---|---|
| API keys | `~/roofline-demo/.env.keys` | Secrets. AirDrop them, never commit them. |
| Benchmark houses, lidar truth | `~/RooflineWork/roof-bench` | Big, and some of it is Google data with a 30-day keep limit (delete by about Nov 10-13 2026 on BOTH Macs). |
| Window model (OWLv2, optional) | `~/RooflineWork/models` | 155 MB of model weights |
| Saved test data | `~/RooflineWork/saved-testdata` | Big, and not code |

## Setting up a new Mac

1. `gh auth login`, then `git clone https://github.com/parsasalahshori/roofline.git ~/roofline-demo`, then
   `cd ~/roofline-demo && git switch real-lookups`.
2. AirDrop `~/roofline-transfer` from the Air (made by `bash scripts/new-mac/make-bundle.sh`). It lands in `~/Downloads`.
3. `bash scripts/new-mac/setup.sh`. Do any step it marks YOU, then run it again until it says Done.
4. `npm run demo`, then open http://localhost:4500 (login owner@summitridge.test / summit-ridge-demo).
