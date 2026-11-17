---
name: verify
description: Start this checkout's TUI in a scratch root with a local faux model, drive it with keys and read the screen. Use before committing a change to interactive mode, TUI components, dialogs, keybindings or extension UI, and when reviewing such a change. Not for unit tests or real provider calls.
---

# Verify a TUI change by driving it

Unit tests check components in isolation. This skill boots the real program from
this checkout, sends real keys through tmux and reads the rendered screen, so it
catches what only the running TUI shows: focus, overlays, dialog order, redraws
and crashes. Keep each run short; it is a smoke test, not a test suite.

## What a run is isolated from

Each `verify-tui.sh start` makes a new root `/tmp/pv-XXXXXX` and runs the program
with only that root:

- `HOME`, the agent folder (`PRIME_AGENT_CODING_AGENT_DIR`) and `TMPDIR`, so the
  daemon, its socket, sessions, settings and logs are new. `start` refuses
  `--cwd`, `--session-dir`, `--session`, `--daemon-socket`, `--socket`,
  `--resume` and `--fork`, so a run cannot reach the shared daemons or `~/.prime`.
- `PRIME_AGENT_KERNEL_VENV`, so the Python kernel builds its own venv in the
  background. It uses uv's shared download caches with `UV_OFFLINE=1`: it never
  downloads, and on a cold cache the kernel fails to start. The run still writes
  to the shared uv cache and Python folder.
- An empty environment (`env -i`): no API keys, `--offline`, trace sharing off,
  onboarding skipped.
- The `faux` model from `faux-provider.ts`. It answers `faux reply 1`,
  `faux reply 2` and so on, with no network or cost.
- A private tmux server on `<root>/tmux.sock`, with `remain-on-exit` on so a
  crash stays on screen, and csi-u extended keys as in
  `packages/coding-agent/docs/tmux.md`.

## Steps

Each shell command is a new process, so pass `VERIFY_ROOT` to every call after
`start`. The examples use `V=.agents/skills/verify/verify-tui.sh` from the
repository root.

1. Run `npm ci` in the checkout once. tmux is required.
2. Start: `out="$($V start)" && eval "$out"`. This sets `VERIFY_ROOT`; a failed
   start removes its root and prints no export line. Options: `--cols N --rows N`
   (default 120 x 40) and `--repo DIR` to run another checkout of this
   repository. After `--`, other `prime-agent` arguments are passed on, for
   example `-- -e my-extension.ts`; a relative `-e` path resolves against the
   folder where you run `start`.
3. Wait for the prompt: `VERIFY_ROOT=... $V wait 'model faux' 60`.
4. Drive the path your diff changes, and only that path:
   - `$V type 'text'` types literal text.
   - `$V keys Enter`, `Escape`, `Tab`, `Up`, `C-c`, `M-x` and other
     `tmux send-keys` names.
   - `$V wait '<regex>' [seconds]` waits until the screen matches. It fails at
     once when the TUI has exited, with the whole scrollback on stderr, and on a
     timeout with the current screen.
   - `$V screen` prints the current screen.
5. To exercise extension UI, write a small extension that calls the API under
   test, for example a command that opens two `ctx.ui.select` dialogs, and pass
   it with `-- -e <file>`. Keep it outside the repository unless it becomes a test.
6. Always stop, also after a failure: `VERIFY_ROOT=... $V stop`. It shuts down
   the scratch daemon with `shutdown --force`, ends leftover processes whose
   command line names the root, such as the kernel, and deletes the root. It
   exits 1 when the daemon shutdown fails. Run `stop` in its own command, not in
   one shell line that also names the root.

`stop` and the other commands refuse any `VERIFY_ROOT` that is not a
`/tmp/pv-XXXXXX` directory you own with the state file that `start` wrote.

## Show that a fix works

For a bug fix, run the same steps on the base commit and on your change, for
example `--repo <worktree at the base>`. The check is useful only if it fails on
the base and passes on the change. Record both results.

## Report

In the commit, PR text or review report, give the commit you ran, the keys you
sent, what you waited for, and pass or fail. Quote the screen lines that decide
the result, not whole screens.

## Limits

- The faux model gives fixed text replies. Model, tool-call and streaming
  behavior that needs a real provider is not covered.
- tmux is not Ghostty, iTerm or kitty: no kitty keyboard protocol, and images
  and some escape sequences render differently.
- Startup runs from source through tsx, so the first screen takes a few seconds.
- `.agents/` is outside tsconfig and biome, so a change to the faux provider API
  shows up only when the skill runs.
