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
      ghosttyPinMetadata =
        builtins.fromJSON (builtins.readFile ./third_party/ghostty-metadata/PIN.json);
      ghosttyPin =
        if ghosttySource.rev == ghosttyPinMetadata.commit then
          ghosttyPinMetadata.commit
        else
          throw "Ghostty flake input ${ghosttySource.rev} does not match PIN.json ${ghosttyPinMetadata.commit}";
      ghosttyFeatureProfile = ghosttyPinMetadata.production_vt_feature_profile;
      mkGhosttyDeps = pkgs: zigPackage:
        pkgs.callPackage "${ghosttySource}/build.zig.zon.nix" {
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
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          llvm = pkgs.llvmPackages_22;
          zigPackage = zig.packages.${system}."0.16.0";
          zigTarget = "${pkgs.stdenv.hostPlatform.parsed.cpu.name}-${
            if pkgs.stdenv.isDarwin then "macos" else "linux-gnu"
          }";
          zstdStatic = pkgs.zstd.override {
            static = true;
            buildContrib = false;
            doCheck = false;
          };
          ghosttyDeps = mkGhosttyDeps pkgs zigPackage;
          mkLemma = buildType:
            llvm.stdenv.mkDerivation {
              pname = "lemma";
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
                pkgs.lua5_4
                zstdStatic
              ];

              cmakeFlags = [
                "-DCMAKE_BUILD_TYPE=${buildType}"
                "-DCMAKE_CXX_SCAN_FOR_MODULES=OFF"
                "-DLEMMA_BUILD_TESTS=OFF"
                "-DLEMMA_BUILD_BENCHMARKS=OFF"
                "-DLEMMA_GHOSTTY_SOURCE_DIR=${ghosttySource}"
                "-DLEMMA_GHOSTTY_NIX_SOURCE_REV=${ghosttyPin}"
                "-DLEMMA_GHOSTTY_ZIG_SYSTEM_DIR=${ghosttyDeps}"
                "-DLEMMA_GHOSTTY_ZIG_TARGET=${zigTarget}"
                "-DLEMMA_GHOSTTY_VT_FEATURE_PROFILE=${ghosttyFeatureProfile}"
              ] ++ pkgs.lib.optionals pkgs.stdenv.isLinux [
                "-DLEMMA_GHOSTTY_ZIG_LIBC=../.lemma-zig-libc.txt"
              ];

              preConfigure = pkgs.lib.optionalString pkgs.stdenv.isLinux ''
                mkdir -p "$TMPDIR/zig-global-cache"
                ZIG_GLOBAL_CACHE_DIR="$TMPDIR/zig-global-cache" zig libc > .lemma-zig-libc.txt
              '';

              doInstallCheck = true;
              installCheckPhase = ''
                "$out/bin/lemma" --version | grep -q '^lemma '
              '';

              meta = {
                description = "Self-hosted terminal multiplexer";
                homepage = "https://github.com/phongndo/lemma";
                license = pkgs.lib.licenses.mit;
                mainProgram = "lemma";
                platforms = systems;
              };
            };
        in
        rec {
          lemma = mkLemma "Release";
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
          ghosttyDeps = mkGhosttyDeps pkgs zigPackage;
          devLemma = pkgs.writeShellScriptBin "lemma" ''
            root="$(${pkgs.git}/bin/git rev-parse --show-toplevel)" || {
              echo "lemma: not inside a Lemma checkout" >&2
              exit 1
            }
            runner="$root/scripts/dev-run"
            if [[ ! -x "$runner" ]]; then
              echo "lemma: $root does not contain scripts/dev-run" >&2
              exit 1
            fi
            exec "$runner" "$@"
          '';
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
          linuxClangd = pkgs.writeShellScriptBin "clangd" ''
            exec "${llvm.clang-tools}/bin/clangd" \
              --query-driver="${llvm.clang}/bin/clang++,${llvm.clang}/bin/clang" \
              "$@"
          '';
          linuxClangTidy = pkgs.writeShellScriptBin "clang-tidy" ''
            exec "${llvm.clang-tools}/bin/clang-tidy" \
              --extra-arg-before=-resource-dir \
              --extra-arg-before="${llvm.clang}/resource-root" \
              --extra-arg-before=-isystem \
              --extra-arg-before="${pkgs.gcc.cc}/include/c++/${pkgs.gcc.version}" \
              --extra-arg-before=-isystem \
              --extra-arg-before="${pkgs.gcc.cc}/include/c++/${pkgs.gcc.version}/${pkgs.stdenv.hostPlatform.config}" \
              --extra-arg-before=-idirafter \
              --extra-arg-before="${llvm.stdenv.cc.libc_dev}/include" \
              "$@"
          '';
          darwinClang = pkgs.writeShellScriptBin "clang" ''
            exec /usr/bin/clang "$@"
          '';
          darwinClangxx = pkgs.writeShellScriptBin "clang++" ''
            exec /usr/bin/clang++ "$@"
          '';
          # Nix's xcbuild xcrun warns while parsing newer Xcode platform metadata.
          # Zig treats any stderr from a successful build step as a failed-command diagnostic.
          darwinXcrun = pkgs.writeShellScriptBin "xcrun" ''
            exec /usr/bin/xcrun "$@"
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
              darwinXcrun
              darwinClangd
              darwinClangFormat
              darwinClangTidy
            ]
            ++ pkgs.lib.optionals (!isDarwin) [
              llvm.clang
              llvm.clang-tools
              linuxClangd
              linuxClangTidy
            ];
          projectPackages = compilerPackages ++ [
            devLemma
            pkgs.ccache
            pkgs.cmake
            pkgs.conan
            pkgs.git
            pkgs.just
            pkgs.lua5_4
            pkgs.ninja
            pkgs.nixd
            pkgs.nixpkgs-fmt
            pkgs.pkg-config
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
          ] ++ pkgs.lib.optionals (!isDarwin) [
            pkgs.perf
          ];
          shellEnvironment = {
            CMAKE_GENERATOR = "Ninja";
            LEMMA_GHOSTTY_SOURCE_DIR = "${ghosttySource}";
            LEMMA_GHOSTTY_NIX_SOURCE_REV = ghosttyPin;
            LEMMA_GHOSTTY_ZIG_SYSTEM_DIR = "${ghosttyDeps}";
            shellHook =
              if isDarwin then
                ''
                  export PATH="${devLemma}/bin:${darwinClang}/bin:${darwinClangxx}/bin:${darwinXcrun}/bin:$PATH"
                  export CC=/usr/bin/clang
                  export CXX=/usr/bin/clang++
                  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
                  export SDKROOT="$(/usr/bin/xcrun --sdk macosx --show-sdk-path)"
                ''
              else
                ''
                  export PATH="${devLemma}/bin:${linuxClangd}/bin:${linuxClangTidy}/bin:$PATH"
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

          # Platform validation needs project tools only. Keep formatting-only hk out so ephemeral
          # runners never rebuild its Rust dependency graph from crates.io.
          platform = pkgs.mkShell (
            shellEnvironment
            // {
              packages = projectPackages;
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
