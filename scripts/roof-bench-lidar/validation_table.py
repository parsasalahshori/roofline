"""The truth validation table: lidar truth against EagleView, by canopy cohort and split (reads lidar/index.json)."""
import json, os
import numpy as np

L = os.path.join(os.environ.get('ROOF_BENCH_DIR', '/Users/parsasalahshori-a/RooflineWork/roof-bench'), 'lidar')
ix = json.load(open(f'{L}/index.json'))['houses']


def row(name, hs):
    ev = [h for h in hs if h.get('eagleview') and h['eagleview']['structures'] == 1]
    if not ev:
        return f'| {name} | 0 | - | - | - | - | - | - |'
    e = [h['eagleview'] for h in ev]
    med = lambda xs: np.median(xs) if xs else float('nan')
    pe = [x['mainPitchErr'] for x in e if x['mainPitchErr'] is not None]
    return (f"| {name} | {len(ev)} | {med([x['iouAligned'] for x in e]):.3f} | {med([x['boundaryM'] for x in e]):.2f} | "
            f"{med([abs(x['slopedErrPct']) for x in e]):.1f} | {med([x['slopedErrPct'] for x in e]):+.1f} | {sum(p == 0 for p in pe)}/{sum(p <= 1 for p in pe)}/{len(pe)} | "
            f"{sum(x['iouAligned'] >= 0.85 for x in e)}/{len(e)} |")


print('| set | EV houses | aligned IoU (median) | boundary m (median) | abs sloped area err % (median) | signed % | main pitch exact / within 1 / n | IoU >= 0.85 |')
print('| --- | --- | --- | --- | --- | --- | --- | --- |')
for split in ('dev', 'heldout', 'all'):
    hs = [h for h in ix.values() if (split == 'all' or h['split'] == split) and h['grade'] != 'none' and h.get('checks')]
    pre = [h for h in hs if not [r for r in h['reasons'] if r != 'A6-eagleview']]
    acc = [h for h in hs if h['grade'] == 'lidar']
    print(row(f'{split}: every EV house with a lidar outline', hs))
    print(row(f'{split}: passing the truth\'s own checks (A1-A5)', pre))
    print(row(f'{split}: accepted (A1-A6)', acc))
    for can in ('heavy', 'light', 'none'):
        print(row(f'{split}: A1-A5, canopy-{can}', [h for h in pre if h['canopy'] == can]))
