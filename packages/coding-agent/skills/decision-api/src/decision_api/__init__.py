"""Prime Agent decision-api skill: an experimental System 1 / System 2 loop.

System 1 is the session's decision model: the model the user named in the
decisionApi.systemOneModel setting. `decide()` calls it once for a single
decision; `Loop` calls it for each observation. System 2 is you, the calling
agent: `set_goal` updates the goal each later decision reads. You design,
measure, and adjust the loop live.
"""

from __future__ import annotations

import asyncio
import inspect
import time
from typing import Any, Callable

from rlm import host_request

DEFAULT_INSTRUCTIONS = (
    "Choose the next action that best advances the goal given the observation."
)
# One decision request's wall-clock bound.
DECIDE_TIMEOUT = 30.0
_MAX_ERRORS = 50


def _default_state(
    observation: Any, goal: str, history: list[dict[str, Any]],
) -> dict[str, Any]:
    """What System 1 sees by default: the observation and recent actions."""
    state: dict[str, Any] = {"observation": observation}
    if history:
        state["recent_actions"] = history
    return state


async def _ask_system1(
    state: Any,
    actions: dict[str, str],
    *,
    instructions: str = DEFAULT_INSTRUCTIONS,
    images: list[str] | None = None,
) -> dict[str, Any]:
    """One System 1 decision for an arbitrary `state`. The host serves the
    request with the decisionApi.systemOneModel model through the normal
    provider transports; no key ever enters this kernel. `images`
    (vision models only, at most 4) are data URL strings
    (`data:image/png;base64,...`).
    Returns `action`, `confidence`, `probabilities`, `latency_ms`, `model`,
    `usage`, and `log_error` when the host reports a log write failure."""
    question = {
        "type": "choice", "instructions": instructions, "criteria": actions,
    }
    request: dict[str, Any] = {
        "state": state, "questions": {"action": question},
    }
    if images:
        bad = [
            repr(image)[:40] for image in images
            if not (
                isinstance(image, str) and image.startswith("data:image/")
            )
        ]
        if bad:
            raise TypeError(
                "images must be data URL strings like "
                f"'data:image/png;base64,...', got {bad}"
            )
        request["images"] = list(images)
    started = time.perf_counter()
    body = await host_request("decision_api.decide", {"request": request})
    answer = body["answers"]["action"]
    decision = {
        "action": answer["choice"],
        "confidence": answer["confidence"],
        "probabilities": answer["probabilities"],
        "latency_ms": round((time.perf_counter() - started) * 1000, 1),
        "model": body.get("model"),
    }
    for name in ("usage", "log_error"):
        if name in body:
            decision[name] = body[name]
    return decision


async def decide(
    observation: Any,
    actions: dict[str, str],
    *,
    goal: str = "",
    history: list[dict[str, Any]] | None = None,
    instructions: str = DEFAULT_INSTRUCTIONS,
    images: list[str] | None = None,
) -> dict[str, Any]:
    """A single System 1 decision with the default state."""
    state = _default_state(observation, goal, history or [])
    if goal:
        state["goal"] = goal
    return await _ask_system1(
        state, actions, instructions=instructions, images=images,
    )


async def _call(fn: Callable[..., Any], *args: Any) -> Any:
    result = fn(*args)
    return await result if inspect.isawaitable(result) else result


