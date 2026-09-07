#!/usr/bin/env python3
"""SYNTHETIC ONLY: diagnostic inputs, never performance evidence or an admission tool."""
import argparse
import copy
import hashlib
import json
import math
from pathlib import Path
import subprocess
import sys

HEAD = '3d9f4dffb3b374a85679623bb2cbca57195a75f8'
NAMES = ('microbenchmarks.json', 'process-workloads.json', 'pane-profiles.json')


def dump(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, sort_keys=True) + '\n')


def put(obj, path, value):
    for key in path[:-1]:
        obj = obj.setdefault(key, {})
    obj[path[-1]] = value


def get(obj, path):
    for key in path:
        obj = obj[key]
    return obj


def digest(data):
    return hashlib.sha256(data).hexdigest()


def fixture(root):
    raw = (root / 'benchmarks/workloads.json').read_bytes()
    m = json.loads(raw)
    b = m['regression_budgets']
    host = b['scope']['approved_host']
    binary = {'sha256': 'a' * 64, 'bytes': 100, 'path': '/SYNTHETIC/not-executable'}
    context = dict(b['scope']['micro_context_requirements'])
    context.update(source_commit=HEAD, source_dirty=False, executable_sha256='a' * 64,
                   manifest_sha256=digest(raw), host_name=host['host_name'],
                   host_model_identifier=host['model_identifier'], host_cpu_model=host['cpu_model'],
                   host_physical_cpu_count=str(host['physical_cpu_count']),
                   host_memory_bytes=str(host['memory_bytes']), load_avg=[0.1, 0.1, 0.1],
                   cpu_scaling_enabled=False, worktree_dirty=False,
                   ghostty_vt_feature_profile='full')
    micro = {'SYNTHETIC_ONLY': True, 'context': context, 'benchmarks': []}
    for check in b['microbenchmarks']['checks']:
        for i in range(b['microbenchmarks']['minimum_repetitions']):
            micro['benchmarks'].append(dict(name=check['benchmark'], run_type='iteration',
                repetition_index=i, iterations=100, cpu_time=1, real_time=1,
                time_unit=check['unit']))
    process = dict(b['scope']['process_report_requirements'])
    process.update(SYNTHETIC_ONLY=True, schema=5, multiplexer='lemma', repetitions=100,
                   run_intent='gate', statistics_valid={'p95': True, 'p99': True},
                   host_load_average=[0.1, 0.1, 0.1], maximum_gate_load_average_1m=4.0,
                   environment_valid=True, host='box', host_fingerprint=copy.deepcopy(host),
                   commit=HEAD, worktree_dirty=False, worktree_diff_sha256=None,
                   system_release='6.18.46', terminal=copy.deepcopy(m['terminal']),
                   latency_trace={'enabled': False},
                   manifest={'sha256': digest(raw)},
                   binaries={role: copy.deepcopy(binary) for role in
                       ('server', 'cli', 'peer', 'probe', 'launcher')},
                   scenario_ids=list(m['suites']['comparison']), workloads={})
    # Neutral synthetic distribution for non-budget workloads; no runtime completion attested.
    for name in process['scenario_ids']:
        process['workloads'][name] = {'status': 'completed', 'samples_ns': [1000] * 100}
    for check in b['process_workloads']['checks']:
        value = 0 if check['unit'] == 'count' else 100 if check['unit'] == 'bytes' else 1000
        put(process, check['samples_path'], [value] * 100)
        if check.get('availability') == 'when_supported':
            get(process, check['samples_path'][:-1])['available'] = True
    profile = copy.deepcopy(process)
    profile.update(repetitions=20, statistics_valid={'p95': True, 'p99': False},
                   scenario_ids=[], workloads={}, pane_profiles={})
    for name in m['profile_suites']['gate']:
        profile['pane_profiles'][name] = {}
        for condition in ('idle', 'active'):
            profile['pane_profiles'][name][condition] = {
                'status': 'completed',
                'resources': {'rss': {'samples_bytes': [1000000] * 20},
                              'cpu_time': {'samples_ns': [1000] * 20}},
                'interaction': {'key_to_pty': {'samples_ns': [1000] * 20},
                                'key_to_outer_bytes': {'samples_ns': [1000] * 20}}}
    return m, [micro, process, profile]


def save_capture(directory, reports):
    for name, report in zip(NAMES, reports):
        dump(directory / name, report)


