"""The Lemma checkout a trial installs: a commit of a repository, as a tarball."""

from __future__ import annotations

import os
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path


def _git(repo: Path, *args: str) -> str:
    try:
        done = subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True)
    except FileNotFoundError as error:
        raise ValueError("git is needed to pack the Lemma revision") from error
    except subprocess.CalledProcessError as error:
        raise ValueError(f"git {' '.join(args)} failed in {repo}: {error.stderr.strip()}") from error
    return done.stdout.strip()


def default_repo() -> Path:
    """The repository this package lives in (`uv run --project evals/harbor` installs it editable)."""
    try:
        return Path(_git(Path(__file__).resolve().parent, "rev-parse", "--show-toplevel"))
    except ValueError as error:
        raise ValueError("lemma_harbor is not inside a Lemma checkout: pass the repository with --ak repo=<path>") from error


def cache_dir() -> Path:
    base = os.environ.get("XDG_CACHE_HOME") or str(Path.home() / ".cache")
    return Path(base) / "lemma-harbor"


@dataclass(frozen=True)
class Source:
    """A commit of Lemma, packed with `git archive`: committed files only, so a result names exactly what ran."""

    repo: Path
    commit: str
    archive: Path

    @property
    def short(self) -> str:
        return self.commit[:12]


def pack(revision: str = "HEAD", repo: Path | str | None = None, cache: Path | None = None) -> Source:
    """The revision's tarball, made once per commit and kept in the cache."""
    root = Path(repo).expanduser().resolve() if repo is not None else default_repo()
    commit = _git(root, "rev-parse", "--verify", f"{revision}^{{commit}}")
    directory = cache or cache_dir()
    directory.mkdir(parents=True, exist_ok=True)
    archive = directory / f"lemma-{commit}.tar.gz"
    if not archive.is_file():
        # Written aside and renamed, so trials packing the same commit at once never read half a file.
        handle, partial = tempfile.mkstemp(dir=directory, prefix=f".lemma-{commit}.", suffix=".tar.gz")
        os.close(handle)
        try:
            _git(root, "archive", "--format=tar.gz", "-o", partial, commit)
            os.replace(partial, archive)
        finally:
            Path(partial).unlink(missing_ok=True)
    return Source(repo=root, commit=commit, archive=archive)
