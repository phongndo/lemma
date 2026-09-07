#!/usr/bin/env python3
"""SYNTHETIC composition probes. Real shell/analyzer code; fake host/build/workload boundaries.
No builds, timing, host-lock/affinity proof, real worktree manipulation, or qualification.
"""
import argparse
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from diagnostic import HEAD, NAMES, cli, dump, fixture, save_capture, calibrate

SHIM = r'''import json, os, pathlib, shutil, sys
P = pathlib.Path
args = sys.argv[1:]
name = P(sys.argv[0]).name
root = P(os.environ['SYNTH_ROOT'])
case = os.environ['SYNTH_CASE']
with (root / 'calls.jsonl').open('a') as f:
    f.write(json.dumps({'tool': name, 'args': args, 'cwd': os.getcwd()}) + '\n')
def emit(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data))
def prepare(path):
    (path / 'build/release').mkdir(parents=True, exist_ok=True)
    for n in ('lemma_benchmarks', 'lemma_benchmark_probe'):
        shutil.copy(root / 'shims/driver', path / 'build/release' / n)
if name == 'git':
    if args[:2] == ['rev-parse', '--show-toplevel']: print(root)
    elif args[:2] == ['rev-parse', '--verify']: print('3d9f4dffb3b374a85679623bb2cbca57195a75f8')
    elif args[:2] == ['worktree', 'add']: prepare(P(args[-2]))
    elif args[:2] == ['worktree', 'remove']: shutil.rmtree(args[-1])
    else: raise SystemExit('unexpected git call')
elif name in ('taskset', 'nix'):
    rest = args[2:] if name == 'taskset' else args[args.index('--command')+1:]
    os.execvp(rest[0], rest)
elif name == 'flock':
    raise SystemExit(1 if case == 'lock-refused' else 0)
elif name in ('cmake', 'sleep', 'configure', 'lemma_benchmark_probe'):
    pass
elif name == 'lemma_benchmarks':
    output = P(next(x.split('=',1)[1] for x in args if x.startswith('--benchmark_out=')))
    value = json.loads((root / 'fixture/microbenchmarks.json').read_text())
    if case == 'micro-failed': value['benchmarks'][0]['error_occurred'] = True
    if case == 'calibrate-source-drift' and 'capture-2' in str(output): value['context']['source_commit'] = 'b' * 40
    emit(output, value)
elif name == 'python3':
    tool = P(args[0]).name if args else ''
    if tool == 'performance_host.py':
        output = P(args[args.index('--output')+1])
        after = output.name == 'host-after.json'
        value = json.loads((root / 'fixture/host.json').read_text())
        if (case == 'host-before-failed' and not after) or (case == 'host-after-failed' and after):
            value['status'] = 'failed'; emit(output, value); raise SystemExit(1)
        if case == 'host-after-missing' and after: raise SystemExit(0)
        if case == 'kernel-after-drift' and after: value['system_release'] = 'WRONG'
        if case == 'governor-after-drift' and after: value['scaling_governors'] = ['WRONG']
        emit(output, value)
    elif tool in ('annotate_micro_report.py', 'benchmark_tools_test.py'):
        pass
    elif tool == 'mux_benchmark.py':
        profile = args[args.index('--mode')+1] == 'profiles'
        value = json.loads((root / 'fixture' / ('pane-profiles.json' if profile else 'process-workloads.json')).read_text())
        if case == 'process-failed' and not profile: value['workloads']['warm_scroll']['status'] = 'failed'
        if case == 'suite-incomplete' and not profile:
            del value['workloads']['tui_redraw']; value['scenario_ids'].remove('tui_redraw')
        output = P(args[args.index('--output')+1])
        if case == 'calibrate-empty-profiles' and profile: value['pane_profiles'] = {}
        if case == 'calibrate-source-drift' and 'capture-2' in str(output): value['commit'] = 'b' * 40
        emit(output, value)
    else: os.execv(os.environ['SYNTH_PYTHON'], [os.environ['SYNTH_PYTHON'], *args])
else: raise SystemExit('unexpected shim ' + name)
'''


def host_fixture(root):
    _, reports = fixture(root)
    return dict(SYNTHETIC_ONLY=True, schema=1, suite='lemma-performance-host', status='passed',
        fingerprint=reports[1]['host_fingerprint'], system='Linux', architecture='x86_64',
        logical_cpu_count=32, system_release='6.18.46', scaling_governors=['powersave'],
        energy_performance_preferences=['balance_performance'], cpu_affinity='0-7',
        load_average=[0.1, 0.1, 0.1], failures=[])


