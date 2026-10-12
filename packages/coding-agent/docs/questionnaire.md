# Questionnaire

The built-in `questionnaire` tool asks one or more questions. It is enabled by default.
An explicit tool allowlist must include `questionnaire` to enable it.
Non-interactive sessions without a UI return an error.

## Form

Pass a `questions` array. Each question has:

- `id`: a unique, non-empty string.
- `label`: an optional tab label. The default is `Q1`, `Q2`, and so on.
- `prompt`: non-empty question text.
- `options`: an array of `{ value, label, description?, recommended? }` objects.
  Values must be unique within the question.
- `allowOther`: whether the user can type an answer. The default is `true`.

An option with `recommended: true` displays `— Recommended` after its label.
At most one option per question can be recommended.
A question with no options must allow a typed answer.
The tool rejects invalid forms before requesting input or writing session entries.

```json
{
  "questions": [
    {
      "id": "scope",
      "label": "Scope",
      "prompt": "Which scope should we use?",
      "options": [
        { "value": "small", "label": "Keep the change small", "recommended": true },
        { "value": "large", "label": "Include the larger change" }
      ],
      "allowOther": true
    }
  ]
}
```

Before a material choice, the assistant should explain verified facts, trade-offs,
its recommendation, and uncertainty. Call this tool alone in an assistant turn.

## Clients and controls

The local TUI shows question tabs, Submit, and Defer. Selecting an answer advances
to the next unanswered question. Submit requires an answer to every question.
Cancel ends the form without submitting. There is no response deadline.

The form uses configurable keybindings: `tui.input.tab` or
`tui.editor.cursorRight` moves forward, `tui.editor.cursorLeft` moves back,
`tui.select.up` and `tui.select.down` choose options, `tui.select.confirm` confirms,
and `tui.select.cancel` cancels or returns from typed input.

A daemon-attached TUI uses the same component when every attached UI client
advertises `questionnaire_ui`. RPC, older clients, older daemons, and mixed UI
client sets keep the standard select/input dialogs with a review and edit step.
A client-set change cancels a pending native request and falls back to those
dialogs. An aborted call ends cancelled. Invalid native replies end cancelled
with an error note and never submit answers.

Extensions can call `ctx.ui.questionnaire(form, opts?)`, where `form` contains
parsed `questions` and saved `answers` keyed by question ID. Each saved answer
has `value` and `wasCustom`. The method returns `{ status, answers }`, or
`undefined` when the client needs the standard dialogs. `opts.signal` dismisses
a pending form.

## Results and saved progress

Results include model-facing text and `details` with `questions`, ordered
`answers`, and `cancelled`. Each answer has `id`, `value`, `label`, and
`wasCustom`. An offered answer also has its one-based `index`.

Defer does not submit. It returns `deferred: true`, `retry` with `available` and
`savedAnswers`, and `terminate: true`. Its text lists the questions in chat.
Only completed answers are saved. Unconfirmed typed text is not saved.
The assistant must wait for the user's next instruction before reopening.

Saved progress uses `questionnaire_retry_state` version 1 custom session entries.
The form key and entry format match the previous extension. An identical form
restores saved answers on the current session branch. Submit and Cancel clear
saved progress. Changed question text, options, or labels produce a different
form key.

A valid form emits `questionnaire:needs_input` once on the shared extension event
bus. Extensions such as terminal alerts can keep listening for this event.

## Extension cutover

A loaded extension tool named `questionnaire` still overrides the built-in.
Existing installations therefore keep their extension behavior until the owner
removes or disables that extension after a release. No extension or user
configuration is changed automatically. Existing version 1 saved progress can
be reopened by the native tool after that separately approved cutover.
