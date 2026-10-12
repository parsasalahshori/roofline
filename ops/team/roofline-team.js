export const meta = {
  name: 'roofline-team',
  description: 'Opus contacts oversee Sonnet leads; each lead splits a plan task across up to 3 Haiku builders, reviews their code, gets fixes checked by its Opus contact, and Haiku applies them',
  whenToUse: 'Building or reviewing Roofline plan tasks in prepared git worktrees',
  phases: [
    { title: 'Plan', detail: 'Sonnet leads split tasks into Haiku packages', model: 'sonnet' },
    { title: 'Build', detail: 'Haiku builders (up to 3 per lead)', model: 'haiku' },
    { title: 'Review', detail: 'Sonnet leads review and propose fixes', model: 'sonnet' },
    { title: 'Check fixes', detail: 'Opus contacts approve, amend or reject fixes', model: 'opus' },
    { title: 'Fix', detail: 'Haiku builders apply approved fixes', model: 'haiku' },
    { title: 'Commit', detail: 'Sonnet leads verify, commit and report', model: 'sonnet' },
    { title: 'Group check', detail: 'Opus contact checks its tasks fit together', model: 'opus' },
  ],
}

const A = args
// Builders are Haiku by default. A task may set builder: 'sonnet' for risky work (Ruling AQ in AGENTS.md):
// cross-shell UI integration, concurrency/locking, migrations, LLM conversation logic, the Python service.
// Where dbtest and ci-check live: ops/bin in the repo (pass args.binDir), or ~/RooflineWork/bin on the Mac.
const BIN = A.binDir || '~/RooflineWork/bin/'
const MAX_ROUNDS = 3

const RULES = [
  'House rules (all agents):',
  '- Never spawn subagents.',
  '- Work only inside the worktree named for your task. Never touch other worktrees or other checkouts. Never push, merge, rebase, stash, reset, or switch branches. Never create or commit .env files.',
  A.cloud ? '- This is a 4-CPU cloud box shared by many agents. Run heavy commands (npm run typecheck, npm run lint, npm run lint:css, npm run build:web, or a whole web/ui vitest project) through the slot wrapper: ' + BIN + 'slot <command>. Focused vitest files need no wrapper.' : '- If npm creates a nested node_modules directory, run: xattr -w com.apple.fileprovider.ignore#P 1 <that dir>.',
  '- Repo style: ESM, explicit .ts/.tsx extensions on relative imports, strict TypeScript, CSS Modules with the S1 tokens, no letter-containing literal UI text in JSX (text comes from apps/web/src/copy/*.ts or props), no raw <button> in apps/web/src.',
  '- Known unrelated flake: apps/api/test/rep-visibility.test.ts:400 (a random UUID can contain 333); if only that fails, re-run that file alone.',
  A.cloud ? '- There is NO Docker on this machine: never run database-backed tests (vitest for @roofline/db, @roofline/api or @roofline/worker, or any test file under packages/db, apps/api or apps/worker that starts a database) locally; they cannot start. Write them carefully and let GitHub Actions run them through ' + BIN + 'ci-check. Never try to start Docker.' :
  '- Database-backed tests (vitest for @roofline/db, @roofline/api or @roofline/worker, or any test file under packages/db, apps/api or apps/worker) start emulated PostGIS containers and this machine can only run a couple at once. ALWAYS run them through the slot wrapper, for example: ' + BIN + 'dbtest npx vitest run --project @roofline/api --testTimeout=60000 . Waiting for a slot is normal. Never start a database container yourself, and never stop or remove containers. Web/ui/shared/send-gate tests do not need the wrapper. Run only FOCUSED database test files locally; the complete database suites run on GitHub Actions through ' + BIN + 'ci-check (see the commit step).',
  '- GitHub: the repo is the private parsasalahshori/roofline. You may push ONLY your own task branch, and only through ' + BIN + 'ci-check. Never force-push, never push another branch, never open pull requests.',
  '- Global constraints file (binding): see the task header.',
].join('\n')

const PLAN = { type: 'object', properties: {
  packages: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'object', properties: {
    id: { type: 'string' }, files: { type: 'array', items: { type: 'string' } },
    instructions: { type: 'string' }, testCommand: { type: 'string' } },
    required: ['id', 'files', 'instructions', 'testCommand'] } },
  sharedNotes: { type: 'string' } }, required: ['packages', 'sharedNotes'] }