def runner(root, out):
    result = []
    for case in ('positive-no-calibration', 'lock-refused', 'host-before-failed', 'host-after-failed',
                 'host-after-missing', 'kernel-after-drift', 'governor-after-drift',
                 'micro-failed', 'process-failed', 'suite-incomplete', 'calibrate-positive',
                 'calibrate-empty-profiles', 'calibrate-source-drift'):
        box = out / case
        box.mkdir(parents=True)
        for name in ('scripts/performance', 'scripts/ci/regression-capture', 'benchmarks/workloads.json',
                     'benchmarks/performance_hosts.json', 'benchmarks/benchmark_manifest.py',
                     'benchmarks/validate_report.py', 'benchmarks/check_regression.py',
                     'benchmarks/compare_regression.py', 'benchmarks/calibrate_regression.py'):
            target = box / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(root / name, target)
        shim = box / 'shims/driver'
        shim.parent.mkdir()
        shim.write_text('#!' + sys.executable + '\n' + SHIM)
        shim.chmod(0o755)
        for name in ('git', 'taskset', 'nix', 'flock', 'cmake', 'sleep', 'python3'):
            (shim.parent / name).symlink_to('driver')
        shutil.copy(shim, box / 'scripts/ci/configure')
        _, reports = fixture(root)
        save_capture(box / 'fixture', reports)
        dump(box / 'fixture/host.json', host_fixture(root))
        for name in ('lemma_benchmarks', 'lemma_benchmark_probe'):
            dst = box / 'build/release' / name
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(shim, dst)
        temp = box / 'tmp'
        temp.mkdir()
        env = dict(os.environ, PATH=str(shim.parent) + os.pathsep + os.environ['PATH'],
                   SYNTH_ROOT=str(box), SYNTH_CASE=case, SYNTH_PYTHON=sys.executable,
                   TMPDIR=str(temp), LEMMA_BENCH_COOLDOWN_SECONDS='0')
        mode, argument = ('calibrate', '3') if case.startswith('calibrate-') else ('gate', HEAD)
        command = ['bash', 'scripts/performance', mode, argument, str(box / 'output')]
        p = subprocess.run(command, cwd=box, env=env, text=True, capture_output=True, timeout=30)
        (box / 'runner.stdout').write_text(p.stdout)
        (box / 'runner.stderr').write_text(p.stderr)
        calls = [json.loads(x) for x in (box / 'calls.jsonl').read_text().splitlines()]
        row = {'case': case, 'command': command, 'exit': p.returncode,
               'paired_exists': (box / 'output/paired-regression.json').exists(),
               'calibration_exists': (box / 'output/calibration.json').exists(),
               'host_after_exists': (box / 'output/host-after.json').exists(),
               'capture_order': [x['args'][x['args'].index('--output')+1] for x in calls
                    if x['tool'] == 'python3' and x['args'][0].endswith('mux_benchmark.py')],
               'configure_calls': sum(x['tool'] == 'configure' for x in calls)}
        result.append(row)
        print('runner', case, p.returncode, row['paired_exists'])
    dump(out / 'runner.json', result)


def comparison(root, out):
    m, reports = fixture(root)
    scenarios = {w['id']: w for w in m['process_workloads']}
    subjects = m['terminal_lab']['subjects']
    positive = dict(SYNTHETIC_ONLY=True, schema=3, run_intent='gate', environment_valid=True,
                    results=[], execution_order=[], direct_after_controls={})
    for subject in subjects:
        r = copy.deepcopy(reports[1]); r['multiplexer'] = subject
        for name in r['scenario_ids']:
            if subject not in scenarios[name]['subjects']:
                r['workloads'][name] = {'status': 'unsupported', 'reason': 'SYNTHETIC unsupported'}
        positive['results'].append(r)
    # Deterministic permutation with complete before/subject/after brackets.
    for name in reversed(m['suites']['comparison']):
        supported = scenarios[name]['subjects']
        if 'direct' in supported:
            positive['execution_order'].append({'subject': 'direct', 'workload': name, 'phase': 'before'})
            positive['direct_after_controls'][name] = copy.deepcopy(reports[1]['workloads'][name])
        for subject in reversed(subjects):
            if subject != 'direct' and subject in supported:
                positive['execution_order'].append({'subject': subject, 'workload': name, 'phase': 'subject'})
        if 'direct' in supported:
            positive['execution_order'].append({'subject': 'direct', 'workload': name, 'phase': 'after'})
    result = {}
    mutations = {
        'positive': lambda r: None,
        'order-missing': lambda r: r.pop('execution_order'),
        'order-empty': lambda r: r.update(execution_order=[]),
        'order-partial': lambda r: r['execution_order'].pop(),
        'order-duplicate': lambda r: r['execution_order'].append(r['execution_order'][0]),
        'brackets-reversed': lambda r: r['execution_order'].reverse(),
        'after-controls-missing': lambda r: r.pop('direct_after_controls'),
        'after-control-failed': lambda r: next(iter(r['direct_after_controls'].values())).update(status='failed'),
        'after-control-no-samples': lambda r: r.update(direct_after_controls={k: {'status': 'completed'} for k in r['direct_after_controls']}),
        'ordered-subject-missing': lambda r: r['results'].pop(),
        'nested-suite-empty': lambda r: [x.update(workloads={}, scenario_ids=[]) for x in r['results']],
    }
    for name, mutate in mutations.items():
        r = copy.deepcopy(positive); mutate(r)
        path = out / (name + '.json'); dump(path, r)
        result[name] = cli(root, out / name, 'validate_report.py', ['--comparison', path])
        print('comparison', name, result[name]['exit'])
    dump(out / 'comparison.json', result)


