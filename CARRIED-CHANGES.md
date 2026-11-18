# Carried changes

This ledger records fork changes to files pi owns. Keep pi's file as the base and
carry only the differences the fork needs. Every PR that adds or changes a carried
difference must update its entry in the same PR.

Each entry gives its **files**, **reason**, **kind** (`upstreamable hook`,
`required integration`, `intentional difference` or `upstream backport`) and
**removal condition**.
New fork-only files are not changes to pi-owned files.

## Fork development rules

- **Files:** `AGENTS.md`
- **Reason:** Keep the fork's Testing Policy, seven-day dependency age with the
  approved exemptions, per-package `.changes` fragments and no-autonomous-merge
  rule alongside pi's current development instructions.
- **Kind:** intentional difference
- **Removal condition:** Remove each fork rule when pi adopts it or the fork owner
  explicitly retires it. Fragment folding remains the fork release owner's work.

## Dependency release age

- **Files:** `.npmrc`, `README.md`
- **Reason:** Set a seven-day release age while keeping `save-exact=true` and the
  approved `@cotal-ai/core` and `@earendil-works/*` exemptions.
- **Kind:** intentional difference
- **Removal condition:** Remove this difference when pi's settings match, or the
  fork owner changes the approved dependency-age policy.

## Fork checks in the root check chain

- **Files:** `package.json`
- **Reason:** Run the fork's test-policy scan and push-guard fixtures after all of
  pi's existing check steps. The scan requires a `next` merge base unless the caller
  supplies the existing explicit base override.
- **Kind:** required integration
- **Removal condition:** Remove the appended checks when pi supplies equivalent
  checks, or the fork owner retires the corresponding policy or guard.

## Together Kimi K3 catalog expectation

- **Files:** `packages/ai/test/together-models.test.ts`
- **Reason:** Backport pi commit `0a25dd15e1685e98472d58cc526ec73f8a789ecd`.
  Fork CI used a catalog with a 1,048,576-token output limit while the test
  still expected 131,072.
- **Kind:** upstream backport
- **Removal condition:** Remove when next moves to a pi release that contains
  `0a25dd15e1685e98472d58cc526ec73f8a789ecd`.

## Drain output while the link holds readers

- **Files:** `packages/env/daemon/src/exec.rs`,
  `packages/env/daemon/src/output.rs`, `packages/env/daemon/src/process.rs`,
  `packages/env/daemon/src/pty.rs`, `packages/env/test/process.test.ts`
- **Reason:** Backport pi commit `b48c675a912f7852810e5f8c9f8ca6887b5b851b`.
  Fork CI lost final output when the exit grace elapsed while the link held a
  reader up. The upstream changelog bullet uses a fork `.changes` fragment.
  Two `test-policy: allow` comments name the upstream commit and preserve its
  client-stall timer and failure timeout. Its behavior and assertions stay unchanged.
- **Fork fix:** A separate commit on top, "Bound forced output drain and signal
  only process groups", fixes a defect the backport introduced: in `exec.rs`,
  `process.rs` and `pty.rs`, a forced end (timeout, cancel or kill) now stops
  readers and cannot extend the exit grace while the link holds them. Its
  regression tests stay in those source modules; a `#[cfg(test)]`-only `Control`
  observer signals consumed exits for deterministic test coordination. Fork CI
  runs the daemon's format, lint and unit tests in the `other` job.
- **Kind:** upstream backport
- **Removal condition:** Remove when next moves to a pi release that contains
  `b48c675a912f7852810e5f8c9f8ca6887b5b851b` and an equivalent fix for the forced-end drain.

## Signal only process groups

- **Files:** `packages/env/daemon/src/sys/unix.rs`
- **Reason:** pi's `kill_tree` falls back to `kill(pid)` when the process group
  is gone. After the child was reaped, that pid may belong to another process.
  The backported exit grace made that window much longer. Every caller's child
  gets its own group or session before spawn returns, so the fork signals only
  the group. A regression test in the same module checks that no bare pid is
  signaled.
- **Kind:** intentional difference
- **Removal condition:** Remove when pi's `kill_tree` no longer signals a bare
  pid, or when next moves to a pi release with an equivalent fix.