const WORK = { type: 'object', properties: {
  status: { type: 'string', enum: ['done', 'blocked'] }, filesChanged: { type: 'array', items: { type: 'string' } },
  testsRun: { type: 'string' }, notes: { type: 'string' } }, required: ['status', 'filesChanged', 'testsRun', 'notes'] }
const REVIEW = { type: 'object', properties: {
  verifyPassed: { type: 'boolean' }, verifyTail: { type: 'string' },
  findings: { type: 'array', items: { type: 'object', properties: {
    id: { type: 'string' }, severity: { type: 'string', enum: ['critical', 'important'] },
    file: { type: 'string' }, problem: { type: 'string' }, proposedFix: { type: 'string' } },
    required: ['id', 'severity', 'file', 'problem', 'proposedFix'] } },
  minors: { type: 'array', items: { type: 'string' } }, clean: { type: 'boolean' } },
  required: ['verifyPassed', 'verifyTail', 'findings', 'minors', 'clean'] }
const CHECK = { type: 'object', properties: {
  fixes: { type: 'array', items: { type: 'object', properties: {
    id: { type: 'string' }, verdict: { type: 'string', enum: ['approve', 'amend', 'reject'] },
    file: { type: 'string' }, finalInstruction: { type: 'string' }, reason: { type: 'string' } },
    required: ['id', 'verdict', 'file', 'finalInstruction', 'reason'] } } }, required: ['fixes'] }
const COMMIT = { type: 'object', properties: {
  committed: { type: 'boolean' }, sha: { type: 'string' }, verifyPassed: { type: 'boolean' },
  testSummary: { type: 'string' }, notes: { type: 'string' } },
  required: ['committed', 'sha', 'verifyPassed', 'testSummary', 'notes'] }
const GROUP = { type: 'object', properties: {
  issues: { type: 'array', items: { type: 'object', properties: {
    severity: { type: 'string', enum: ['critical', 'important', 'minor'] }, tasks: { type: 'array', items: { type: 'number' } },
    problem: { type: 'string' }, suggestion: { type: 'string' } }, required: ['severity', 'tasks', 'problem', 'suggestion'] } },
  mergeNotes: { type: 'string' } }, required: ['issues', 'mergeNotes'] }

function head(t) {
  return 'Roofline (multi-company roofing SaaS; milestone ' + (t.milestone || A.milestone || 'F2, the web shell') + ') Task ' + t.n + ': ' + t.title + '.\n' +
    'Worktree: ' + t.worktree + ' (branch ' + t.branch + '). Task brief (requirements with exact values): ' + t.brief + '\n' +
    'Global constraints file (binding): ' + (t.constraints || A.constraints) + '\n' +
    'Context from other tasks and controller rulings:\n' + t.context + '\n'
}

function planPrompt(t) {
  return 'You are the Sonnet lead for ' + head(t) + '\n' + RULES + '\n\n' +
    'You lead up to 3 Haiku builders who will implement your packages AT THE SAME TIME in this same worktree. Planning only:\n' +
    (t.mode === 'resume' ? 'IMPORTANT: builders already did part of this task before an interruption; their partial work is in the worktree as WIP commits since ' + t.base + ' plus any uncommitted changes (git -C ' + t.worktree + ' log --oneline ' + t.base + '..HEAD; git -C ' + t.worktree + ' diff ' + t.base + '; git status). Never rewrite or squash those commits; commit on top. Keep what is right, and plan packages for the REMAINING work and for anything partial or wrong.\n' : '') +
    '1. Read the brief, the global constraints and the existing code the task touches.\n' +
    '2. If the task needs new npm packages, install them now in the worktree (npm i <pkg> -w <workspace>), so builders never touch package.json or package-lock.json. You may also create shared type-only files or minimal module shells that several packages import, so each package compiles on its own. Do not write the implementation or the tests.\n' +
    '3. Split the task into 3 packages (fewer only if the task truly has fewer independent parts). Every file the task touches belongs to exactly one package; no two packages edit the same file. Shared-file edits (index.ts exports, app.ts mounts, router wiring, config, copy files used by several parts) go to one package.\n' +
    '4. For each package write instructions a Haiku model can follow without guessing: exact files to create or modify; exact exported names and signatures (copy them from the brief); what it consumes from the other packages by exact name; the tests it owns (test names and assertions from the brief, with exact values); and a focused command that runs only its own test files (for example: npx vitest run apps/web/test/x.test.tsx). Builders cannot see the brief unless you point them to the exact section, so be explicit.\n' +
    'Return the packages and shared notes (what is installed, which shells you created, cross-package names).'
}

