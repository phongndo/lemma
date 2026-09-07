#!/usr/bin/env python3
"""Independent arithmetic cross-check for retained SYNTHETIC diagnostics only.
Not an admission validator: no source/host custody, completion or campaign qualification.
No production analyzer functions are imported.
"""
import argparse
import copy
import json
import math
from pathlib import Path


def load(path):
    return json.loads(path.read_text())


def at(root, path):
    for key in path: root = root[key]
    return root


def stat(raw, name):
    assert raw and all(type(x) in (int, float) and math.isfinite(x) and x >= 0 for x in raw)
    return max(raw) if name == 'max' else sorted(raw)[math.ceil({'p50': .5, 'p95': .95, 'p99': .99}[name] * len(raw)) - 1]


def measurements(manifest, path):
    micro, process, profile = [load(path / name) for name in
        ('microbenchmarks.json', 'process-workloads.json', 'pane-profiles.json')]
    b = manifest['regression_budgets']
    rows = []
    for check in b['microbenchmarks']['checks']:
        raw = [r[check['field']] for r in micro['benchmarks']
               if r['name'] == check['benchmark'] and r['run_type'] == 'iteration']
        assert len(raw) >= b['microbenchmarks']['minimum_repetitions']
        rows.append((check['id'], 'microbenchmarks', check['unit'], stat(raw, check['statistic']), len(raw), check['statistic'], check['maximum']))
    for check in b['process_workloads']['checks']:
        raw = at(process, check['samples_path'])
        unsupported = check.get('availability') == 'when_supported' and at(process, check['samples_path'][:-1]).get('available') is False
        if not unsupported: assert len(raw) >= b['process_workloads']['minimum_repetitions']
        rows.append((check['id'], 'process_workloads', check['unit'], None if unsupported else stat(raw, check['statistic']), len(raw), check['statistic'], check['maximum']))
    for p in ('P1', 'P4', 'P16', 'PMAX'):
        for condition in ('idle', 'active'):
            data = profile['pane_profiles'][p][condition]
            limits = b['pane_profiles']['conditions'][condition]
            fields = [('rss_p95', ['resources','rss','samples_bytes'], 'p95', 'bytes', b['pane_profiles']['maximum_p95_rss_bytes'][p]),
                      ('cpu_time_p95', ['resources','cpu_time','samples_ns'], 'p95', 'ns', limits['maximum_p95_cpu_time_ns']),
                      ('key_to_pty_p95', ['interaction','key_to_pty','samples_ns'], 'p95', 'ns', limits['maximum_p95_key_to_pty_ns']),
                      ('key_to_outer_bytes_p50', ['interaction','key_to_outer_bytes','samples_ns'], 'p50', 'ns', limits['maximum_p50_key_to_outer_bytes_ns']),
                      ('key_to_outer_bytes_p95', ['interaction','key_to_outer_bytes','samples_ns'], 'p95', 'ns', limits['maximum_p95_key_to_outer_bytes_ns'])]
            for suffix, key, s, unit, maximum in fields:
                raw = at(data, key)
                assert len(raw) >= b['pane_profiles']['minimum_repetitions']
                rows.append((f'{p}.{condition}.{suffix}', 'pane_profiles', unit, stat(raw, s), len(raw), s, maximum))
    return rows, process


def absolute(manifest, path):
    values, process = measurements(manifest, path)
    checks = []
    for identifier, section, unit, value, n, s, maximum in values:
        checks.append(dict(id=identifier, unit=unit, observed=value, samples=n, statistic=s,
                           maximum=maximum, status='unsupported' if value is None else 'passed' if value <= maximum else 'failed'))
    for check in manifest['regression_budgets']['process_workloads']['comparative_checks']:
        base = at(process, check['baseline_samples_path']); cand = at(process, check['loaded_samples_path'])
        value = stat(cand, check['statistic']) / stat(base, check['statistic'])
        checks.append(dict(id=check['id'], unit='ratio', observed=value, samples=min(len(base), len(cand)),
            statistic=check['statistic'], maximum=check['maximum_ratio'], status='passed' if value <= check['maximum_ratio'] else 'failed'))
    return checks


def paired(manifest, base, cand):
    b, _ = measurements(manifest, base); c, _ = measurements(manifest, cand)
    checks = []
    for br, cr in zip(b, c):
        identifier, section, unit, bv, *_ = br
        cv = cr[3]
        assert br[:3] == cr[:3]
        if bv is None or cv is None:
            assert bv is None and cv is None
            checks.append(dict(id=identifier, unit=unit, status='unsupported')); continue
        policy = manifest['paired_regression'][section]
        ratio = policy['maximum_ratio']
        floor = policy.get('absolute_noise_floor_by_id', {}).get(identifier, policy['absolute_noise_floor'].get(unit, 0))
        maximum = bv * ratio + floor
        checks.append(dict(id=identifier, unit=unit, baseline=bv, candidate=cv,
            maximum=maximum, maximum_ratio=ratio, absolute_noise_floor=floor,
            status='diagnostic' if identifier in policy.get('diagnostic_ids', []) else 'passed' if cv <= maximum else 'failed'))
    return checks


