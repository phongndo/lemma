{
  description = "Lemma development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { nixpkgs
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
        in
        rec {
          default = pkgs.mkShell {
            packages = [
              pkgs.git
              pkgs.hk
              pkgs.nodejs_24
              pkgs.pnpm_12
              pkgs.nixd
              pkgs.nixpkgs-fmt
            ];
          };
          browser = pkgs.mkShell ({
            inputsFrom = [ default ];
          } // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
            packages = [ pkgs.chromium ];
            LEMMA_CHROMIUM = "${pkgs.chromium}/bin/chromium";
          });
          # Building the desktop app and opening it as a user would (scripts/dist-desktop.ts, dist-desktop-check.ts). On
          # Linux: nixpkgs' fpm for the Debian package, as electron-builder's own runs /bin/bash, which NixOS has not;
          # dpkg and a virtual display for the check; and the libraries Electron's prebuilt binary loads, which NixOS
          # finds for it through nix-ld, with this nixpkgs' glibc, which they are built against.
          desktop = pkgs.mkShell ({
            inputsFrom = [ default ];
          } // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
            packages = [ pkgs.fpm pkgs.dpkg pkgs.xvfb-run ];
            USE_SYSTEM_FPM = "true";
            shellHook = ''
              export NIX_LD="${pkgs.lib.fileContents "${pkgs.stdenv.cc}/nix-support/dynamic-linker"}"
              export NIX_LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath (with pkgs; [
                alsa-lib at-spi2-atk atk cairo cups dbus expat fontconfig freetype gdk-pixbuf glib gtk3 harfbuzz libdrm
                libgbm libGL libnotify libsecret libx11 libxcb libxcomposite libxdamage libxext libxfixes libxi
                libxkbcommon libxrandr libxrender libxshmfence libxtst nspr nss pango systemd util-linux
              ])}''${NIX_LD_LIBRARY_PATH:+:$NIX_LD_LIBRARY_PATH}"
            '';
          });
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
