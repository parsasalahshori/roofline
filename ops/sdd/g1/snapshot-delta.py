"""Re-apply an upstream migration snapshot's delta to G1's chain (0019-0024).

Usage (from the repo root of a branch mid-merge):
  python3 ops/sdd/g1/snapshot-delta.py <old-ref> <new-ref> <upstream-snapshot-number> [first-g1-number]

Adds what <new-ref>'s meta/<n>_snapshot.json has beyond <old-ref>'s (new keys anywhere, and changed
leaf values such as CHECK expressions) to each of meta/0019..0024_snapshot.json, keeping their key
order, ids and prevIds; sets 0019's prevId to the new upstream snapshot's id. Then run
`npx drizzle-kit generate` in packages/db: it must report no changes.
"""
import json, subprocess, sys

old_ref, new_ref, n = sys.argv[1], sys.argv[2], sys.argv[3]
M = 'packages/db/migrations/meta/'
show = lambda r, p: json.loads(subprocess.check_output(['git', 'show', f'{r}:{p}']))
old, new = show(old_ref, M + f'{n}_snapshot.json'), show(new_ref, M + f'{n}_snapshot.json')

def delta(b, e):
    out = {}
    for k, v in e.items():
        if k in ('id', 'prevId'):
            continue
        if k not in b:
            out[k] = v
        elif isinstance(v, dict) and isinstance(b[k], dict):
            d = delta(b[k], v)
            if d:
                out[k] = d
        elif v != b[k]:
            out[k] = v
    return out

def apply(t, d):
    for k, v in d.items():
        if isinstance(v, dict) and isinstance(t.get(k), dict):
            apply(t[k], v)
        else:
            t[k] = v

D = delta(old, new)
print('delta keys:', json.dumps(D)[:400])
for i, num in enumerate(['0019', '0020', '0021', '0022', '0023', '0024']):
    path = M + num + '_snapshot.json'
    s = json.load(open(path))
    apply(s, D)
    if i == 0:
        s['prevId'] = new['id']
    open(path, 'w').write(json.dumps(s, indent=2, ensure_ascii=False))
