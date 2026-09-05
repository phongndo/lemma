from __future__ import annotations

import errno
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


class PtyLauncherInstallationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.parent_source = Path(os.environ["LEMMA_TEST_SPAWN_PARENT"]).resolve()
        self.child = Path(os.environ["LEMMA_TEST_SPAWN_CHILD"]).resolve()
        self.helper_source = self.parent_source.with_name("lemma-pty-launcher")
        self.temporary = tempfile.TemporaryDirectory(prefix="lemma-launch-", dir="/tmp")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.directory = self.root / "bin"
        self.directory.mkdir()
        self.parent = self.directory / "renamed-parent"
        shutil.copy2(self.parent_source, self.parent)
        self.helper = self.directory / "lemma-pty-launcher"
        self.decoy = self.root / "decoy"
        self.decoy.mkdir()
        self.marker = self.root / "path-was-used"
        decoy_helper = self.decoy / "lemma-pty-launcher"
        decoy_helper.write_text(f"#!/bin/sh\nprintf bad > '{self.marker}'\nexit 99\n")
        decoy_helper.chmod(0o755)
        self.environment = {
            "PATH": str(self.decoy),
            "HOME": str(self.root),
            "ZDOTDIR": str(self.root),
            "SHELL": "/no-such-caller-shell",
            "LANG": "C",
            "LC_ALL": "C",
        }

    def probe(
        self,
        program: Path | None = None,
        *,
        parent: Path | None = None,
        login: bool = False,
        close_stdin: bool = False,
    ) -> list[dict]:
        arguments = [str(parent or self.parent), "--repeat", "20"]
        if close_stdin:
            arguments.append("--close-stdin")
        if not login:
            arguments.extend((str(program or self.child), "--ready"))
        result = subprocess.run(
            arguments,
            env=self.environment,
            cwd="/",
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        if login:
            self.assertEqual(result.stdout.count("__LOGIN_READY__"), 20, result.stdout)
        records = [
            json.loads(line)
            for line in result.stdout.splitlines()
            if line.startswith("{")
        ]
        self.assertEqual(len(records), 21, result.stdout)
        self.assertEqual(records[-1]["fd_before"], records[-1]["fd_after"])
        self.assertFalse(self.marker.exists(), "helper discovery searched PATH")
        return records[:-1]

    def assert_bootstrap_error(self, expected: int) -> None:
        for record in self.probe():
            self.assertEqual(record["errno"], expected, record)
            self.assertEqual(record["pid"], -1)
            self.assertEqual(record["exit_code"], -1)
            self.assertEqual(record["io_errno"], 0)

    def test_missing_helper_preserves_enoent_without_path_fallback_or_descriptor_leak(
        self,
    ) -> None:
        self.assert_bootstrap_error(errno.ENOENT)

    def test_non_executable_helper_preserves_eacces(self) -> None:
        shutil.copy2(self.helper_source, self.helper)
        self.helper.chmod(0o600)
        self.assert_bootstrap_error(errno.EACCES)

    def test_invalid_helper_preserves_enoexec_instead_of_using_shell_fallback(
        self,
    ) -> None:
        self.helper.write_text("exit 0\n")
        self.helper.chmod(0o700)
        self.assert_bootstrap_error(errno.ENOEXEC)

    def test_renamed_and_symlinked_caller_uses_its_real_executable_sibling(
        self,
    ) -> None:
        shutil.copy2(self.helper_source, self.helper)
        alias = self.decoy / "caller-alias"
        alias.symlink_to(self.parent)
        for record in self.probe(parent=alias):
            self.assertEqual(record["errno"], 0, record)
            self.assertEqual(record["io_errno"], 0)
            self.assertGreater(record["pid"], 0)
            self.assertEqual(record["exit_code"], 0)

    def test_empty_command_uses_account_login_shell_not_caller_shell(self) -> None:
        shutil.copy2(self.helper_source, self.helper)
        for record in self.probe(login=True):
            self.assertEqual(record["errno"], 0, record)
            self.assertEqual(record["io_errno"], 0)
            self.assertEqual(record["exit_code"], 0)

    def test_closed_standard_input_cannot_alias_setup_descriptor_sources(self) -> None:
        shutil.copy2(self.helper_source, self.helper)
        for record in self.probe(close_stdin=True):
            self.assertEqual(record["errno"], 0, record)
            self.assertEqual(record["io_errno"], 0)
            self.assertEqual(record["exit_code"], 0)

    def test_missing_target_remains_a_child_exit_not_a_bootstrap_error(self) -> None:
        shutil.copy2(self.helper_source, self.helper)
        for record in self.probe(self.root / "no-such-target"):
            self.assertEqual(record["errno"], 0, record)
            self.assertGreater(record["pid"], 0)
            self.assertEqual(record["exit_code"], 127)


if __name__ == "__main__":
    unittest.main()
