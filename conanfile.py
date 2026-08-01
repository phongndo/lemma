from conan import ConanFile


class LemmaConan(ConanFile):
    package_type = "application"
    settings = "os", "arch", "compiler", "build_type"

    requires = (
        "benchmark/1.9.5",
        "gtest/1.17.0",
        "lua/5.5.0",
        "zstd/1.5.7",
    )

    default_options = {
        "lua/*:shared": False,
        "lua/*:with_tools": False,
        "zstd/*:build_programs": False,
        "zstd/*:shared": False,
    }

    generators = "CMakeDeps", "CMakeToolchain"
