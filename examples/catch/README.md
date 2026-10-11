# Catch

Catch is a small Gym-style environment for the Decision API skill. Install
[uv](https://docs.astral.sh/uv/) and use Python 3.11 or newer. `uv run` installs
`pygame-ce>=2.5` from `game.py`'s PEP 723 declaration for this example
only; the fork's package dependencies do not change. This example uses
`record=False`, so ffmpeg is not needed. `headless=True` runs without
a display. Each run writes into its own `examples/catch/runs/catch-*` directory.

In Prime Agent, set `decisionApi.systemOneModel` in settings.json to
`typesafe/jev-1.13.0`. In models.json, configure provider `typesafe` with
`api: "systemone"`, `baseUrl: "https://api.typesafe.ai/v1"`, model
`jev-1.13.0`, `input: ["text"]`, and its credentials. Restart the session or
kernel; the `decision-api` skill appears once the setting resolves. System 1
is a direct `decide()` call. Jev takes text only. Run this in the persistent
Python REPL with the skill enabled, substituting the repository path:

```python
import sys
sys.path.insert(0, "<repo>/examples/catch")
import env

catch = await env.CatchEnv.make(seconds=60, seed=1, record=False, headless=True)
loop = None
try:
    observation, info = await catch.reset()

    async def observe():
        return None if observation.get("done") or observation.get("truncated") else observation

    async def act(action):
        global observation
        observation, reward, terminated, truncated, info = await catch.step(action)
        if terminated or truncated:
            observation = {**observation, "done": True}

    loop = decision_api.Loop(observe, act, catch.actions, objective="Catch the falling circles", tick=0.1)
    # Jev takes text only; keep the rendered frame out of the text state.
    loop.state = env.observation_state
    loop.start()
    while (await loop.wait(timeout=10))["running"]:
        print(loop.status(), loop.errors[-3:])
    print(await catch.close())
finally:
    if loop is not None:
        await loop.stop()
    await catch.close()
```

The first `reset()` starts the episode clock. `step(action)` returns
`(observation, reward, terminated, truncated, info)`; reward is catches minus
drops since the previous step. `close()` returns the final score and optional
recording path and is safe to call again. The session agent designs the loop;
the environment supplies observations and applies actions.

Each observation is the text state (`picture`, `bowl`, `caught`, `missed`,
`done`) plus the rendered frame as a 360x360 PNG data URL (`image`).
`loop.state = env.observation_state` keeps the data URL out of the text.
Omit the `loop.images` assignment because Jev takes text only; the compact
text state still reaches System 1.
