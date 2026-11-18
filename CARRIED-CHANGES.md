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

## Build the daemon used by env tests

- **Files:** `packages/env/test/build-daemon.ts`, `packages/env/vitest.config.ts`, `test.sh`
- **Reason:** Backport pi commit `97096b4cb937034bfc1615107a949ca9b5c7892c`.
  Build the current daemon before env tests so a stale binary cannot fail process
  capability checks. Keep the installed Rust and Cargo locations in test.sh's
  isolated environment. No toolchain is installed. One `test-policy: allow`
  comment preserves the upstream explicit prebuilt-daemon override; all tests
  still run and no assertion changes.
- **Kind:** upstream backport
- **Removal condition:** Remove when next moves to a pi release that contains
  `97096b4cb937034bfc1615107a949ca9b5c7892c`. The `test-policy: allow` comment
  in `packages/env/test/build-daemon.ts` is fork-only: after that release, keep it
  as a fork difference until pi's file or the fork's test policy makes it
  unnecessary.

## Keep lock-test socket paths short

- **Files:** `packages/chord/test/node/workers/lock.test.ts`
- **Reason:** Backport pi commit `65c43bb520edf53f11923f7a927aefd05475c6af`.
  Create socket files under `/tmp` on Unix so a deep temporary directory does not
  exceed macOS's 103-byte socket-path limit. Windows keeps its temporary directory.
- **Kind:** upstream backport
- **Removal condition:** Remove when next moves to a pi release that contains
  `65c43bb520edf53f11923f7a927aefd05475c6af`.

## Wait for the tutorial's base watcher

- **Files:** `packages/chord/test/examples/61-tutorial/main.ts`
- **Reason:** Backport pi commit `f2bd84a519a57cf2f4e0fd99958fed9556d071f8`.
  Wait for the base watcher before adding a plugin so macOS's FSEvents watch
  rebuild does not drop the plugin-directory event.
- **Kind:** upstream backport
- **Removal condition:** Remove when next moves to a pi release that contains
  `f2bd84a519a57cf2f4e0fd99958fed9556d071f8`.

## Find affected conversations without walking every owner task

- **Files:** `packages/durable/src/harness/scheduler.ts`
- **Reason:** Backport pi commit `628d8ab52ce218b21a3d8f22f087c6f5728f15d1`.
  Start from a changed task's conversation, then follow conversation owners,
  instead of walking every owner task. This removes quadratic work for deep
  task chains. The upstream changelog bullet uses a fork `.changes` fragment.
- **Kind:** upstream backport
- **Removal condition:** Remove when next moves to a pi release that contains
  `628d8ab52ce218b21a3d8f22f087c6f5728f15d1`.

## Update undici for six security advisories

- **Files:** `packages/coding-agent/package.json`, `apps/p2/package.json`,
  `package-lock.json`, `packages/coding-agent/install-lock/package-lock.json`
- **Reason:** Backport pi commit `efbcd5adb4bc89f66a9694093be5785511e3eef6`.
  Update undici from 8.12.3 to 8.12.4 for GHSA-mqg3-3v4r-cm32 (redirect cache
  poisoning), GHSA-7xg3-fphp-28hg (credential-dependent redirect caching),
  GHSA-5rm8-gv32-r954 (cross-origin cache revalidation), GHSA-9v6h-8rgp-m69f
  (redirect credential stripping), GHSA-3g9m-rv3r-w5w2 (cache-replay exceptions),
  and GHSA-r4pc-4jcp-7pqc (integrity metadata whitespace). The version was
  published on 2026-11-05 and meets the seven-day minimum release age.
  The upstream changelog bullet uses a fork `.changes` fragment.
- **Kind:** upstream backport
- **Removal condition:** Remove when next moves to a pi release that contains
  `efbcd5adb4bc89f66a9694093be5785511e3eef6`.
