# Carried changes

This ledger records fork changes to files pi owns. Keep pi's file as the base and
carry only the differences the fork needs. Every PR that adds or changes a carried
difference must update its entry in the same PR.

Each entry gives its **files**, **reason**, **kind** (`upstreamable hook`,
`required integration`, `intentional difference` or `upstream backport`) and
**removal condition**.
New fork-only files are not changes to pi-owned files.

## Change #0: Prime identity

- **Files:**
  - `CARRIED-CHANGES.md`
  - `packages/coding-agent/package.json`
  - `packages/coding-agent/src/config.ts`
  - `packages/coding-agent/src/index.ts`
  - `packages/coding-agent/src/cli/auth-command.ts`
  - `packages/coding-agent/src/extensions/mcp/index.ts`
  - `packages/coding-agent/test/auth-login.test.ts`
  - `packages/coding-agent/test/auth-logout.test.ts`
  - `packages/coding-agent/test/config.test.ts`
  - `packages/coding-agent/test/credential-print.test.ts`
  - `packages/coding-agent/test/first-time-setup.test.ts`
  - `packages/coding-agent/test/interactive-mode-bug-report-hint.test.ts`
  - `packages/coding-agent/test/mcp-command.test.ts`
  - `packages/coding-agent/test/mcp-extension.test.ts`
  - `packages/coding-agent/test/mcp-oauth-refresh.test.ts`
  - `packages/coding-agent/test/package-command-paths.test.ts`
  - `packages/coding-agent/test/package-manager.test.ts`
  - `packages/coding-agent/test/program-status-reporter.test.ts`
  - `packages/coding-agent/test/resource-loader.test.ts`
  - `packages/coding-agent/test/rpc.test.ts`
  - `packages/coding-agent/test/session-file-invalid.test.ts`
  - `packages/coding-agent/test/session-manager/file-operations.test.ts`
  - `packages/coding-agent/test/settings-manager-bug.test.ts`
  - `packages/coding-agent/test/settings-manager.test.ts`
  - `packages/coding-agent/test/stdout-cleanliness.test.ts`
  - `packages/coding-agent/test/suite/agent-session-mcp-oauth.test.ts`
  - `packages/coding-agent/test/suite/regressions/2781-skill-collision-precedence.test.ts`
  - `packages/coding-agent/test/suite/regressions/2791-fswatch-error-crash.test.ts`
  - `packages/coding-agent/test/suite/regressions/8337-utf8-bom-parsing.test.ts`
  - `packages/coding-agent/test/fixtures/subagent-child.mjs`
  - `packages/coding-agent/test/suite/regressions/8261-subagent-project-trust.test.ts`
  - `packages/coding-agent/test/utilities.ts`
  - `packages/coding-agent/test/theme-export.test.ts`
  - `packages/coding-agent/test/theme-picker.test.ts`
  - `packages/coding-agent/test/trust-manager.test.ts`
  - `packages/coding-agent/src/main.ts`
  - `packages/coding-agent/test/deleted-cwd.test.ts`
  - `packages/evals/src/harness.ts`
  - `packages/evals/src/docker.ts`
  - `packages/evals/docker/entrypoint.ts`
  - `packages/evals/test/harness.test.ts`
  - `scripts/smoke-test-codemode-binary.mjs`
  - `scripts/profile-coding-agent-node.mjs`
  - `scripts/coding-agent-smoke.mjs`
- **Reason:** Give the coding agent the Prime name and keep both user and project
  configuration in `.prime/agent`. Normalize the product name for environment
  variables and export the identity names for integrations. Tests follow the
  configured folders, variable names and product-name text. Credential test helpers
  resolve their folder through `getAgentDir()`. Test-only config mocks retain pi's
  official setup, OAuth and managed-update branch coverage; separate rows assert
  Prime's existing setup and OAuth safeguards. The managed npm fixture creates the
  executable from the real package bin manifest (`pi`), not from `APP_NAME`.
  Production safeguards stay unchanged. The subagent fixture publishes its PID
  only after installing its SIGTERM handler and emitting its partial message, so
  the lifecycle test's readiness signal means both are ready. Identity regression
  rows use exact variable names to check the public contract, including the old
  name's absence of effect. The eval harness, container bootstrap and smoke/profile
  scripts follow the configured identity too. Plain-Node scripts derive the same
  variable name from the tested manifest through the fork-only
  `scripts/agent-dir-env.mjs`; the profiler keeps its non-isolated default.
