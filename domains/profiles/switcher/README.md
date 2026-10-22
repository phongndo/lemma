# profiles.switcher

The [profiles](../../../docs/configuration.md#profiles) on the host's machine,
for clients: the web app manages them and switches between them, the desktop
app opens one in a window of its own, and `lemma --profile <name>` with
`--env` reaches one on another machine. Requires `Paths`; serves
`ProfileChannels` from [`@lemma/profiles`](../contract/src/profiles.ts).

- **`profiles.list`** names every profile under the home (`Paths.root`), the
  default first, with the name it was given, its home, whether its host runs,
  and its port.
- **`profiles.open`** answers with a profile's host: its address on its
  machine, its port, and its token. When none runs, it starts one as
  `lemma serve --detach` does, with the `cli` the host supplies, in the
  host's own directory, and waits for it to listen. That host is no child of
  this one: it runs until it is stopped (`lemma --profile <name> stop`). Its
  answer carries a token, so the channel declares `secret`, and an agent's
  scripts never call it (`tools.lemma`).
- **`profiles.set-avatar`** changes a profile's picture (below), and
  **`profiles.rename`** the name it is shown by.
- **`profiles.create`** makes one (`createProfile` in `@lemma/profiles/local`),
  shown by the name it is given; its host starts the first time it is opened.
- **`profiles.stop`** stops another profile's host as
  `lemma --profile <name> stop --force` does, with the same `cli`, whoever
  started it: its running turns resume when it starts again.
- **`profiles.remove`** deletes another profile as `lemma profile remove`
  does, stopping its host first; never the default, nor this host's own.

Settings › Profiles lists them, whether there is one or more, a row each: its
avatar, which changes its picture; its name and its state; Open; and Manage,
which renames it in place, stops its host, copies its command or folder, and
deletes it, after a dialog that says all its data goes with it. New profile, in
the section's head, makes one. A profile deleted in the
desktop app also closes its windows and clears what their pages kept
(`lemmaDesktop.profileRemoved`).

The web half joins the settings button's menu (`SettingsMenu` in
[`@lemma/settings`](../../settings/contract/src/index.ts)) only once there is
more than one profile: until then the button stays a gear that opens settings.
With more, the button is the avatar of the profile this page is, as in a
browser, and its menu names it, lists the others above Settings, and opens
one: through the desktop app's bridge in a desktop window
(`lemmaDesktop.openProfile`), else in a new tab at that profile's address
(`profilePage`), its token in the address as `lemma open` gives it.

## Pictures

A profile's avatar is a pattern until you choose otherwise: the identicon of
its name (`identicon` in `@lemma/look`), as GitHub draws an account with no
picture, a 5×5 grid from a hash of the name, mirrored left to right, in a hue
of its own. The same name makes the same pattern everywhere, and names rarely
make one alike, so every profile has a mark of its own from the start;
renaming it keeps its pattern. In Settings › Profiles, its avatar opens its
choices: eight patterns made afresh, a picture of your own (its middle square,
shrunk to 128 pixels in the browser before it is sent), or its name's pattern
again.

What it chose is kept in its home: `avatar.json` (a pattern's seed, or the
picture's file) and the picture as `avatar.png`, `.jpg`, `.webp`, or `.gif`,
at most 512 KiB. With neither, its pattern is its name's. A pattern is drawn
in `--profile-ink` (its hue, `--profile-hue`, at one saturation and lightness)
on `--profile-pattern-bg`, per theme, which a stylesheet of yours can change.

A profile's address from a page is the page's own machine at the profile's
port: on loopback, the host's own; from another machine, the same name at the
profile's port, so each profile a server keeps is exposed at its own port
([remote access](../../../docs/remote.md#profiles)). Every profile is a
separate origin, so what the browser keeps for one (a mode's last pick, a
draft) is none of another's.

| Config | Default        | What it does                                                                                                                                                         |
| ------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli`  | the host's own | How to run the `lemma` command that starts and stops a profile's host; without one, a profile opens only while its host runs, and is deleted only once it is stopped |

With this plugin off, profiles still work from the CLI and the desktop app
(`--profile`, `LEMMA_PROFILE`); the web app shows none, and a client on
another machine reaches only the profiles whose address it has.
