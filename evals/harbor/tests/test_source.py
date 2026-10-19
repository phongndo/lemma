import os
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path

from lemma_harbor.source import pack


def git(repo: Path, *args: str) -> str:
    identity = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}
    command = ["git", "-C", str(repo), "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", *args]
    return subprocess.run(command, check=True, capture_output=True, text=True, env={**os.environ, **identity}).stdout.strip()


class Pack(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        self.repo, self.cache = root / "repo", root / "cache"
        self.repo.mkdir()
        git(self.repo, "init", "-q")
        (self.repo / "package.json").write_text("{}\n")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-qm", "one")
        self.first = git(self.repo, "rev-parse", "HEAD")
        (self.repo / "package.json").write_text('{"v": 2}\n')
        (self.repo / "uncommitted.txt").write_text("not packed\n")
        git(self.repo, "commit", "-qam", "two")

    def tearDown(self):
        self.directory.cleanup()

    def test_a_revision_packs_its_commit_s_files_only(self):
        source = pack("HEAD~1", self.repo, self.cache)
        self.assertEqual(source.commit, self.first)
        self.assertEqual(source.short, self.first[:12])
        with tarfile.open(source.archive) as archive:
            self.assertEqual(archive.getnames(), ["package.json"])
            self.assertEqual(archive.extractfile("package.json").read(), b"{}\n")

    def test_each_commit_is_packed_once(self):
        first = pack("HEAD", self.repo, self.cache)
        stamp = first.archive.stat().st_mtime_ns
        again = pack(first.commit, self.repo, self.cache)
        self.assertEqual(again.archive, first.archive)
        self.assertEqual(again.archive.stat().st_mtime_ns, stamp)
        self.assertEqual([path.name for path in self.cache.iterdir()], [first.archive.name])

    def test_an_unknown_revision_fails_naming_it(self):
        with self.assertRaisesRegex(ValueError, "no-such-branch"):
            pack("no-such-branch", self.repo, self.cache)


if __name__ == "__main__":
    unittest.main()