function buildPrompt(t, p, notes) {
  return 'You are a ' + (t.builder === 'sonnet' ? 'Sonnet' : 'Haiku') + ' builder on ' + head(t) + 'Your package: ' + p.id + '. Other builders are editing OTHER files in this same worktree at the same time.\n' +
    'Files you own (touch only these): ' + p.files.join(', ') + '\n\nInstructions from your Sonnet lead:\n' + p.instructions + '\n\nShared notes from the lead:\n' + notes + '\n\n' + RULES + '\n\n' +
    'Work test-first: write your tests, run them and see them fail, then implement until they pass. Run only your own tests: ' + p.testCommand + '\n' +
    'A failure in a file you do not own is not yours; ignore it. Do not run whole-workspace suites. Do not commit, stage or install packages. If you are blocked, stop and say exactly why.\n' +
    'Return status, files changed, the test command and result, and notes for your lead.'
}

function reviewPrompt(t, round, decided) {
  return 'You are the Sonnet lead for ' + head(t) + '\n' + RULES + '\n\n' +
    'Review round ' + (round + 1) + ' of your builders\' work. Changes under review: everything since commit ' + t.base + ' in the worktree (git -C ' + t.worktree + ' log --oneline ' + t.base + '..HEAD; git -C ' + t.worktree + ' diff ' + t.base + '; untracked files from git -C ' + t.worktree + ' status --porcelain).' +
    (t.priorReport ? ' The earlier implementer report is at ' + t.priorReport + ' (unverified claims).' : '') + '\n' +
    (decided.length ? 'Already decided in earlier rounds (do not raise again unless the fix is missing or wrong):\n' + decided.join('\n') + '\n' : '') +
    'Do not modify any files. Steps:\n1. Run the verify command from the worktree root and record the result: ' + t.verify + '\n' +
    '2. Review against the brief (missing / extra / misunderstood) and for quality: correctness, edge cases, error handling, tests that check real behaviour (not mocks of themselves), accessibility for UI, the copy rules, and the global constraints.\n' +
    'Report every Critical or Important problem, and every failing test, lint, typecheck or build, as a finding with file:line, the problem, and a precise proposed fix a Haiku model can apply (what to change, where, and how to check it). Polish goes in minors (not fixed now). clean = the verify command passed and there are no Critical or Important findings.'
}

function checkPrompt(t, contact, review) {
  return 'You are ' + contact + ', an Opus contact overseeing three Sonnet leads on ' + head(t) + '\n' + RULES + '\n\n' +
    'The Sonnet lead reviewed its Haiku builders\' code (changes since ' + t.base + ') and proposes the fixes below. For each finding, inspect the actual code and decide: approve (real problem, right fix), amend (real problem but the fix is wrong or incomplete: write the corrected instruction), or reject (not a real problem, or the fix would break something: say why). Write each finalInstruction precisely enough for a Haiku model: exact file, what to change, how to check it. Do not modify files.\n' +
    'Verify result reported by the lead: ' + (review.verifyPassed ? 'passed' : 'FAILED') + '\n' + review.verifyTail.slice(-3000) + '\n\nFindings:\n' + JSON.stringify(review.findings, null, 1)
}

function fixPrompt(t, fixes) {
  const files = Array.from(new Set(fixes.map((f) => f.file)))
  return 'You are a ' + (t.builder === 'sonnet' ? 'Sonnet' : 'Haiku') + ' builder applying review fixes on ' + head(t) + '\n' + RULES + '\n\n' +
    'Apply exactly these fixes (each approved by the Opus contact), nothing else. Other builders may be fixing other files at the same time. Files: ' + files.join(', ') + '\n\n' +
    fixes.map((f, i) => (i + 1) + '. [' + f.id + '] ' + f.file + ': ' + f.finalInstruction).join('\n') + '\n\n' +
    'Then run the tests that cover the files you changed (focused vitest paths) and, if you changed TypeScript, npm run typecheck from the worktree root. Do not commit or stage. Return status, files changed, what you ran and the result.'
}