- **Credential removal fix (upstreamable fix):** The harness captures the container
  marker and host path before environment isolation. It removes a credential only
  for a marked container whose path is the entrypoint's bootstrap copy destination
  and whose sandbox IDs are configured. A host run with sandbox IDs alone never
  removes its source file. Source, bootstrap copy and session folder stay distinct.
  Remove this fix when pi adopts the same marker-bound removal condition.
- **CLI folder check:** Refuse before auth dispatch, settings or migrations when the
  project configuration folder resolves to the user folder, including case-only
  aliases and existing symlink ancestors of not-yet-created folders. The shared
  runtime factory repeats the check for the selected session cwd before its settings
  or migrations, covering resumes from another project and later session switches.
  SDK callers passing their own cwd and agent folder are not covered.
- **Recorded exceptions and stage-2 limits:**
  - FR-8 display-only exceptions: `.pi` paths in
    `test/interactive-mode-status.test.ts` and
    `test/tool-execution-component.test.ts` are supplied display text, not config
    discovery paths. These fixtures do not access those paths.
  - FR-8 caller-supplied tilde-expansion exception:
    `test/skills.test.ts:375-389` passes explicit `~/.pi/agent/skills` paths to
    compare tilde expansion with the absolute path. It accesses that caller-supplied
    path, not config-folder resolution; checks use a disposable `HOME`.
  - Test-only official-distribution mocks deliberately supply `pi` and `.pi` to
    exercise pi's guarded branches. Prime behavior has separate assertions.
  - Under risk R5, managed self-update is not reachable for Prime on `next` with
    the current package manifest: verification looks for `prime-agent`, the real
    bin is `pi`, and the managed marker/release service still names pi.dev. The
    managed-update rows exercise pi's official identity, not a fictional Prime
    install. Stage 2 must resolve this before use.
  - Under R5, help/UI still shows the extra `agent` segment, producing
    `~/.prime/agent/agent`: `src/cli/args.ts:415,462`,
    `src/package-manager-cli.ts:313`, `src/extensions/mcp/cli.ts:43` and
    `src/modes/interactive/components/config-selector.ts:206`.
  - MCP empty-state hints and auth credential help now use the configured folders.
    Docs that name `PI_` variables still describe pi; stage 2 owns those corrections.
  - Known unconverted identity consumers remain follow-ups for stage 2 under R5:
    `.github/workflows/issue-analysis.yml`, `apps/p2`,
    `scripts/cost.ts`, `scripts/stats.ts`, `scripts/tool-stats.ts`,
    `scripts/session-transcripts.ts`, `scripts/edit-tool-stats.mjs`,
    `scripts/read-tool-stats.mjs`, `scripts/session-context-stats.mjs` and
    `packages/evals/evals/prompt-templates.docs.eval.ts`.
  - Docker evals now select `~/.prime/agent/auth.json` by default and bind-mount it
    read-only, as pi's Docker design does. Stage 1 runs no Docker or paid eval.
  - Without `piConfig`, the folder fallback is `~/.pi` on this branch, not
    fork/main's `~/.prime/agent`. `next` always ships `piConfig`; changing that
    fallback was not carried under D7.
- **Kind:** intentional difference
- **Removal condition:** Remove when pi offers separate product-identity and folder
  settings that preserve both Prime configuration folders and normalized names.

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
- **Kind:** upstream backport
- **Removal condition:** Remove the backport when next moves to a pi release that
  contains `b48c675a912f7852810e5f8c9f8ca6887b5b851b`. Keep the two fork-only
  `test-policy: allow` comments in `packages/env/test/process.test.ts` until pi's
  file or the fork's test policy makes them unnecessary; the retained upstream
  test still needs those exceptions.

The user chose to restore upstream forced-end handling on next and keep only the
group-only kill (D16). The daemon's response shares the output backlog. Stopping
readers drops output, but the client cannot receive the result while the link is
stalled. `exec.rs`, `process.rs` and `pty.rs` now equal
`b48c675a912f7852810e5f8c9f8ca6887b5b851b`.

