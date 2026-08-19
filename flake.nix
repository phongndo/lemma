{
  description = "lemma C++23 development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    hk.url = "github:jdx/hk/v1.50.0";
    # Ghostty's overlay provides the exact Zig version required by the production pin.
    zig = {
      url = "github:mitchellh/zig-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    ghosttySource = {
      url = "github:ghostty-org/ghostty/3e7230bf5d0e12d018b850ed3856daa848bfebb7";
      flake = false;
    };
    herdrSource = {
      url = "github:herdrdev/herdr/v0.8.0";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    benchmarkNixpkgs.url = "github:NixOS/nixpkgs/643809054d65fdd466a63e3155b8c498cb483c04";
  };

  outputs =
    { self
    , nixpkgs
    , hk
    , zig
    , benchmarkNixpkgs
    , ghosttySource
    , herdrSource
    , ...
    }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          llvm = pkgs.llvmPackages_22;
          zigPackage = zig.packages.${system}."0.16.0";
          zstdStatic = pkgs.zstd.override {
            static = true;
            buildContrib = false;
            doCheck = false;
          };
          ghosttyDeps = pkgs.callPackage "${ghosttySource}/build.zig.zon.nix" {
            zig_0_16 = zigPackage;
            name = "lemma-ghostty-zig-dependencies-${builtins.substring 0 12 ghosttySource.rev}";
            # Zig's build runner requires real dependency directories rather than symlinks.
            linkFarm = name: entries:
              pkgs.runCommand name { } ''
                mkdir -p "$out"
                ${pkgs.lib.concatMapStringsSep "\n" (entry: ''
                  cp -rL ${entry.path} "$out/${entry.name}"
                '') entries}
              '';
          };
          mkLemma =
            { buildType
            , binaryName
            }:
            llvm.stdenv.mkDerivation {
              pname = binaryName;
              version = "0.1.0";
              src = self;

              nativeBuildInputs = [
                pkgs.cmake
                pkgs.ninja
                pkgs.pkg-config
                zigPackage
              ] ++ pkgs.lib.optionals pkgs.stdenv.isDarwin [
                pkgs.darwin.cctools
                pkgs.xcbuild
              ];
              buildInputs = [
                pkgs.lua5_5
                zstdStatic
              ];

              cmakeFlags = [
                "-DCMAKE_BUILD_TYPE=${buildType}"
                "-DCMAKE_CXX_SCAN_FOR_MODULES=OFF"
                "-DLEMMA_BUILD_TESTS=OFF"
                "-DLEMMA_BUILD_BENCHMARKS=OFF"
                "-DLEMMA_GHOSTTY_SOURCE_DIR=${ghosttySource}"
                "-DLEMMA_GHOSTTY_NIX_SOURCE_REV=${ghosttySource.rev}"
                "-DLEMMA_GHOSTTY_ZIG_SYSTEM_DIR=${ghosttyDeps}"
              ];

              postInstall = pkgs.lib.optionalString (binaryName != "lemma") ''
                mv "$out/bin/lemma" "$out/bin/${binaryName}"
              '';
              dontStrip = buildType == "Debug";

              doInstallCheck = true;
              installCheckPhase = ''
                "$out/bin/${binaryName}" --version | grep -q '^lemma '
              '';

              meta = {
                description = "Self-hosted terminal multiplexer";
                homepage = "https://github.com/phongndo/lemma";
                license = pkgs.lib.licenses.mit;
                mainProgram = binaryName;
                platforms = systems;
              };
            };
        in
        rec {
          lemma = mkLemma {
            buildType = "Release";
            binaryName = "lemma";
          };
          delemma = mkLemma {
            buildType = "Debug";
            binaryName = "delemma";
          };
          default = lemma;
        }
      );

      apps = forAllSystems (
        system:
        rec {
          lemma = {
            type = "app";
            program = "${self.packages.${system}.lemma}/bin/lemma";
          };
          delemma = {
            type = "app";
            program = "${self.packages.${system}.delemma}/bin/delemma";
          };
          default = lemma;
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          benchmarkPkgs = import benchmarkNixpkgs { inherit system; };
          llvm = pkgs.llvmPackages_22;
          isDarwin = pkgs.stdenv.isDarwin;
          darwinTools = llvm.clang-tools;
          zigPackage = zig.packages.${system}."0.16.0";
          ciHk =
            if isDarwin then
              hk.packages.${system}.default
            else
              let
                release =
                  if pkgs.stdenv.hostPlatform.isAarch64 then
                    {
                      target = "aarch64-unknown-linux-gnu";
                      hash = "sha256-dZ94LCTbIJVLRx3mSwqvGxAVftCqG2Tsqbj23E98/As=";
                    }
                  else
                    {
                      target = "x86_64-unknown-linux-gnu";
                      hash = "sha256-qGoZtRJ3QBQQ/PrXb2ULUXKILZGm5iSmO54g+Bpkdrw=";
                    };
              in
              pkgs.stdenvNoCC.mkDerivation {
                pname = "hk";
                version = "1.50.0-bin";
                src = pkgs.fetchurl {
                  url = "https://github.com/jdx/hk/releases/download/v1.50.0/hk-${release.target}.tar.gz";
                  inherit (release) hash;
                };
                dontUnpack = true;
                installPhase = ''
                  mkdir -p "$out/bin"
                  tar -xzf "$src" -C "$out/bin"
                  chmod +x "$out/bin/hk"
                '';
              };
          darwinClang = pkgs.writeShellScriptBin "clang" ''
            exec /usr/bin/clang "$@"
          '';
          darwinClangxx = pkgs.writeShellScriptBin "clang++" ''
            exec /usr/bin/clang++ "$@"
          '';
          darwinClangd = pkgs.writeShellScriptBin "clangd" ''
            resource_dir="$(/usr/bin/env -u SDKROOT DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer /usr/bin/xcrun clang -print-resource-dir)" || exit 1
            exec "${darwinTools}/bin/clangd-unwrapped" \
              --resource-dir="$resource_dir" \
              "$@"
          '';
          darwinClangFormat = pkgs.writeShellScriptBin "clang-format" ''
            exec "${darwinTools}/bin/clang-format" "$@"
          '';
          darwinClangTidy = pkgs.writeShellScriptBin "clang-tidy" ''
            sdk="$(/usr/bin/env -u SDKROOT DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer /usr/bin/xcrun --sdk macosx --show-sdk-path)" || exit 1
            resource_dir="$(/usr/bin/env -u SDKROOT DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer /usr/bin/xcrun clang -print-resource-dir)" || exit 1
            exec "${darwinTools}/bin/clang-tidy-unwrapped" \
              --extra-arg-before=-isysroot \
              --extra-arg-before="$sdk" \
              --extra-arg-before=-resource-dir \
              --extra-arg-before="$resource_dir" \
              "$@"
          '';
          compilerPackages =
            pkgs.lib.optionals isDarwin [
              darwinClang
              darwinClangxx
              darwinClangd
              darwinClangFormat
              darwinClangTidy
            ]
            ++ pkgs.lib.optionals (!isDarwin) [
              llvm.clang
              llvm.clang-tools
            ];
          projectPackages = compilerPackages ++ [
            pkgs.ccache
            pkgs.cmake
            pkgs.conan
            pkgs.git
            pkgs.just
            pkgs.ninja
            pkgs.nixd
            pkgs.nixpkgs-fmt
            pkgs.python3
            pkgs.uv
            zigPackage
          ];
          qualityPackages = [
            pkgs.actionlint
            pkgs.shellcheck
            hk.packages.${system}.default
          ];
          benchmarkPackages = [
            benchmarkPkgs.tmux
            benchmarkPkgs.zellij
            herdrSource.packages.${system}.default
          ];
          shellEnvironment = {
            CMAKE_GENERATOR = "Ninja";
            shellHook =
              if isDarwin then
                ''
                  export PATH="$PWD/build/release:${darwinClang}/bin:${darwinClangxx}/bin:$PATH"
                  export CC=/usr/bin/clang
                  export CXX=/usr/bin/clang++
                  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
                  export SDKROOT="$(/usr/bin/xcrun --sdk macosx --show-sdk-path)"
                ''
              else
                ''
                  export PATH="$PWD/build/release:$PATH"
                  export CC="${llvm.clang}/bin/clang"
                  export CXX="${llvm.clang}/bin/clang++"
                '';
          };
        in
        {
          default = pkgs.mkShell (
            shellEnvironment
            // {
              packages = projectPackages ++ qualityPackages;
            }
          );

          # tmux and Zellij are benchmark subjects, not general development tools.
          benchmarks = pkgs.mkShell (
            shellEnvironment
            // {
              packages = projectPackages ++ benchmarkPackages;
            }
          );

          # Merge-blocking C++ lanes do not need workflow linters or benchmark subjects.
          ci = pkgs.mkShell (
            shellEnvironment
            // {
              packages = projectPackages ++ [
                # CI uses hk's hash-pinned release binary instead of rebuilding its Rust dependency
                # graph on every ephemeral Linux runner.
                ciHk
              ];
            }
          );
        }
      );

      formatter = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        pkgs.writeShellApplication {
          name = "format-flake";
          runtimeInputs = [ pkgs.nixpkgs-fmt ];
          text = ''exec nixpkgs-fmt "$PWD/flake.nix"'';
        }
      );
    };
}
