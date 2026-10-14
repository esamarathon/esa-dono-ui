#!/usr/bin/env python3
"""Apply the tracked caller patch on private non-repository copies; never run callers."""
import argparse
import ast
import pathlib
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--parent-root', type=pathlib.Path, required=True)
args = parser.parse_args()
repo = pathlib.Path(__file__).resolve().parent.parent
patch = repo / 'scripts/parent-pledge-callers.patch'
files = ['scripts/e2e-incentives.ts', 'scripts/test-incentives.sh', 'staging/incentive-test.py']
with tempfile.TemporaryDirectory(prefix='caller-patch-') as name:
    root = pathlib.Path(name)
    for file in files:
        target = root / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(args.parent_root.resolve() / file, target)
    check = subprocess.run(['git', 'apply', '--check', str(patch)], cwd=root, capture_output=True)
    if check.returncode == 0:
        subprocess.run(['git', 'apply', str(patch)], cwd=root, check=True)
    else:
        # An already-applied patch is valid too. Never force over unrelated edits.
        subprocess.run(['git', 'apply', '--reverse', '--check', str(patch)], cwd=root, check=True)
    assert not (root / '.git').exists()
    subprocess.run(['bash', '-n', str(root / files[1])], check=True)
    python = ast.parse((root / files[2]).read_text())
    for statement in python.body:
        if isinstance(statement, ast.Assign) and any(isinstance(t, ast.Name) and t.id in ['fixture', 'probe'] for t in statement.targets):
            subprocess.run(['node', '--check', '--input-type=module'], input=ast.literal_eval(statement.value), text=True, check=True)
    subprocess.run(['python3', str(root / files[2]), '--help'], check=True, stdout=subprocess.DEVNULL)
    subprocess.run([str(repo / 'node_modules/.bin/tsc'), '--noEmit', '--strict', '--skipLibCheck',
                    '--target', 'ES2023', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--types', 'node',
                    '--typeRoots', str(repo / 'node_modules/@types'), str(root / files[0])], check=True)
    print('PASS: standalone nonrepo Git apply/reverse-check, shell/Python/embedded JS/strict TS syntax; no caller or container executed')
