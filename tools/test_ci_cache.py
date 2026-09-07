"""Check cache-key compatibility and writer isolation in the hosted workflows."""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ("quality", "extended")


def cache_steps(workflow: str, action: str) -> list[str]:
    text = (ROOT / ".github" / "workflows" / f"{workflow}.yml").read_text()
    return [
        step
        for step in re.split(r"(?m)^      - name: ", text)
        if f"uses: actions/cache/{action}@" in step
    ]


def key(step: str) -> str:
    match = re.search(r"(?m)^          key: (.+)$", step)
    if match is None:
        raise AssertionError("cache step has no key")
    return match[1]


def block(step: str, name: str) -> list[str]:
    match = re.search(rf"(?m)^          {name}: \|\n((?:            .+\n)+)", step)
    if match is None:
        raise AssertionError(f"cache step has no {name} block")
    return [line.strip() for line in match[1].splitlines()]


def snapshot(template: str, run: int, attempt: int = 1) -> str:
    return template.replace("${{ github.run_id }}", str(run)).replace(
        "${{ github.run_attempt }}", str(attempt)
    )


class CacheContractTest(unittest.TestCase):
    def test_concurrent_workflows_cannot_reserve_the_same_debug_snapshot(self) -> None:
        writers = [
            next(
                step for step in cache_steps(workflow, "save") if "-debug-" in key(step)
            )
            for workflow in WORKFLOWS
        ]
        self.assertNotEqual(
            snapshot(key(writers[0]), 100), snapshot(key(writers[1]), 101)
        )

    def test_repeated_runs_and_attempts_have_distinct_save_keys(self) -> None:
        for workflow in WORKFLOWS:
            for step in cache_steps(workflow, "save"):
                with self.subTest(workflow=workflow, step=step.splitlines()[0]):
                    template = key(step)
                    self.assertEqual(
                        len(
                            {
                                snapshot(template, 100),
                                snapshot(template, 101),
                                snapshot(template, 100, 2),
                            }
                        ),
                        3,
                    )

    def test_restore_prefers_same_commit_then_compatible_dependency_cache(self) -> None:
        for workflow in WORKFLOWS:
            for step in cache_steps(workflow, "restore"):
                with self.subTest(workflow=workflow, step=step.splitlines()[0]):
                    prefix = key(step).split("-${{ github.sha }}", maxsplit=1)[0]
                    self.assertEqual(
                        block(step, "restore-keys"),
                        [prefix + "-${{ github.sha }}-", prefix + "-"],
                    )

    def test_saved_paths_and_keys_are_reusable_by_readers(self) -> None:
        readers = [
            step for workflow in WORKFLOWS for step in cache_steps(workflow, "restore")
        ]
        for workflow in WORKFLOWS:
            for writer in cache_steps(workflow, "save"):
                with self.subTest(workflow=workflow, step=writer.splitlines()[0]):
                    compatible = [
                        reader for reader in readers if key(reader) == key(writer)
                    ]
                    self.assertTrue(compatible)
                    for reader in compatible:
                        self.assertEqual(block(reader, "path"), block(writer, "path"))
                    self.assertIn("github.ref == 'refs/heads/main'", writer)


if __name__ == "__main__":
    unittest.main()
