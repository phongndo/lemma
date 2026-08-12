{
  description = "lemma C++23 development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    hk.url = "github:jdx/hk/v1.50.0";
    # Ghostty's overlay provides a Zig 0.15.2 build compatible with current Xcode SDKs.
    zig = {
      url = "github:mitchellh/zig-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    { nixpkgs
    , hk
    , zig
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
      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          llvm = pkgs.llvmPackages_22;
          isDarwin = pkgs.stdenv.isDarwin;
          darwinTools = llvm.clang-tools;
          zigPackage =
            if isDarwin then zig.packages.${system}.brew."0.15.2" else zig.packages.${system}."0.15.2";
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
            zigPackage
          ];
          qualityPackages = [
            pkgs.actionlint
            pkgs.shellcheck
            hk.packages.${system}.default
          ];
          benchmarkPackages = [
            pkgs.tmux
            pkgs.zellij
          ];
          shellEnvironment = {
            CMAKE_GENERATOR = "Ninja";
            shellHook =
              if isDarwin then
                ''
                  export PATH="$PWD/build/debug:${darwinClang}/bin:${darwinClangxx}/bin:$PATH"
                  export CC=/usr/bin/clang
                  export CXX=/usr/bin/clang++
                  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
                  export SDKROOT="$(/usr/bin/xcrun --sdk macosx --show-sdk-path)"
                ''
              else
                ''
                  export PATH="$PWD/build/debug:$PATH"
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
