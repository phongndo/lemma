# profiles.switcher

The profiles on the host's machine ([profiles](../README.md)), for clients:
the web app switches between them, the desktop app opens one in a window of
its own, and `lemma --profile <name>` with `--env` reaches one on another
machine. Requires `Paths`; serves `ProfileChannels` from
[`@lemma/profiles`](../contract/src/profiles.ts).

- **`profiles.list`** names every profile under the home (`Paths.root`), the
  default first, with whether its host runs and its port.
- **`profiles.open`** answers with a profile's host: its address on its
  machine, its port, and its token. When none runs, it starts one as
  `lemma serve --detach` does, with the `cli` the host supplies, in the
  host's own directory, and waits for it to listen. That host is no child of
  this one: it runs until it is stopped (`lemma --profile <name> stop`). Its
  answer carries a token, so the channel declares `secret`, and an agent's
  scripts never call it (`tools.lemma`).
- **`profiles.set-avatar`** changes a profile's picture (below).
- **`profiles.create`** makes one: an empty home with a port of its own
  (`createProfile` in `@lemma/profiles/local`); its host starts the first time
  it is opened.

The web half joins the settings button's menu (`SettingsMenu` in
[`@lemma/settings`](../../settings/contract/src/index.ts)) only once there is
more than one profile: until then the button stays a gear that opens settings,
and a person who has never made a profile sees nothing of them. With more, the
button is the avatar of the profile this page is, as in a browser, and its menu
names it, lists the others above Settings, and opens one: through the desktop
app's bridge in a desktop window (`lemmaDesktop.openProfile`), else in a new
tab at that profile's address (`profilePage`), its token in the address as
`lemma open` gives it. Settings › Profiles says what a profile is, lists them
with their pictures and an Open button, and makes one.

## Pictures

A profile's avatar is a pattern until you choose otherwise, as GitHub draws an
account with no picture (an identicon): a 5×5 grid from a hash of its name,
mirrored left to right, in one of eight hues (`src/pattern.ts`). The same name
makes the same pattern everywhere, and names rarely make one alike, so every
profile has a mark of its own from the start. In Settings › Profiles, a
profile's avatar opens its choices: eight patterns made afresh, a picture of
your own (its middle square, shrunk to 128 pixels in the browser before it is
sent), or its name's pattern again.

What it chose is kept in its home: `avatar.json` (a pattern's seed, or the
picture's file) and the picture as `avatar.png`, `.jpg`, `.webp`, or `.gif`,
at most 512 KiB. With neither, its pattern is its name's. The hues are tokens,
`--profile-hue-0` to `--profile-hue-7` on `--profile-pattern-bg`, per theme,
which a stylesheet of yours can change.

A profile's address from a page is the page's own machine at the profile's
port: on loopback, the host's own; from another machine, the same name at the
profile's port, so each profile a server keeps is exposed at its own port
([remote access](../../../docs/remote.md#profiles)). Every profile is a
separate origin, so what the browser keeps for one (a mode's last pick, a
draft) is none of another's.

| Config | Default        | What it does                                                                                                       |
| ------ | -------------- | ------------------------------------------------------------------------------------------------------------------ |
| `cli`  | the host's own | How to run the `lemma` command that starts a profile's host; without one, a profile opens only while its host runs |

With this plugin off, profiles still work from the CLI and the desktop app
(`--profile`, `LEMMA_PROFILE`); the web app shows none, and a client on
another machine reaches only the profiles whose address it has.
