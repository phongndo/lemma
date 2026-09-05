# Local Ghostty patch ledger

Production Ghostty commit: [`3e7230bf5d0e12d018b850ed3856daa848bfebb7`](PIN.json).

The C++ Debug profile builds Ghostty in `ReleaseSafe` (checked LLVM code generation), not Zig's
x86-64 Debug backend. Zig 0.16.0 Debug code generation for the pinned snapshot narrow-cell encoder
can emit a 16-byte store for a four-byte vector, overrunning the writer allocation. The detached
output/response regression in `tests/mux/test_session_lifecycle.py` exercises this snapshot path.
ReleaseSafe retains dependency safety checks; production remains ReleaseFast. Requalify Debug
snapshot encoding under a memory checker before restoring the unoptimized dependency profile.

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