def source(reports, value):
    reports[0]['context']['source_commit'] = value
    for report in reports[1:]:
        report['commit'] = value


def cli(root, output, name, args):
    command = [sys.executable, str(root / 'benchmarks' / name), '--manifest',
               str(root / 'benchmarks/workloads.json'), *map(str, args)]
    result = subprocess.run(command, cwd=root, text=True, capture_output=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.with_suffix('.stdout').write_text(result.stdout)
    output.with_suffix('.stderr').write_text(result.stderr)
    row = {'command': command, 'exit': result.returncode,
           'stderr': result.stderr.strip(), 'stdout_sha256': digest(result.stdout.encode())}
    dump(output.with_suffix('.command.json'), row)
    return row


def calibrate(root, out, directories):
    args = [arg for d in directories for arg in ('--capture', d)]
    return cli(root, out / 'calibrate', 'calibrate_regression.py',
               [*args, '--output', out / 'calibration.json'])


def probe(root, out):
    _, original = fixture(root)
    dirs = [out / f'capture-{i}' for i in (1, 2, 3)]
    for d in dirs:
        save_capture(d, original)
    positive = calibrate(root, out / 'positive', dirs)
    assert positive['exit'] == 0, positive
    changed = copy.deepcopy(original)
    source(changed, 'b' * 40)
    save_capture(dirs[1], changed)
    negative = calibrate(root, out / 'changed-source', dirs)
    print(f"SYNTHETIC positive: exit={positive['exit']}; changed-source A/A: exit={negative['exit']} (must reject for admission)")
    assert negative['exit'] != 0, 'RED: A/A accepts internally consistent source drift in capture 2'


def run_suite(root, out):
    m, original = fixture(root)
    results = []
    pc = m['regression_budgets']['process_workloads']['checks']
    warm = ['workloads', 'warm_scroll', 'samples_ns']
    wake = ['workloads', 'idle_resources', 'wakeups']
    fg = ['workloads', 'interactive_under_output', 'key_to_outer_bytes', 'samples_ns']
    prof = ['pane_profiles', 'P1', 'idle', 'resources', 'rss', 'samples_bytes']

    def case(name, mutate=lambda b, c: None, expected='reject admission', note=''):
        d = out / name
        base, cand = copy.deepcopy(original), copy.deepcopy(original)
        mutate(base, cand)
        save_capture(d / 'baseline', base)
        save_capture(d / 'candidate', cand)
        save_capture(d / 'third', original)
        row = {'name': name, 'admission_expectation': expected, 'note': note, 'tools': {}}
        for label, capture in [('base', d / 'baseline'), ('cand', d / 'candidate')]:
            for kind, file in zip(('micro', 'process', 'profile'), NAMES):
                row['tools'][label + '-validate-' + kind] = cli(root, d / f'{label}-validate-{kind}',
                    'validate_report.py', ['--micro' if kind == 'micro' else '--process', capture / file])
            row['tools'][label + '-absolute'] = cli(root, d / f'{label}-absolute',
                'check_regression.py', ['--micro-report', capture / NAMES[0],
                '--process-report', capture / NAMES[1], '--profile-report', capture / NAMES[2],
                '--output', d / f'{label}-absolute.json'])
        row['tools']['paired'] = cli(root, d / 'paired', 'compare_regression.py',
            ['--baseline', d / 'baseline', '--candidate', d / 'candidate', '--output', d / 'paired.json'])
        row['tools']['calibrate'] = calibrate(root, d, [d / 'baseline', d / 'candidate', d / 'third'])
        for key in ('paired', 'calibration', 'base-absolute', 'cand-absolute'):
            f = d / (key + '.json')
            if f.exists():
                value = json.loads(f.read_text())
                checks = value.get('comparisons', value.get('results', value.get('checks', [])))
                statuses = {s: sum(x['status'] == s for x in checks)
                            for s in ('passed', 'failed', 'diagnostic', 'unsupported')}
                row[key + '-summary'] = {'status': value['status'], 'coverage': len(checks),
                                        'counts': statuses, 'target_status': value.get('target_status')}
        results.append(row)
        print(name, {k: v['exit'] for k, v in row['tools'].items()})
        return row

    case('positive-equal-values', expected='component-positive only; synthetic is never admissible')
    # Identity probes deliberately distinguish disagreement from self-consistent unsupported claims.
    case('aa-one-source-field-drift', lambda b, c: c[0]['context'].update(source_commit='b' * 40))
    case('aa-consistent-source-drift', lambda b, c: source(c, 'b' * 40), note='Valid source difference for a pair, invalid A/A.')
    case('source-wrong-consistent', lambda b, c: [source(x, 'b' * 40) for x in (b, c)])
    case('source-missing', lambda b, c: [source(x, None) for x in (b, c)])
    case('source-cross-report-mismatch', lambda b, c: c[2].update(commit='b' * 40))
    case('aa-micro-binary-drift', lambda b, c: c[0]['context'].update(executable_sha256='b' * 64))
    case('micro-binary-missing', lambda b, c: c[0]['context'].pop('executable_sha256'))
    case('micro-binary-nonhex', lambda b, c: c[0]['context'].update(executable_sha256='z' * 64))
    case('process-binaries-missing', lambda b, c: c[1].pop('binaries'))
    case('process-binary-size-bool', lambda b, c: c[1]['binaries']['server'].update(bytes=True))
    case('process-binary-nonhex', lambda b, c: c[1]['binaries']['server'].update(sha256='z' * 64))
    for role in ('server', 'cli', 'peer', 'probe', 'launcher'):
        case('binary-role-missing-' + role, lambda b, c, role=role: c[1]['binaries'].pop(role))
        case('binary-role-drift-' + role, lambda b, c, role=role: c[1]['binaries'][role].update(sha256='b' * 64))
    case('dirty-without-archive', lambda b, c: (c[0]['context'].update(worktree_dirty=True),
         c[1].update(worktree_dirty=True, worktree_diff_sha256=None)))
    case('worktree-cross-report-drift', lambda b, c: c[1].update(worktree_diff_sha256='b' * 64))
    # No dependency/toolchain/archive fields are required by these entry points; inspect explicit contradictions too.
    for field in ('dependency_sha256', 'toolchain_sha256', 'configuration_sha256', 'fixture_sha256'):
        case('missing-' + field, note='Absent from otherwise accepted component-positive input; no invented mandatory field.')
        case('cross-report-' + field, lambda b, c, field=field: (c[1].update({field: 'a' * 64}), c[2].update({field: 'b' * 64})), note='Supplemental contradictory records; producer does not currently emit this binding.')
    case('manifest-cross-report', lambda b, c: c[1]['manifest'].update(sha256='b' * 64))
    def manifests(b, c, value):
        for reports in (b, c):
            reports[0]['context']['manifest_sha256'] = value
            for report in reports[1:]: report['manifest']['sha256'] = value
    case('manifest-wrong-consistent', lambda b, c: manifests(b, c, 'b' * 64))
    case('manifest-missing-digest', lambda b, c: manifests(b, c, None))
    case('wrong-build-scope', lambda b, c: c[1].update(build_profile='debug'))
    case('wrong-micro-build-scope', lambda b, c: c[0]['context'].update(library_build_type='debug'))
    case('wrong-geometry', lambda b, c: c[1]['terminal'].update(rows=999))
    case('trace-enabled', lambda b, c: c[1].update(latency_trace={'enabled': True}))
    case('wrong-feature-profile', lambda b, c: c[0]['context'].update(ghostty_vt_feature_profile='minimal'))
    case('kernel-drift', lambda b, c: c[1].update(system_release='WRONG'))
    case('wrong-pinned-memory', lambda b, c: c[1]['host_fingerprint'].update(memory_bytes=32641347584), note='Approved new epoch observation; current manifest still has old epoch.')
    case('baseline-wrong-scope', lambda b, c: b[1].update(system='Darwin'))
    case('baseline-overload', lambda b, c: b[1].update(host_load_average=[5, 5, 5], environment_valid=True))
    case('candidate-overload', lambda b, c: c[1].update(host_load_average=[5, 5, 5], environment_valid=True))
    case('environment-false', lambda b, c: c[1].update(environment_valid=False))
    case('statistics-false', lambda b, c: c[1].update(statistics_valid={'p95': False, 'p99': False}))
    for val, tag in ((True, 'bool'), (-1, 'negative'), (float('nan'), 'nan'), (float('inf'), 'inf')):
        case('load-' + tag, lambda b, c, val=val: c[1].update(host_load_average=[val, val, val]))
        case('process-sample-' + tag, lambda b, c, val=val: put(c[1], warm, [val] * 100))
        case('micro-sample-' + tag, lambda b, c, val=val: c[0]['benchmarks'][0].update(cpu_time=val))
        case('profile-sample-' + tag, lambda b, c, val=val: put(c[2], prof, [val] * 20))
    case('schema-invalid-candidate', lambda b, c: c[1].update(schema=999))
    case('schema-invalid-baseline', lambda b, c: b[1].update(schema=999))
    case('micro-wrong-unit', lambda b, c: c[0]['benchmarks'][0].update(time_unit='ms'))
    case('process-wrong-unit-key', lambda b, c: c[1]['workloads']['warm_scroll'].update(samples_ms=c[1]['workloads']['warm_scroll'].pop('samples_ns')))
    case('process-conflicting-unit-label', lambda b, c: c[1]['workloads']['warm_scroll'].update(unit='ms'), note='Unit is normally encoded in the key; extra labels are not validated.')
    case('micro-one-sample', lambda b, c: c[0].update(benchmarks=[r for r in c[0]['benchmarks'] if r['repetition_index'] == 0]))
    case('micro-duplicate-repetition', lambda b, c: [r.update(repetition_index=0) for r in c[0]['benchmarks']])
    case('micro-bool-repetition', lambda b, c: [r.update(repetition_index=True) for r in c[0]['benchmarks']])
    case('micro-negative-repetition', lambda b, c: [r.update(repetition_index=-1) for r in c[0]['benchmarks']])
    case('process-one-sample', lambda b, c: put(c[1], warm, [1000]))
    case('process-count-101', lambda b, c: put(c[1], warm, [1000] * 101))
    case('process-bytes-count-101', lambda b, c: c[1]['workloads']['warm_scroll'].update(outer_bytes=[100] * 101))
    case('profile-rss-count-21', lambda b, c: put(c[2], prof, [1000000] * 21))
    case('profile-one-sample', lambda b, c: put(c[2], prof, [1000000]))
    for side in ('baseline', 'candidate'):
        for status in ('failed', 'interrupted', 'unsupported'):
            case(side + '-process-' + status, lambda b, c, side=side, status=status: (b if side == 'baseline' else c)[1]['workloads']['warm_scroll'].update(status=status, error='SYNTHETIC failure'))
        case(side + '-micro-failed', lambda b, c, side=side: (b if side == 'baseline' else c)[0]['benchmarks'][0].update(error_occurred=True))
        case(side + '-profile-failed', lambda b, c, side=side: (b if side == 'baseline' else c)[2]['pane_profiles']['P1']['idle'].update(status='failed'))
    case('scenario-ids-missing', lambda b, c: c[1].pop('scenario_ids'))
    case('scenario-ids-duplicate', lambda b, c: c[1]['scenario_ids'].append(c[1]['scenario_ids'][0]))
    case('workloads-empty', lambda b, c: c[1].update(workloads={}, scenario_ids=[]))
    case('required-budget-workload-missing', lambda b, c: (c[1]['workloads'].pop('warm_scroll'), c[1]['scenario_ids'].remove('warm_scroll')))
    case('required-suite-workload-missing', lambda b, c: (c[1]['workloads'].pop('tui_redraw'), c[1]['scenario_ids'].remove('tui_redraw')))
    case('required-metric-missing', lambda b, c: c[1]['workloads']['warm_scroll'].pop('outer_bytes'))
    case('profiles-empty-both', lambda b, c: [x[2].update(pane_profiles={}) for x in (b, c)])
    case('profile-missing-both', lambda b, c: [x[2]['pane_profiles'].pop('P4') for x in (b, c)])
    case('micro-empty', lambda b, c: c[0].update(benchmarks=[]))
    case('required-unsupported-empty', lambda b, c: c[1]['workloads']['warm_scroll'].update(available=False, reason='SYNTHETIC unsupported', samples_ns=[]))
    case('required-unsupported-with-samples', lambda b, c: c[1]['workloads']['warm_scroll'].update(available=False, reason='SYNTHETIC unsupported'))
    case('required-resource-unsupported-with-samples', lambda b, c: c[1]['workloads']['idle_resources']['cpu_time'].update(available=False, reason='SYNTHETIC unsupported'))
    def unsupported(b, c, reason='SYNTHETIC no counter', samples=None):
        for x in (b, c): put(x[1], wake, {'available': False, 'reason': reason, 'samples_count': [] if samples is None else samples})
    case('optional-unsupported', unsupported, expected='unsupported, not passed')
    case('optional-unsupported-empty-reason', lambda b, c: unsupported(b, c, reason=''))
    case('optional-unsupported-null-reason', lambda b, c: unsupported(b, c, reason=None))
    case('optional-unsupported-with-samples', lambda b, c: unsupported(b, c, samples=[0] * 100))
    case('optional-support-change', lambda b, c: put(c[1], wake, {'available': False, 'reason': 'SYNTHETIC no counter', 'samples_count': []}))
    case('optional-no-availability', lambda b, c: get(c[1], wake).pop('available'))
    case('paired-regression-absolute-pass', lambda b, c: put(c[1], warm, [1000000] * 100), expected='paired failure, absolute pass')
    case('paired-pass-absolute-miss', lambda b, c: [put(x[1], warm, [40000000] * 100) for x in (b, c)], expected='paired pass, absolute failure; no debt waiver')
    case('diagnostic-tail-regression', lambda b, c: put(c[1], fg, [1000] * 98 + [10000000] * 2), expected='diagnostic p99, absolute miss; repeated native stalls need supplemental policy review')
    case('within-candidate-target-fail', lambda b, c: [put(x[1], ['workloads', 'blocked_client', 'blocked_other_session', 'key_to_outer_bytes', 'samples_ns'], [2000] * 100) for x in (b, c)], expected='paired pass with comparative absolute failure')
    case('claimed-summary-disagrees', lambda b, c: (put(c[1], warm, [1000000] * 100), c[1]['workloads']['warm_scroll'].update(p95_ns=1), c[1].update(status='passed')), expected='recomputed paired failure; raw summary ignored')
    case('irrelevant-invalid-samples', lambda b, c: c[1]['workloads']['tui_redraw'].update(samples_ns=[-1] * 100))
    case('missing-execution-and-host-calibration', note='All component-positive inputs lack these sidecars; no command consumes them.')
    dump(out / 'matrix.json', results)
    # Calibrator permits fewer captures than approved, repeated same directory, and same bytes at new paths.
    d = out / 'independence'
    for i in (1, 2, 3): save_capture(d / str(i), original)
    independence = {}
    for name, dirs in [('one', [d / '1']), ('two', [d / '1', d / '2']),
                       ('same-path-three', [d / '1'] * 3), ('identical-copy-three', [d / str(i) for i in (1, 2, 3)])]:
        independence[name] = calibrate(root, d / name, dirs)
    dump(out / 'independence.json', independence)
    # A sidecar cannot enforce admission when no entry point reads it.
    d = out / 'sidecars'
    for role in ('baseline', 'candidate'): save_capture(d / role, original)
    sidecars = {}
    for state in ('missing', 'stale', 'failed'):
        if state != 'missing':
            for file in ('calibration.json', 'host-before.json', 'host-after.json'):
                dump(d / file, {'SYNTHETIC_ONLY': True, 'status': 'failed' if state == 'failed' else 'passed',
                               'captured_at': '1970-01-01T00:00:00Z', 'source_commit': 'b' * 40})
        sidecars[state] = cli(root, d / state, 'compare_regression.py',
            ['--baseline', d / 'baseline', '--candidate', d / 'candidate', '--output', d / (state + '-paired.json')])
    dump(out / 'sidecars.json', sidecars)
    positive = results[0]
    assert all(tool['exit'] == 0 for tool in positive['tools'].values()), positive
    assert positive['paired-summary']['coverage'] == 79
    assert positive['cand-absolute-summary']['coverage'] == 80
    return m, original


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--root', type=Path, default=Path.cwd())
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--probe', action='store_true')
    a = p.parse_args()
    a.root = a.root.resolve()
    a.out = a.out.resolve()
    if a.out.exists():
        p.error('use a new output directory; never overwrite retained diagnostic evidence')
    a.out.mkdir(parents=True)
    (a.out / 'SYNTHETIC_ONLY').write_text('Never real captures, host evidence, or qualification.\n')
    if a.probe:
        probe(a.root, a.out)
    else:
        run_suite(a.root, a.out)


if __name__ == '__main__':
    main()
