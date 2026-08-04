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
            if isDarwin then
              zig.packages.${system}.brew."0.15.2"
            else
              zig.packages.${system}."0.15.2";
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
        in
        {
          default = pkgs.mkShell {
            packages =
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
              ]
              ++ [
                pkgs.actionlint
                pkgs.ccache
                pkgs.cmake
                pkgs.conan
                pkgs.just
                pkgs.ninja
                pkgs.nixpkgs-fmt
                pkgs.python3
                pkgs.shellcheck
                pkgs.tmux
                pkgs.zellij
                zigPackage
                hk.packages.${system}.default
              ];

            CMAKE_GENERATOR = "Ninja";

            shellHook =
              if isDarwin then ''
                export PATH="${darwinClang}/bin:${darwinClangxx}/bin:$PATH"
                export CC=/usr/bin/clang
                export CXX=/usr/bin/clang++
                export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
                export SDKROOT="$(/usr/bin/xcrun --sdk macosx --show-sdk-path)"
              '' else ''
                export CC="${llvm.clang}/bin/clang"
                export CXX="${llvm.clang}/bin/clang++"
              '';
          };
        }
      );

      formatter = forAllSystems (system: (import nixpkgs { inherit system; }).nixpkgs-fmt);
    };
}
