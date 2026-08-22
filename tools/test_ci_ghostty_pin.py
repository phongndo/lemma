import json
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = ROOT / "cmake" / "ValidateGhosttyPin.cmake"
PINNED_COMMIT = "3e7230bf5d0e12d018b850ed3856daa848bfebb7"


class GhosttyPinValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.pin_file = self.root / "PIN.json"
        self.source = self.root / "ghostty"
        self.source.mkdir()
        self.write_pin(PINNED_COMMIT)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def write_pin(self, commit: str) -> None:
        self.pin_file.write_text(json.dumps({"commit": commit}), encoding="utf-8")

    def run_validator(self, **defines: str) -> subprocess.CompletedProcess[str]:
        command = ["cmake"]
        for name, value in defines.items():
            command.append(f"-D{name}={value}")
        command.extend(["-P", str(VALIDATOR)])
        return subprocess.run(
            command,
            cwd=self.root,
            text=True,
            capture_output=True,
            check=False,
        )

    def git(self, *args: str, cwd: Path | None = None) -> None:
        completed = subprocess.run(
            ["git", "-c", "commit.gpgsign=false", *args],
            cwd=cwd or self.source,
            text=True,
            capture_output=True,
            check=False,
        )
        if completed.returncode != 0:
            raise AssertionError(completed.stderr)

    def git_head(self) -> str:
        completed = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=self.source,
            text=True,
            capture_output=True,
            check=True,
        )
        return completed.stdout.strip()

    def init_source_repo(self, *, dirty: bool = False) -> str:
        self.git("init")
        self.git("config", "user.email", "lemma@example.com")
        self.git("config", "user.name", "Lemma")
        (self.source / "build.zig").write_text("/* test */\n", encoding="utf-8")
        self.git("add", "build.zig")
        self.git("commit", "-m", "init")
        commit = self.git_head()
        self.write_pin(commit)
        if dirty:
            (self.source / "dirty.txt").write_text("dirty\n", encoding="utf-8")
        return commit

    def test_uninitialized_directory_does_not_use_parent_git(self) -> None:
        self.git("init", cwd=self.root)
        result = self.run_validator(
            GHOSTTY_PIN_FILE=str(self.pin_file),
            GHOSTTY_SOURCE_DIR=str(self.source),
            GHOSTTY_GIT_EXECUTABLE="git",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("submodule is not initialized", result.stderr)
        self.assertNotIn("submodule mismatch", result.stderr)

    def test_nix_attestation_rejects_a_non_store_path(self) -> None:
        result = self.run_validator(
            GHOSTTY_PIN_FILE=str(self.pin_file),
            GHOSTTY_SOURCE_DIR=str(self.source),
            GHOSTTY_NIX_SOURCE_REV=PINNED_COMMIT,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must reside in /nix/store", result.stderr)

    def test_nix_attestation_rejects_a_revision_mismatch(self) -> None:
        result = self.run_validator(
            GHOSTTY_PIN_FILE=str(self.pin_file),
            GHOSTTY_SOURCE_DIR=f"/nix/store/{'0' * 32}-ghostty",
            GHOSTTY_NIX_SOURCE_REV="deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("flake input mismatch", result.stderr)

    def test_matching_clean_checkout_is_accepted(self) -> None:
        self.init_source_repo()
        result = self.run_validator(
            GHOSTTY_PIN_FILE=str(self.pin_file),
            GHOSTTY_SOURCE_DIR=str(self.source),
            GHOSTTY_GIT_EXECUTABLE="git",
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_flake_lock_matches_pin_json(self) -> None:
        pin = json.loads(
            (ROOT / "third_party" / "ghostty-metadata" / "PIN.json").read_text(
                encoding="utf-8"
            )
        )
        lock = json.loads((ROOT / "flake.lock").read_text(encoding="utf-8"))
        self.assertEqual(
            lock["nodes"]["ghosttySource"]["locked"]["rev"],
            pin["commit"],
        )

    def test_dirty_checkout_is_rejected(self) -> None:
        self.init_source_repo(dirty=True)
        result = self.run_validator(
            GHOSTTY_PIN_FILE=str(self.pin_file),
            GHOSTTY_SOURCE_DIR=str(self.source),
            GHOSTTY_GIT_EXECUTABLE="git",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be clean", result.stderr)


if __name__ == "__main__":
    unittest.main()
