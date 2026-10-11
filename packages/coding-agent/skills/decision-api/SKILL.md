---
name: decision-api
description: Experimental System 1 / System 2 loop for real-time, low-latency tasks. System 1 is the model named by the decisionApi.systemOneModel setting, called directly through the host bridge to pick every action from observations; System 2 is you, updating the goal each later decision reads. You design, measure, and optimize the whole loop. Requires the decisionApi.systemOneModel setting.
---

# Decision API (System 1 / System 2)

Use this for real-time control tasks where every step is one choice from an
action set (a game, a device, a UI) and a full agent turn per step is too slow.

- **System 1** is the decision model the user configured: the
  `decisionApi.systemOneModel` setting names it. This fork uses Jev
  (`typesafe/jev-1.13.0`) through the `systemone` API. Jev takes text only.
  Each observation becomes one host request and one model call that returns
  the chosen action and its confidence. `loop.status()["system1_model"]`
  reports the model that served the last decision.
- **System 2** is you, running the loop. `loop.set_goal("...")` updates
  the goal that the next decision reads. Goals are one or two sentences of
  strategy, never an action name or a step-by-step command.

```text
observe -> build state + latest goal -> host decision -> act -> history
                    ^                                      |
                 set_goal                           next observation
```

## Your role: optimize the whole loop

You own the loop's design and performance:
- what System 1 sees (`state`, and `images` with a vision-capable model);
- how its question reads (`instructions` and the action descriptions);
- its `history_size`, `tick`, and `decide_timeout`;
- the goals you update with `set_goal` and the `objective` they refine.

Writing the task's strategy into System 1's instructions and action
descriptions is loop design, not goal updating.

Diagnose from the outcome before changing anything. The task's own result
(score, success rate) is the measure; `loop.history` confidences and
`loop.goal_updates` explain it.
- **System 1 problems:** low confidence, actions flipping between options,
  or failures while the goal stays the same. Give `state` the information
  the decision needs, sharpen `instructions`, or make the action descriptions
  easier to tell apart.
- **Goal problems:** goals that are wrong, churn, or lag the situation.
  Update the goal only when the situation genuinely needs a new direction;
  `loop.goal` starts as the `objective`.
- **No goals needed:** for pure reflexes or one fixed strategy, never call
  `set_goal`; the objective alone is enough.

Change one thing at a time and compare runs under the same conditions (same
seed or scenario, same duration), keeping what measurably helps. Make changes
through the loop's settings or the task's own code, never by editing this
skill's package. Do the analysis yourself rather than delegating it to extra
subagents.

You never steer the live loop by hand:
- Do not choose actions from observations yourself.
- `loop.goal` is yours (it starts as the `objective`): `set_goal` updates
  it live.

## Setup

The Decision API is off until configured. The user adds a `typesafe`
provider to `models.json`:

```json
{
  "providers": {
    "typesafe": {
      "baseUrl": "https://api.typesafe.ai/v1",
      "api": "systemone",
      "apiKey": "!doppler secrets get <SECRET_NAME> --plain --project <PROJECT> --config <CONFIG>",
      "models": [{ "id": "jev-1.13.0", "input": ["text"] }]
    }
  }
}
```

Then the user sets `decisionApi.systemOneModel` in `settings.json` and
reloads the session or kernel:

```json
{ "decisionApi": { "systemOneModel": "typesafe/jev-1.13.0" } }
```

The host resolves the model and its credentials through the model registry
and makes every provider call. No key enters the kernel. If a call reports
that the setting is unset or unresolvable, ask the user to fix the setting.
Do not ask for keys yourself.

Data rule: `state` holds the control task's observations only, never code,
file contents, secrets or personal data. The host logs the full state and
decision results locally.

## Usage

Write `observe` and `act` for the environment (sync or async), start the loop
in the background, then watch and adjust it from later cells:

```python
actions = {
    "left": "Move left when the target is to the left",
    "right": "Move right when the target is to the right",
    "wait": "Do nothing when already aligned",
}
loop = decision_api.Loop(observe, act, actions, objective="Keep the paddle under the ball", tick=0.3)
loop.start()

status = await loop.wait(timeout=20)   # returns early if the loop ends
print(status, loop.history[-5:], loop.goal_updates[-3:], loop.errors[-3:])
```

Every attribute is read again each step, so assignments take effect live:

```python
loop.actions["fire"] = "Fire when an enemy is straight ahead"   # or a function (observation) -> dict
loop.instructions = "..."; loop.tick = 0.2
loop.state = lambda observation, goal, history: {...}           # exactly what System 1 sees
loop.images = lambda observation: [png_data_url]                # vision models: up to 4 images per step
loop.on_error = "skip"            # "stop" (default), "skip", or (error, observation) -> action
loop.on_step = lambda record, observation: ...                  # log or render; return "stop" to end the loop
loop.set_goal("Prioritize catching the ball over waiting")      # System 2: update the next decision's goal
loop.objective = "..."           # the goal's fallback; set_goal overrides it
loop.decide_timeout = 30.0       # bound one decision round trip
loop.pause(); loop.resume()
final = await loop.stop()
```

Construction accepts the same settings as keywords (`decide_timeout=10`,
`max_steps=500`, `history_size=10`, ...); `help(decision_api.Loop)` lists all
of them. `await loop.run()` runs to completion in one cell instead.

Each step calls the host's `decision_api.decide` request directly. A
failure appears in `loop.errors`; a decision that overruns
`decide_timeout` fails the step and follows `on_error`. Python 3.11 or
newer is required.

Stay in your turn while a loop runs: poll with `loop.wait(timeout=...)`, read
`history`, `goal_updates`, and `errors`, adjust, and stop it when done. The
loop keeps running between cells, but nothing wakes you once your turn ends.
With `autoReload` set to `"idle"`, an automatic reload can also restart the
kernel after your turn ends and stop the loop, so keep loops inside your turn.

For a single System 1 decision without a loop, `await
decision_api.decide(observation, actions, goal="...", images=None)` returns
`action`, `confidence`, `probabilities`, `latency_ms`, `model`, and
`usage`. When the host cannot write the decision log, it also returns
`log_error`; Loop history and `on_step` records carry that error too. The
decision still succeeds and is never retried because of a log write failure.

Jev takes text only: leave `loop.images` unset. For a different configured
`systemone` model with image input, pass at most 4 images per decision,
each a data URL
string such as `f"data:image/png;base64,{base64.b64encode(png_bytes).decode()}"`
(not bytes, paths, or dicts); PNG, JPEG, or WebP, up to 4 MiB and 16
megapixels each and 8 MiB in total. Small, cropped images keep latency low;
degenerate ones (a 1x1 pixel) fail with a server error.
