from typing import ClassVar

from conan import ConanFile


class LemmaConan(ConanFile):
    package_type = "application"
    settings = "os", "arch", "compiler", "build_type"

    requires = (
        "benchmark/1.9.5",
        "gtest/1.17.0",
        "lua/5.4.8",
        "libsodium/1.0.22",
        "zstd/1.5.7",
    )

    default_options: ClassVar[dict[str, bool]] = {
        "lua/*:shared": False,
        "libsodium/*:shared": False,
        "zstd/*:build_programs": False,
        "zstd/*:shared": False,
    }

    generators = "CMakeDeps", "CMakeToolchain"
