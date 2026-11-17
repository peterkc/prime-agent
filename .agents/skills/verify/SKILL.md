---
name: verify
description: Start this checkout's TUI in a scratch home with a local faux model, drive it with keys and read the screen. Use before committing a change to interactive mode, TUI components, dialogs, keybindings or extension UI, and when reviewing such a change. Not for unit tests or real provider calls.
---

# Verify a TUI change by driving it

Unit tests check components in isolation. This skill boots the real program from
this checkout, sends real keys through tmux and reads the rendered screen, so it
catches what only the running TUI shows: focus, overlays, dialog order, redraws
and crashes. Keep each run short; it is a smoke test, not a test suite.

## What a run is isolated from

Each `verify-tui.sh start` makes a new root under `/tmp/pv-*` and gives the
program only that root:

- `HOME`, the agent folder (`PRIME_AGENT_CODING_AGENT_DIR`) and `TMPDIR`, so the
  daemon, its socket, sessions, settings and logs are new. The shared daemons and
  `~/.prime` are never touched.
- `PRIME_AGENT_KERNEL_VENV`, so the Python kernel builds its own venv. uv's
  download caches are shared, so the venv builds from the cache in about 30
  seconds, in the background.
- An empty environment (`env -i`): no API keys, `--offline`, trace sharing off,
  onboarding skipped.
- The `faux` model from `faux-provider.ts`. It answers `faux reply 1`,
  `faux reply 2` and so on, with no network or cost.
- A private tmux server on `<root>/tmux.sock`, with `remain-on-exit` on so a
  crash stays on screen, and csi-u extended keys as in `docs/tmux.md`.

## Steps

1. Run `npm ci` in the checkout once. tmux is required.
2. Start: `eval "$(.agents/skills/verify/verify-tui.sh start)"`. This
   exports `VERIFY_ROOT`. Options: `--cols N --rows N` (default 120 x 40),
   `--repo DIR` to run another checkout of this repository, and after `--` any
   `prime-agent` arguments, such as `-e path/to/extension.ts`.
3. Wait for the prompt: `verify-tui.sh wait 'model faux' 60`.
4. Drive the path your diff changes, and only that path:
   - `verify-tui.sh type 'text'` types literal text.
   - `verify-tui.sh keys Enter`, `Escape`, `Tab`, `Up`, `C-c`, `M-x` and other
     `tmux send-keys` names.
   - `verify-tui.sh wait '<regex>' [seconds]` waits until the screen matches. It
     fails with the screen on stderr when the time runs out or the TUI exits.
   - `verify-tui.sh screen` prints the current screen.
5. To exercise extension UI, write a small extension that calls the API under
   test, for example a command that opens two `ctx.ui.select` dialogs, and pass
   it with `-- -e <file>`. Keep it outside the repository unless it becomes a test.
6. Always stop, also after a failure: `verify-tui.sh stop`. It shuts down the
   scratch daemon, ends every process under the root and deletes the root.

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