def calibrated(manifest, directories):
    captures = [measurements(manifest, d)[0] for d in directories]
    checks = []
    for group in zip(*captures):
        identifier, section, unit, *_ = group[0]
        values = [r[3] for r in group]
        if any(v is None for v in values):
            assert all(v is None for v in values)
            checks.append(dict(id=identifier, section=section, unit=unit, status='unsupported')); continue
        low, high = min(values), max(values)
        policy = manifest['paired_regression'][section]
        ratio = policy['maximum_ratio']
        floor = policy.get('absolute_noise_floor_by_id', {}).get(identifier, policy['absolute_noise_floor'].get(unit, 0))
        allowed = low * ratio + floor
        checks.append(dict(id=identifier, section=section, unit=unit, samples=values,
            minimum=low, maximum=high, observed_spread=high-low,
            observed_maximum_ratio=high/low if low > 0 else None, policy_maximum_ratio=ratio,
            policy_absolute_noise_floor=floor, policy_maximum=allowed,
            minimum_floor_required_by_observations=math.ceil(max(high-low*ratio, 0)),
            status='diagnostic' if identifier in policy.get('diagnostic_ids', []) else 'passed' if high <= allowed else 'failed'))
    return checks


def compare_records(actual, expected):
    assert len(actual) == len(expected), 'coverage count mismatch'
    assert len({r['id'] for r in actual}) == len(actual), 'duplicate output IDs'
    assert {r['id']: r for r in actual} == {r['id']: r for r in expected}, 'raw-to-summary mismatch'


def check_pair(manifest, case, report):
    expected = paired(manifest, case / 'baseline', case / 'candidate')
    compare_records(report['comparisons'], expected)
    assert report['status'] == ('failed' if any(r['status'] == 'failed' for r in expected) else 'passed')
    targets = absolute(manifest, case / 'candidate')
    compare_records(report['target_checks'], targets)
    assert report['target_status'] == ('failed' if any(r['status'] == 'failed' for r in targets) else 'passed')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--manifest', type=Path, default=Path('benchmarks/workloads.json'))
    p.add_argument('--matrix', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args(); m = load(a.manifest)
    results = []
    names = ('positive-equal-values', 'paired-regression-absolute-pass', 'paired-pass-absolute-miss',
             'diagnostic-tail-regression', 'within-candidate-target-fail', 'claimed-summary-disagrees', 'optional-unsupported')
    for name in names:
        case = a.matrix / name
        check_pair(m, case, load(case / 'paired.json'))
        for side in ('base', 'cand'):
            report = load(case / (side + '-absolute.json'))
            expected = absolute(m, case / ('baseline' if side == 'base' else 'candidate'))
            compare_records(report['checks'], expected)
            assert report['status'] == ('failed' if any(r['status'] == 'failed' for r in expected) else 'passed')
        calibration_path = case / 'calibration.json'
        if calibration_path.exists():
            report = load(calibration_path)
            expected = calibrated(m, [case / side for side in ('baseline', 'candidate', 'third')])
            compare_records(report['results'], expected)
            assert report['status'] == ('failed' if any(r['status'] == 'failed' for r in expected) else 'passed')
        results.append({'case': name, 'independent_arithmetic': 'matched: 79 paired, 80 absolute IDs per side, and emitted calibration results'})
    case = a.matrix / 'positive-equal-values'
    original = load(case / 'paired.json')
    for name, mutate in {
        'zero-enforced-checks': lambda r: r.update(comparisons=[]),
        'missing-check': lambda r: r['comparisons'].pop(),
        'duplicate-check': lambda r: r['comparisons'].append(r['comparisons'][0]),
        'diagnostic-promoted-to-pass': lambda r: next(x for x in r['comparisons'] if x['status'] == 'diagnostic').update(status='passed'),
        'value-forged': lambda r: r['comparisons'][0].update(candidate=999),
    }.items():
        report = copy.deepcopy(original); mutate(report)
        try: check_pair(m, case, report)
        except AssertionError as e: results.append({'case': name, 'review_rejected': str(e)})
        else: raise AssertionError('review missed ' + name)
    case = a.matrix / 'paired-regression-absolute-pass'
    report = load(case / 'paired.json'); report['status'] = 'passed'
    try: check_pair(m, case, report)
    except AssertionError: results.append({'case': 'failed-summary-promoted', 'review_rejected': True})
    else: raise AssertionError('review missed false overall pass')
    a.output.write_text(json.dumps(results, indent=2) + '\n')
    print(f'{len(results)} independent arithmetic/forged-summary checks passed (not admission).')


if __name__ == '__main__': main()
