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

      # Lemma's stable release, as `nix profile install github:phongndo/lemma` or a flake input installs it
      # (docs/installation.md#nix): the release's archive, which nix/release.json names (the Promote workflow writes it),
      # with what installed it. On Linux it runs on nixpkgs' Node.js 24 rather than the one it carries, which patchelf
      # breaks, and its packages' native libraries are patched to find theirs in the store, so NixOS needs no nix-ld. A
      # release is for Apple silicon, and Linux on arm64 and x86_64.
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          inherit (pkgs) lib;
          release = builtins.fromJSON (builtins.readFile ./nix/release.json);
          archive = release.archives.${system} or null;
        in
        lib.optionalAttrs (archive != null) rec {
          lemma = pkgs.stdenv.mkDerivation {
            pname = "lemma";
            inherit (release) version;
            src = pkgs.fetchurl { inherit (archive) url hash; };
            nativeBuildInputs = lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.autoPatchelfHook ];
            buildInputs = lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.stdenv.cc.cc.lib ];
            dontConfigure = true;
            dontBuild = true;
            dontStrip = true;
            # The release's own command alone: its packages' scripts run on the Node.js it carries.
            dontPatchShebangs = true;
            installPhase = ''
              runHook preInstall
              mkdir -p $out/share/lemma $out/bin
              cp -R . $out/share/lemma
              printf '{"installer": "nix"}\n' > $out/share/lemma/install.json
              patchShebangs --host $out/share/lemma/bin
              ${lib.optionalString pkgs.stdenv.hostPlatform.isLinux "ln -sf ${pkgs.nodejs_24}/bin/node $out/share/lemma/runtime/bin/node"}
              ln -s $out/share/lemma/bin/lemma $out/bin/lemma
              runHook postInstall
            '';
            meta = {
              description = "Agent harness in which every part is a plugin";
              homepage = "https://github.com/phongndo/lemma";
              license = lib.licenses.mit;
              mainProgram = "lemma";
              platforms = builtins.attrNames release.archives;
              sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
            };
          };
          default = lemma;
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