def extra(root, out):
    _, original = fixture(root)
    results = {}
    for name, mutation in {
        'all-profiles-empty': lambda r: r[2].update(pane_profiles={}),
        'all-profile-P4-missing': lambda r: r[2]['pane_profiles'].pop('P4'),
        'all-optional-unsupported': lambda r: r[1]['workloads']['idle_resources'].update(wakeups={'available': False, 'reason': 'SYNTHETIC no counter', 'samples_count': []}),
        'all-new-memory-epoch': lambda r: (r[0]['context'].update(host_memory_bytes='32641347584'), *[x['host_fingerprint'].update(memory_bytes=32641347584) for x in r[1:]]),
        'all-wrong-kernel': lambda r: [x.update(system_release='WRONG') for x in r[1:]],
    }.items():
        r = copy.deepcopy(original); mutation(r)
        dirs = [out / name / str(i) for i in (1, 2, 3)]
        for d in dirs: save_capture(d, r)
        results[name] = calibrate(root, out / name, dirs)
    for name, contents in {
        'truncated': '{"schema":', 'wrong-top-type': '[]',
        'duplicate-key': json.dumps(original[1])[:-1] + ', "schema": 999, "schema": 5}',
    }.items():
        d = out / name
        save_capture(d / 'baseline', original); save_capture(d / 'candidate', original)
        (d / 'candidate/process-workloads.json').write_text(contents)
        results[name + '-validate'] = cli(root, d / 'validate', 'validate_report.py', ['--process', d / 'candidate/process-workloads.json'])
        results[name + '-paired'] = cli(root, d / 'paired', 'compare_regression.py',
            ['--baseline', d / 'baseline', '--candidate', d / 'candidate', '--output', d / 'paired.json'])
    dump(out / 'extra.json', results)


def host(root, out):
    # Real performance_host.main/validate, with only observation collection replaced by synthetic data.
    obs = host_fixture(root)
    tests = {
        'positive-old-epoch': lambda r: None,
        'new-memory-epoch': lambda r: r['fingerprint'].update(memory_bytes=32641347584),
        'wrong-kernel': lambda r: r.update(system_release='WRONG'),
        'low-memory': lambda r: r['fingerprint'].update(memory_bytes=1),
        'wrong-governor': lambda r: r.update(scaling_governors=['WRONG']),
        'overload': lambda r: r.update(load_average=[5, 5, 5]),
        'negative-load': lambda r: r.update(load_average=[-1, -1, -1]),
        'nan-load': lambda r: r.update(load_average=[float('nan')] * 3),
        'bool-load': lambda r: r.update(load_average=[True] * 3),
    }
    code = ('import json,sys; from pathlib import Path; sys.path.insert(0,sys.argv.pop(1)); '
            'import performance_host as h; p=sys.argv.pop(1); '
            'h.host_snapshot=lambda:json.loads(Path(p).read_text()); sys.exit(h.main())')
    results = {}
    for name, mutate in tests.items():
        value = copy.deepcopy(obs); mutate(value)
        input_path = out / (name + '-input.json'); dump(input_path, value)
        command = [sys.executable, '-c', code, str(root / 'benchmarks'), str(input_path),
                   '--policy', str(root / 'benchmarks/performance_hosts.json'), '--output', str(out / (name + '-host.json'))]
        p = subprocess.run(command, cwd=root, text=True, capture_output=True)
        results[name] = {'command': command, 'exit': p.returncode, 'stdout': p.stdout, 'stderr': p.stderr}
        print('host', name, p.returncode)
    dump(out / 'host.json', results)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--root', type=Path, default=Path.cwd())
    p.add_argument('--out', type=Path, required=True)
    a = p.parse_args(); a.root = a.root.resolve(); a.out = a.out.resolve()
    if a.out.exists(): p.error('use a new output directory')
    a.out.mkdir(parents=True)
    (a.out / 'SYNTHETIC_ONLY').write_text('No real measurements.\n')
    comparison(a.root, a.out / 'comparison')
    extra(a.root, a.out / 'extra')
    host(a.root, a.out / 'host')
    runner(a.root, a.out / 'runner')


if __name__ == '__main__': main()
