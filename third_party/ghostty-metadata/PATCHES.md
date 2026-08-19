# Local Ghostty patch ledger

Production Ghostty commit: [`3e7230bf5d0e12d018b850ed3856daa848bfebb7`](PIN.json).

There are **no local Ghostty patches**. The submodule must be clean and exactly match `PIN.json` at
configure time and whenever the Ghostty archive is built or reused.

Any future patch must be recorded here before it is applied. Each entry must contain:

- affected Ghostty commit and patch file;
- upstream issue or pull request URL;
- exact reason Lemma cannot wait for upstream;
- behavior and dedicated Lemma regression test;
- owner and removal condition; and
- the upgrade where the patch was revalidated or removed.

A patch may not silently change child-visible capabilities, snapshot compatibility, allocator
behavior, or a public `libghostty-vt` result/mode/effect contract.
