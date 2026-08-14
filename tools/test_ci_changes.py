import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


def load_module(name: str, relative_path: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


changes = load_module("ci_changes", "scripts/ci/changes.py")


class CiChangesTests(unittest.TestCase):
    def selected(self, *paths: str) -> set[str]:
        result = changes.classify_paths(paths)
        return {lane for lane, selected in result.items() if selected}

    def test_pushes_compare_ref_endpoints(self):
        self.assertEqual(
            changes.diff_revisions("old", "new", "push"),
            ["old", "new"],
        )

    def test_pull_requests_compare_from_the_merge_base(self):
        self.assertEqual(
            changes.diff_revisions("base", "head", "pull_request"),
            ["base...head"],
        )

    def test_unrelated_documentation_selects_no_expensive_lane(self):
        self.assertEqual(self.selected("README.md", "docs/quality.md"), set())

    def test_test_change_selects_only_cpp_correctness(self):
        self.assertEqual(self.selected("tests/core_test.cpp"), {"cpp"})

    def test_library_change_selects_cpp_correctness(self):
        self.assertEqual(
            self.selected("include/lemma/id.hpp", "src/core/lemma.cpp"),
            {"cpp"},
        )

    def test_application_change_selects_cpp_correctness(self):
        self.assertEqual(self.selected("apps/lemma/main.cpp"), {"cpp"})

    def test_benchmark_change_selects_cpp_jobs(self):
        self.assertEqual(self.selected("benchmarks/lemma_benchmark.cpp"), {"cpp"})

    def test_dependency_change_selects_cpp_correctness(self):
        self.assertEqual(
            self.selected("conan.lock", "third_party/ghostty"),
            {"cpp"},
        )

    def test_tidy_configuration_selects_cpp_correctness(self):
        self.assertEqual(self.selected(".clang-tidy"), {"cpp"})

    def test_ci_test_change_selects_automation_lane(self):
        self.assertEqual(self.selected("tools/test_ci_changes.py"), {"automation"})

    def test_workflow_change_runs_every_lane(self):
        result = changes.classify_paths([".github/workflows/quality.yml"])
        self.assertTrue(all(result.values()))

    def test_ci_script_change_runs_every_lane(self):
        result = changes.classify_paths(["scripts/ci/configure"])
        self.assertTrue(all(result.values()))

    def test_toolchain_change_validates_full_local_contract(self):
        result = changes.classify_paths(["flake.nix"])
        self.assertTrue(all(result.values()))


if __name__ == "__main__":
    unittest.main()
