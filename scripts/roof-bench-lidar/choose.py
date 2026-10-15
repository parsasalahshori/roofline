"""Pick one lidar truth per house among its work units (lidar/<slug>/units/*/truth.json).

The choice uses only the truth's own checks (validate.grade without EagleView, rules A1-A5): a candidate passing them
first, then the densest roof sampling, then the newest flight. EagleView never enters the choice, so the EagleView
comparison in validate.py stays an independent check of the truth. Copies the pick to lidar/<slug>/truth.json (and
its truth.png) with the candidates listed. Deterministic.
"""
import glob, json, os, shutil, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from validate import grade  # noqa: E402

L = os.path.join(os.environ.get('ROOF_BENCH_DIR', '/Users/parsasalahshori-a/RooflineWork/roof-bench'), 'lidar')


def main(slugs):
    for house in sorted(glob.glob(f'{L}/*/units')):
        slug = os.path.basename(os.path.dirname(house))
        if slugs and slug not in slugs:
            continue
        cands = []
        for tp in sorted(glob.glob(f'{house}/*/truth.json')):
            t = json.load(open(tp))
            unit = os.path.basename(os.path.dirname(tp))
            if not t.get('ok'):
                cands.append(dict(unit=unit, ok=False, reasons=[f"truth-failed: {t.get('reason')}"], density=0, end=''))
                continue
            r = grade(t, None)
            cands.append(dict(unit=unit, ok=not r, reasons=r, density=t['checks']['roofPointsPerM2'], edge=t['checks']['edgeObservedShare'],
                              end=max(d or '' for d in t['source']['pointDates']), dir=os.path.dirname(tp)))
        if not cands:
            continue
        cands.sort(key=lambda c: (not c['ok'], len(c['reasons']), -c['density'], tuple(-ord(ch) for ch in c['end'])))
        pick = cands[0]
        out = f'{L}/{slug}/truth.json'
        if 'dir' in pick:
            t = json.load(open(f"{pick['dir']}/truth.json"))
            t['unit'] = pick['unit']
            t['candidates'] = [{k: v for k, v in c.items() if k != 'dir'} for c in cands]
            json.dump(t, open(out, 'w'), indent=1, sort_keys=True)
            if os.path.exists(f"{pick['dir']}/truth.png"):
                shutil.copyfile(f"{pick['dir']}/truth.png", f'{L}/{slug}/truth.png')
        else:
            json.dump(dict(slug=slug, ok=False, reason=pick['reasons'][0], candidates=cands), open(out, 'w'), indent=1)
        print(slug, '->', pick['unit'], 'ok' if pick['ok'] else pick['reasons'], f"({len(cands)} candidates)")


if __name__ == '__main__':
    main(sys.argv[1:])