function leadFixPrompt(t, fixes) {
  return 'You are the Sonnet lead for ' + head(t) + '\n' + RULES + '\n\n' +
    'Your builders could not close these approved fixes in ' + MAX_ROUNDS + ' rounds. Apply them yourself, carefully, then run: ' + t.verify + '\nFixes:\n' +
    fixes.map((f, i) => (i + 1) + '. [' + f.id + '] ' + f.file + ': ' + f.finalInstruction).join('\n') + '\nDo not commit. Return status, files changed, what you ran and the result.'
}

function commitPrompt(t, summary) {
  return 'You are the Sonnet lead for ' + head(t) + '\n' + RULES + '\n\n' +
    'Finalize the task:\n1. Run from the worktree root: ' + t.verify + '\nIf it fails, make only the smallest changes needed to pass and say what you changed; if it cannot pass, do not commit and explain.\n' +
    '2. Check git status. Stage only this task\'s files (never .env, dist, node_modules, test-results or reports) and commit. Message: ' + t.commitMsg + '\nBody: one line per package and per review round, then a blank line and the Co-Authored-By trailer that your own environment attribution instructions give\nIf there is nothing to commit (a review with no fixes), skip the commit.\n' +
    (t.ci ? '2b. Then, from the worktree, run ' + (t.ciEnv ? t.ciEnv + ' ' : '') + BIN + 'ci-check (it pushes your task branch and waits for the full CI run on GitHub, which includes the database suites). If it fails, read the printed log, make the smallest fix, commit again and re-run ci-check, at most 2 more times. Report the CI result (run id, passed or failed) in testSummary; verifyPassed is false if CI still fails.\n' : '') +
    '3. Append a report to ' + t.report + ': what was built and by which packages, each review round with its findings and outcome (fixed / amended / rejected with reason), the minors, and the verify output tail.\n' +
    'Team summary so far:\n' + summary + '\nReturn committed, sha (git rev-parse --short HEAD after), verifyPassed, testSummary, notes.'
}

function groupPrompt(contact, group, results) {
  const lines = group.map((t, i) => {
    const r = results[i]
    return 'Task ' + t.n + ' (' + t.title + '): worktree ' + t.worktree + ', branch ' + t.branch + ', base ' + t.base + ', head ' + (r && r.sha ? r.sha : 'unknown') + ', status ' + (r ? r.status : 'failed')
  }).join('\n')
  return 'You are ' + contact + ', the Opus contact for these Roofline tasks (' + group.map((t) => (t.milestone || A.milestone || 'F2') + ' T' + t.n + ' -> ' + (t.integrationBranch || A.integrationBranch || 'f2-shell')).join(', ') + '). They were built on separate branches in parallel and will be merged into their integration branches by the controller.\n' + lines + '\n' + RULES + '\n\n' +
    'Read each diff (git -C <worktree> diff <base>..HEAD) and the briefs. Check how they fit together: interfaces one produces and another consumes (names, types, props), duplicated helpers, edits to the same files (predict merge conflicts and say exactly how to resolve each), and consistency with the copy and lint rules. Do not modify files. Return issues (with the task numbers involved) and merge notes.'
}

function groupFixes(fixes, k) {
  const byFile = {}
  for (const f of fixes) (byFile[f.file] = byFile[f.file] || []).push(f)
  const buckets = Array.from({ length: k }, () => [])
  Object.keys(byFile).forEach((file, i) => { buckets[i % k].push(...byFile[file]) })
  return buckets.filter((b) => b.length)
}