The accepted loss is that, even on a healthy link, a timeout, cancel or kill can
keep waiting for a descendant that called `setsid` and keeps writing to the
inherited pipe: each output message resets the exit grace. This is upstream
behavior. The seven rows below covered only a stalled link, not this healthy-link
case. They and their test-only observers were deleted because the user chose to
remove the forced-end fork behavior:

- `exec::tests::pr94_cancel_after_exit_stops_stalled_readers`: removed behavior.
- `exec::tests::pr94_kill_after_exit_stops_stalled_readers`: removed behavior.
- `exec::tests::pr94_timeout_after_exit_stops_stalled_readers`: removed behavior.
- `process::tests::pr94_cancel_after_exit_stops_stalled_readers`: removed behavior.
- `process::tests::pr94_kill_after_exit_stops_stalled_readers`: removed behavior.
- `pty::tests::pr94_cancel_after_exit_stops_stalled_readers`: removed behavior.
- `pty::tests::pr94_kill_after_exit_stops_stalled_readers`: removed behavior.

## Signal only process groups

- **Files:** `packages/env/daemon/src/sys/unix.rs`
- **Reason:** pi's `kill_tree` falls back to `kill(pid)` when the process group
  is gone. After the child was reaped, that pid may belong to another process.
  The backported exit grace made that window much longer. Every caller's child
  gets its own group or session before spawn returns, so the fork signals only
  the group. `configure` returns the `setsid` error if the child cannot establish
  its session, as the pty path already does. Regression tests in the same module
  check that no bare pid is signaled and that an existing process-group leader
  fails to spawn with the OS error. Fork CI runs the daemon's format, lint and
  unit tests in the `other` job.
- **Kind:** intentional difference
- **Removal condition:** Remove when next adopts a pi version whose `kill_tree`
  no longer signals a bare pid and whose `configure` checks `setsid`.

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

## Replace retired Mistral models

- **Files:** `packages/ai/test/abort.test.ts`,
  `packages/ai/test/context-overflow.test.ts`,
  `packages/ai/test/cross-provider-handoff.test.ts`, `packages/ai/test/empty.test.ts`,
  `packages/ai/test/image-tool-result.test.ts`, `packages/ai/test/mistral-raw-stop-reason.test.ts`,
  `packages/ai/test/mistral-tool-schema.test.ts`, `packages/ai/test/responseid.test.ts`,
  `packages/ai/test/stream.test.ts`, `packages/ai/test/tokens.test.ts`,
  `packages/ai/test/tool-call-without-result.test.ts`, `packages/ai/test/total-tokens.test.ts`,
  `packages/ai/test/unicode-surrogate.test.ts`,
  `packages/coding-agent/src/core/model-resolver.ts`
- **Reason:** Backport pi commit `4d6a37d080a3b44c80f6dcb399f853dc7d8ea18f` (#12449).
  Replace the retired Mistral models `devstral-medium-latest` and `pixtral-12b`
  in tests and use `mistral-medium-latest` as the default Mistral model.
  The upstream changelog bullet uses a fork `.changes` fragment.
- **Kind:** upstream backport
- **Removal condition:** Remove when next moves to a pi release that contains
  `4d6a37d080a3b44c80f6dcb399f853dc7d8ea18f`.

## Replace removed OpenCode and Copilot models in tests

- **Files:** `packages/ai/catalog/providers/github-copilot.ts`,
  `packages/ai/catalog/providers/opencode.ts`, `packages/ai/test/cache-retention.test.ts`,
  `packages/ai/test/github-copilot-anthropic.test.ts`,
  `packages/ai/test/openai-completions-tool-choice.test.ts`, `packages/ai/test/providers.test.ts`
- **Reason:** Backport pi commit `45a3cb606776f40f4aa071cf7ed1684b8bc66bd6` (#12492).
  Replace removed Copilot and OpenCode model IDs with current equivalents in
  tests, and remove catalog rules and test cases that apply only to retired models.
- **Kind:** upstream backport
- **Removal condition:** Remove when next moves to a pi release that contains
  `45a3cb606776f40f4aa071cf7ed1684b8bc66bd6`.
