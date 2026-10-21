# release.updates

What this Lemma is, and updating it. Its host half serves `ReleaseChannels`
([`@lemma/release`](../contract/src/index.ts)) by asking the `lemma` command
beside the host, which knows a release from a checkout and how to replace one:

- `release.status` (`read`): what `lemma version` says (asked once), and what
  the last check found.
- `release.check` (`read`): asks now (`lemma update --check`).
- `release.update` (`change`): installs the channel's newest release, or the
  version given (`lemma update`), and once it has answered, has the `lemma`
  the installer links restart the host on it (`lemma restart --force`), apart
  from the host so that it outlives it.

It checks by itself a minute after the host starts, then every six hours, and
when a newer release is out says so once per release, as a notice. It adds
`lemma doctor`'s Updates check, which asks now. Its web half is Settings ›
About: the version, the build, where it is installed, and the Node.js it runs
on; with an installed release, the check's switch, the channel, and the
Update button, which asks first, as `lemma stop` does, what restarting cuts
off, then reloads the page once the host is back on the new release. The
section's badge says when an update is out.

## Config

```jsonc
{ "plugins": { "release.updates": { "config": { "check": false } } } }
```

| Field   | Default                | Meaning                                                                                  |
| ------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| `check` | `true`                 | Ask every few hours whether a newer release is out on this install's channel, and say so |
| `cli`   | set by `packages/host` | How to run the `lemma` command beside the host, as a shell command line                  |

## Rationale

- **The command knows releases; this plugin shows them.** What a release is
  (`release.json`), how the installer installed it (`install.json`), which
  release is newest, installing one, and restarting a host however it was
  started are the `lemma` command's (`apps/cli/src/release.ts`), which works
  with no host. Asking it keeps one way of doing each, and lets a user's
  replacement do the same with no more than a shell.
- **A checkout updates with git.** Its status says it is one; it checks for
  nothing and refuses to update (`Checkout`), as does a release the installer
  did not install (`NotInstalled`).
- **The channel is the install's.** The installer records it with each
  release, and `lemma update --channel` switches it, so it is not a setting
  here: each install on a machine may follow its own.
- **Restarting is the new release's.** The host cannot start its successor
  from its own process: it has the installer's `lemma`, the new release's,
  stop it and start it again, as `lemma restart` does by hand, through the
  service manager for a host a service runs.
