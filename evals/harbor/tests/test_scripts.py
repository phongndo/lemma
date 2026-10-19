"""run.sh with a stand-in `lemma` that records its calls: what a trial asks of Lemma, and how it reports back."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from importlib.resources import files
from pathlib import Path

STUB = """#!{python}
import json, os, sys
args = sys.argv[1:]
with open(os.environ["STUB_CALLS"], "a") as calls:
    calls.write(json.dumps({{"args": args, "home": os.environ.get("LEMMA_HOME")}}) + "\\n")
command = args[0]
if command == "serve":
    print("serve said this")
    sys.exit(int(os.environ.get("STUB_SERVE_CODE", "0")))
if command == "models":
    print(os.environ["LEMMA_EVAL_MODEL"])
    # A long catalog after it, past a pipe's buffer: a reader that stops at the match breaks the pipe, and this fails.
    sys.stdout.write("other/model\\n" * int(os.environ.get("STUB_MODELS_AFTER", "0")))
    sys.stdout.flush()
if command == "run":
    sys.stdout.write(os.environ.get("STUB_RUN_STDOUT", ""))
    sys.stderr.write(os.environ.get("STUB_RUN_STDERR", ""))
    sys.exit(int(os.environ.get("STUB_RUN_CODE", "0")))
"""

PROMPT = 'Fix the test.\n--model is not a flag here; neither is "$HOME" or `x`'


class RunScript(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        base = Path(self.directory.name)
        self.root, self.out, self.task = base / "root", base / "logs", base / "task"
        for path in (self.root / "bin", self.out / "lemma-home", self.task):
            path.mkdir(parents=True)
        stub = self.root / "bin" / "lemma"
        stub.write_text(STUB.format(python=sys.executable))
        stub.chmod(0o755)
        (self.out / "instruction.md").write_text(PROMPT)
        (self.out / "lemma-home" / "token").write_text("secret\n")
        self.calls = base / "calls.jsonl"

    def tearDown(self):
        self.directory.cleanup()

    def run_script(self, **env):
        script = files("lemma_harbor") / "run.sh"
        variables = {
            "PATH": os.environ["PATH"],
            "LEMMA_EVAL_ROOT": str(self.root),
            "LEMMA_EVAL_OUT": str(self.out),
            "LEMMA_EVAL_MODEL": "anthropic/claude-sonnet-4-5",
            "STUB_CALLS": str(self.calls),
            **env,
        }
        done = subprocess.run([shutil.which("bash"), str(script)], cwd=self.task, env=variables, capture_output=True, text=True, timeout=60)
        calls = [json.loads(line) for line in self.calls.read_text().splitlines()] if self.calls.exists() else []
        return done, calls

    def test_a_turn_runs_in_a_host_of_its_own_and_the_host_stops(self):
        result = json.dumps({"reason": "done", "steps": 1})
        done, calls = self.run_script(STUB_RUN_STDOUT=result, LEMMA_EVAL_THINKING="high")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout, result)
        self.assertEqual([call["args"][0] for call in calls], ["serve", "models", "run", "stop"])
        self.assertEqual(calls[0]["args"], ["serve", "--detach"])
        run = calls[2]["args"]
        self.assertEqual(run, ["run", "new", "--json", "--questions", "dismiss", "--model", "anthropic/claude-sonnet-4-5", "--thinking", "high", "--", PROMPT])
        self.assertEqual(calls[3]["args"], ["stop", "--force"])
        self.assertEqual({call["home"] for call in calls}, {str(self.out / "lemma-home")})
        self.assertEqual((self.out / "lemma-run.exit").read_text().strip(), "0")
        self.assertFalse((self.out / "lemma-home" / "token").exists())

    def test_a_model_listed_early_in_a_long_catalog_is_found_at_once(self):
        done, calls = self.run_script(STUB_RUN_STDOUT="{}", STUB_MODELS_AFTER="20000")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual([call["args"][0] for call in calls], ["serve", "models", "run", "stop"])

    def test_a_turn_that_failed_still_reports_its_result(self):
        result = json.dumps({"reason": "error", "error": "429"})
        done, _ = self.run_script(STUB_RUN_STDOUT=result, STUB_RUN_CODE="1")
        self.assertEqual((done.returncode, done.stdout), (0, result))
        self.assertEqual((self.out / "lemma-run.exit").read_text().strip(), "1")

    def test_no_result_fails_with_what_lemma_said(self):
        error = '{"error": {"code": "NoHost", "message": "no host"}}'
        done, calls = self.run_script(STUB_RUN_STDERR=error, STUB_RUN_CODE="3")
        self.assertEqual(done.returncode, 3)
        self.assertIn("NoHost", done.stderr)
        self.assertEqual(calls[-1]["args"], ["stop", "--force"])

    def test_a_host_that_does_not_start_runs_nothing(self):
        done, calls = self.run_script(STUB_SERVE_CODE="1")
        self.assertEqual(done.returncode, 1)
        self.assertIn("serve said this", done.stderr)
        self.assertEqual([call["args"][0] for call in calls], ["serve"])


if __name__ == "__main__":
    unittest.main()