async function runTask(t, contact) {
  const tag = 'T' + t.n
  const summary = []
  if (t.mode === 'build' || t.mode === 'resume') {
    const plan = await agent(planPrompt(t), { label: tag + ' lead: plan', phase: 'Plan', model: 'sonnet', schema: PLAN })
    if (!plan) return { n: t.n, status: 'failed-plan' }
    summary.push('Packages: ' + plan.packages.map((p) => p.id + ' [' + p.files.join(', ') + ']').join('; '))
    const built = await parallel(plan.packages.map((p, i) => () =>
      agent(buildPrompt(t, p, plan.sharedNotes), { label: tag + ' ' + (t.builder || 'haiku') + ' ' + (i + 1) + ': ' + p.id, phase: 'Build', model: t.builder || 'haiku', schema: WORK })))
    const stuck = plan.packages.filter((p, i) => !built[i] || built[i].status === 'blocked')
    built.forEach((b, i) => summary.push('Builder ' + (i + 1) + ' (' + plan.packages[i].id + '): ' + (b ? b.status + ' - ' + b.notes : 'no result')))
    if (stuck.length) {
      log(tag + ': ' + stuck.length + ' package(s) blocked; the lead finishes them')
      await agent('You are the Sonnet lead for ' + head(t) + '\n' + RULES + '\n\nThese packages were left unfinished by your Haiku builders. Finish them yourself (tests first), then run their focused tests. Do not commit.\n' +
        stuck.map((p) => '- ' + p.id + ' (files ' + p.files.join(', ') + '): ' + p.instructions + '\n  test: ' + p.testCommand).join('\n') + '\nBuilder notes:\n' + summary.join('\n'),
        { label: tag + ' lead: finish blocked', phase: 'Build', model: 'sonnet', schema: WORK })
    }
  }
  const decided = []
  let review = null
  let approved = []
  const parked = []
  let round = 0
  for (; round < MAX_ROUNDS; round++) {
    review = await agent(reviewPrompt(t, round, decided), { label: tag + ' lead: review ' + (round + 1), phase: 'Review', model: 'sonnet', schema: REVIEW })
    if (!review) break
    summary.push('Review ' + (round + 1) + ': verify ' + (review.verifyPassed ? 'passed' : 'failed') + ', ' + review.findings.length + ' finding(s)')
    if (review.clean || !review.findings.length) break
    const check = await agent(checkPrompt(t, contact, review), { label: tag + ' ' + contact + ': check ' + (round + 1), phase: 'Check fixes', model: 'opus', schema: CHECK })
    const verdicts = check ? check.fixes : []
    for (const v of verdicts) {
      decided.push('- [' + v.id + '] ' + v.verdict + ': ' + v.reason)
      if (v.verdict === 'reject') parked.push(v.id + ': ' + v.reason)
    }
    approved = verdicts.filter((v) => v.verdict !== 'reject')
    summary.push('Contact check ' + (round + 1) + ': ' + verdicts.map((v) => v.id + '=' + v.verdict).join(', '))
    if (!approved.length) { review = Object.assign({}, review, { clean: review.verifyPassed }); break }
    const buckets = groupFixes(approved, 3)
    await parallel(buckets.map((b, i) => () =>
      agent(fixPrompt(t, b), { label: tag + ' ' + (t.builder || 'haiku') + ' ' + (i + 1) + ': fix ' + (round + 1), phase: 'Fix', model: t.builder || 'haiku', schema: WORK })))
  }
  let escalated = false
  if (round >= MAX_ROUNDS && approved.length) {
    escalated = true
    log(tag + ': still open after ' + MAX_ROUNDS + ' rounds; the lead applies the remaining fixes')
    await agent(leadFixPrompt(t, approved), { label: tag + ' lead: fix', phase: 'Fix', model: 'sonnet', schema: WORK })
    review = await agent(reviewPrompt(t, round, decided), { label: tag + ' lead: final review', phase: 'Review', model: 'sonnet', schema: REVIEW })
  }
  const commit = await agent(commitPrompt(t, summary.join('\n')), { label: tag + ' lead: commit', phase: 'Commit', model: 'sonnet', schema: COMMIT })
  return {
    n: t.n, status: commit && commit.verifyPassed ? (review && review.clean ? 'clean' : 'open-findings') : 'verify-failed',
    sha: commit ? commit.sha : null, committed: commit ? commit.committed : false, rounds: round, escalated,
    openFindings: review && !review.clean ? review.findings : [], parked, minors: review ? review.minors : [],
    testSummary: commit ? commit.testSummary : '', notes: commit ? commit.notes : '', team: summary,
  }
}

const groups = []
for (let i = 0; i < A.tasks.length; i += 3) groups.push(A.tasks.slice(i, i + 3))
const out = await parallel(groups.map((g, gi) => async () => {
  const contact = 'Opus contact ' + ((A.contactOffset || 0) + gi + 1)
  const res = await parallel(g.map((t) => () => runTask(t, contact)))
  const gc = await agent(groupPrompt(contact, g, res), { label: contact + ': group check', phase: 'Group check', model: 'opus', schema: GROUP })
  return { contact, tasks: res, groupCheck: gc }
}))
return out