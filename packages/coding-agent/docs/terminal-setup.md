# Terminal Setup

Prime Agent uses the [Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) for reliable modifier key detection. Most modern terminals support this protocol, but some require configuration.

## Tern native fullscreen (opt-in)

Set `PI_TUI_NATIVE=1` before starting Prime Agent to use Tern's native transcript scrolling in the session's fullscreen view. Nothing changes without this opt-in. Other fullscreen screens, including the agents view, keep the ANSI renderer. If the terminal does not support TSP, Prime uses the ANSI renderer. If Tern reports a protocol error, Prime switches to the ANSI renderer for the rest of the session. To turn native mode off, unset `PI_TUI_NATIVE` or set it to `0`. When Prime quits to a shell prompt, Tern removes the transcript from the pane; it does not stay in the scrollback as it does with the ANSI renderer.

To enable it only in Tern, add this to your shell configuration:

```sh
[[ $TERM_PROGRAM == tern ]] && export PI_TUI_NATIVE=1
```

Use Tern's **Reader** chat style. Spine and Console constrain the transcript width and are not supported by this layout. Prime hides the "fallback" label that Tern puts on each block of rows. It does this with a stylesheet on a Tern class that is not documented, so a Tern update can bring the label back. Native mode does not show the top bar with the chat name and cost; Tern's tab shows the name.

The mouse wheel and `Shift+PgUp` scroll the transcript. Prime's viewport-top and follow bindings reveal the start and end. On a long transcript, one viewport-top press can stop short of the start, especially after you return from Ctrl+Z, the agents view or the external editor. Use the mouse wheel or `Shift+PgUp` to reach the start. Tern 0.6.3 binds `Ctrl+Shift+Down`, the default follow key, to Park pane, so that key may not reach Prime; bind `tui.viewport.follow` to another key in [`keybindings.json`](keybindings.md). Plain `PgUp` and `PgDn` reach the focused component instead of paging the transcript.

Native mode does not support Prime's click actions:
- Placing the editor cursor with a click.
- Expanding or collapsing shell output, background shell completions, errors, branch and compaction summaries, custom messages, injected prompts, harness refinement outcomes, skill invocations, and event summaries.
- Click actions supplied by extensions through `Clickable` or component click regions, including actions inside tool panels and side questions.

The keyboard actions remain available. Tern owns text selection and scrolling; Prime does not map Tern pointer events to component click regions.

Code that stops the TUI to hand the terminal to another program must first `await tui.releaseNative()`. It closes the native surface and consumes replies in flight for 50 ms before the next program reads stdin. With native mode off, it resolves at once and writes nothing.

## Kitty, iTerm2

Work out of the box.

## Ghostty

Add to your Ghostty config (`~/Library/Application Support/com.mitchellh.ghostty/config` on macOS, `~/.config/ghostty/config` on Linux):

```
keybind = alt+backspace=text:\x1b\x7f
```

Older Claude Code versions may have added this Ghostty mapping:

```
keybind = shift+enter=text:\n
```

That mapping sends a raw linefeed byte. Inside Prime Agent, that is indistinguishable from `Ctrl+J`, so tmux and Prime Agent no longer see a real `shift+enter` key event.

If Claude Code 2.x or newer is the only reason you added that mapping, you can remove it, unless you want to use Claude Code in tmux, where it still requires that Ghostty mapping.

If you want `Shift+Enter` to keep working in tmux via that remap, add `ctrl+j` to your Prime Agent `newLine` keybinding in `~/.prime/agent/keybindings.json`:

```json
{
  "newLine": ["shift+enter", "ctrl+j"]
}
```

## WezTerm

Create `~/.wezterm.lua`:

```lua
local wezterm = require 'wezterm'
local config = wezterm.config_builder()
config.enable_kitty_keyboard = true
return config
```

## VS Code (Integrated Terminal)

`keybindings.json` locations:
- macOS: `~/Library/Application Support/Code/User/keybindings.json`
- Linux: `~/.config/Code/User/keybindings.json`
- Windows: `%APPDATA%\\Code\\User\\keybindings.json`

Add to `keybindings.json` to enable `Shift+Enter` for multi-line input:

```json
{
  "key": "shift+enter",
  "command": "workbench.action.terminal.sendSequence",
  "args": { "text": "\u001b[13;2u" },
  "when": "terminalFocus"
}
```

## Windows Terminal

Add to `settings.json` (Ctrl+Shift+, or Settings → Open JSON file) to forward the modified Enter keys Prime Agent uses:

```json
{
  "actions": [
    {
      "command": { "action": "sendInput", "input": "\u001b[13;2u" },
      "keys": "shift+enter"
    },
    {
      "command": { "action": "sendInput", "input": "\u001b[13;3u" },
      "keys": "alt+enter"
    }
  ]
}
```

- `Shift+Enter` inserts a new line.
- Windows Terminal binds `Alt+Enter` to fullscreen by default. That prevents Prime Agent from receiving `Alt+Enter` for follow-up queueing.
- Remapping `Alt+Enter` to `sendInput` forwards the real key chord to Prime Agent instead.

If you already have an `actions` array, add the objects to it. If the old fullscreen behavior persists, fully close and reopen Windows Terminal.

## xfce4-terminal, terminator

These terminals have limited escape sequence support. Modified Enter keys like `Ctrl+Enter` and `Shift+Enter` cannot be distinguished from plain `Enter`, preventing custom keybindings such as `submit: ["ctrl+enter"]` from working.

For the best experience, use a terminal that supports the Kitty keyboard protocol:
- [Kitty](https://sw.kovidgoyal.net/kitty/)
- [Ghostty](https://ghostty.org/)
- [WezTerm](https://wezfurlong.org/wezterm/)
- [iTerm2](https://iterm2.com/)
- [Alacritty](https://github.com/alacritty/alacritty) (requires compilation with Kitty protocol support)

## IntelliJ IDEA (Integrated Terminal)

The built-in terminal has limited escape sequence support. Shift+Enter cannot be distinguished from Enter in IntelliJ's terminal.

If you want the hardware cursor visible, set `PI_HARDWARE_CURSOR=1` before running `prime-agent` (disabled by default for compatibility).

Consider using a dedicated terminal emulator for the best experience.

### macOS Control+Option+Arrow shortcuts

Pending-message reordering defaults to `Control+Option+Up` and `Control+Option+Down`. Prime Agent accepts modern modified-arrow sequences and legacy Option-as-Meta wrapped Control+Arrow sequences. macOS VoiceOver uses Control+Option as its modifier, and system or terminal shortcuts can intercept these chords before they reach Prime Agent. If that happens, remap `app.message.moveEarlier` and `app.message.moveLater` in `~/.prime/agent/keybindings.json`.