class Loop:
    """A live System 1 / System 2 control loop.

    System 1 calls the configured decision model for each observation.
    System 2 is you: `set_goal` updates the goal every later decision reads.

    Every attribute is read afresh each step, so assigning one on a running
    loop changes the next step. `goal` is yours: it starts as `objective`
    and `set_goal` updates it.

    - `observe()` returns an observation, or None to end the loop.
    - `act(action)` applies an action. Both may be sync or async.
    - `actions`: action name -> when it applies, or `(observation) -> dict`.
    - `objective`: the overall task.
    - `state`: `(observation, goal, history) -> Any`, what System 1 sees.
    - `images`: None, or `(observation) -> list` of data URL strings
      next to `state` (vision-capable models; see `decide`).
    - `instructions`: System 1's question instructions.
    - `system1`: None for the configured decision model, or `(observation,
      actions, goal, history) -> action name or dict with "action"` to
      replace System 1 entirely.
    - `decide_timeout`: maximum seconds one decision round trip may take.
    - `tick`: minimum seconds per step (None runs as fast as decisions come).
    - `max_steps`: stop after this many steps (None runs until observe
      ends it).
    - `history_size`: recent actions shown to System 1.
    - `on_step`: `(record, observation)` after each step; returning "stop"
      ends the loop.
    - `on_error`: when System 1 fails, "stop", "skip", or `(error, observation)
      -> action name or None`.
    """

    def __init__(
        self,
        observe: Callable[[], Any],
        act: Callable[[str], Any],
        actions: dict[str, str] | Callable[[Any], dict[str, str]],
        *,
        objective: str,
        **settings: Any,
    ) -> None:
        self.observe = observe
        self.act = act
        self.actions = actions
        self.objective = objective
        self.state: Callable[..., Any] = _default_state
        self.images: Callable[[Any], list[str] | None] | None = None
        self.instructions = DEFAULT_INSTRUCTIONS
        self.system1: Callable[..., Any] | None = None
        self.decide_timeout: float = DECIDE_TIMEOUT
        self.tick: float | None = None
        self.max_steps: int | None = None
        self.history_size = 20
        self.on_step: Callable[..., Any] | None = None
        self.on_error: str | Callable[..., Any] = "stop"
        for name, value in settings.items():
            if not hasattr(self, name):
                raise TypeError(f"Loop has no setting {name!r}")
            setattr(self, name, value)
        self.history: list[dict[str, Any]] = []
        self.goal_updates: list[dict[str, Any]] = []
        self.errors: list[dict[str, Any]] = []
        self.error: str | None = None
        self.step = 0
        self._goal: str | None = None
        self._system1_model: str | None = None
        self._resume = asyncio.Event()
        self._resume.set()
        self._stopping = False
        self._task: asyncio.Task[None] | None = None

    @property
    def goal(self) -> str:
        return self.objective if self._goal is None else self._goal

    def set_goal(self, goal: str) -> None:
        """Update the goal that every later decision reads (System 2)."""
        if not isinstance(goal, str) or not goal.strip():
            raise TypeError("goal must be a non-empty string")
        self._goal = goal
        self.goal_updates.append({"step": self.step, "goal": goal})

    def start(self) -> "Loop":
        """Run the loop as a background task and return immediately."""
        if self._task is not None:
            raise RuntimeError("This loop was already started")
        self._task = asyncio.get_running_loop().create_task(self._run())
        return self

    def pause(self) -> None:
        self._resume.clear()

    def resume(self) -> None:
        self._resume.set()

    async def wait(self, timeout: float | None = None) -> dict[str, Any]:
        """Wait up to `timeout` seconds for the loop to end; return status."""
        if self._task is None:
            raise RuntimeError("Start the loop first")
        try:
            await asyncio.wait_for(asyncio.shield(self._task), timeout)
        except TimeoutError:
            pass
        except asyncio.CancelledError:
            if not self._task.cancelled():
                raise
        return self.status()

    async def stop(self) -> dict[str, Any]:
        """End the loop after the current step and return the status."""
        self._stopping = True
        self._resume.set()
        return await self.wait()

    async def run(self) -> dict[str, Any]:
        """Run to completion in the current cell."""
        return await self.start().wait()

    def status(self) -> dict[str, Any]:
        recent = self.history[-self.history_size :]
        latencies = [
            r["latency_ms"] for r in recent if r.get("latency_ms") is not None
        ]
        return {
            "running": self._task is not None and not self._task.done(),
            "paused": not self._resume.is_set(),
            "step": self.step,
            "objective": self.objective,
            "goal": self.goal,
            "system1_model": self._system1_model,
            "last": self.history[-1] if self.history else None,
            "mean_latency_ms": (
                round(sum(latencies) / len(latencies), 1)
                if latencies else None
            ),
            "errors": len(self.errors),
            "error": self.error,
        }

    def _record_error(self, where: str, error: BaseException) -> None:
        self.errors.append({
            "step": self.step, "where": where,
            "error": f"{type(error).__name__}: {error}",
        })
        del self.errors[:-_MAX_ERRORS]

    async def _run(self) -> None:
        try:
            while not self._stopping and (
                self.max_steps is None or self.step < self.max_steps
            ):
                await self._resume.wait()
                if self._stopping:
                    break
                started = time.perf_counter()
                if await self._step() == "stop":
                    break
                if self.tick is not None:
                    await asyncio.sleep(
                        max(0.0, self.tick - (time.perf_counter() - started))
                    )
                else:
                    # Sync callbacks must not starve the transport tasks.
                    await asyncio.sleep(0)
        except asyncio.CancelledError:
            self.error = "cancelled"
            raise
        except Exception as error:
            self.error = f"{type(error).__name__}: {error}"
        finally:
            self._stopping = True

    async def _step(self) -> str | None:
        observation = await _call(self.observe)
        if observation is None:
            return "stop"
        actions = (
            self.actions(observation)
            if callable(self.actions) else self.actions
        )
        history = self.history[-self.history_size :]
        try:
            if self.system1 is not None:
                started = time.perf_counter()
                choice = await _call(
                    self.system1, observation, actions, self.goal, history,
                )
                decision = (
                    dict(choice) if isinstance(choice, dict)
                    else {"action": choice}
                )
                decision.setdefault(
                    "latency_ms",
                    round((time.perf_counter() - started) * 1000, 1),
                )
            else:
                decision = await self._decide(observation, actions, history)
        except Exception as error:
            self._record_error("system1", error)
            if self.on_error == "stop":
                raise
            fallback = (
                None if self.on_error == "skip"
                else await _call(self.on_error, error, observation)
            )
            if fallback is None:
                self.step += 1
                return None
            decision = {
                "action": fallback, "confidence": None,
                "latency_ms": None, "fallback": True,
            }
        if decision.get("model"):
            self._system1_model = decision["model"]
        await _call(self.act, decision["action"])
        record = {
            "step": self.step,
            "action": decision["action"],
            "confidence": decision.get("confidence"),
            "latency_ms": decision.get("latency_ms"),
        }
        if "log_error" in decision:
            record["log_error"] = decision["log_error"]
        if decision.get("fallback"):
            record["fallback"] = True
        self.history.append(record)
        self.step += 1
        if self.on_step is not None:
            return await _call(self.on_step, record, observation)
        return None

    async def _decide(
        self, observation: Any, actions: dict[str, str],
        history: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """One decision through the host, with the latest goal in the state."""
        state = self.state(observation, self.goal, history)
        if isinstance(state, dict) and self.goal:
            state = {**state, "goal": self.goal}
        images = (
            None if self.images is None
            else await _call(self.images, observation)
        )
        return await asyncio.wait_for(
            _ask_system1(
                state, actions, instructions=self.instructions, images=images,
            ),
            self.decide_timeout,
        )
