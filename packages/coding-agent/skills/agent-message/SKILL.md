---
name: agent-message
description: Message family members by role, or any local-space agent by session name or ID when Cotal messaging is enabled. Sender identity comes from the daemon.
---

# Agent Message

Send direct messages within the current agent's nuclear family through the
local daemon: parent, siblings, and direct children. Roots are siblings.
With Cotal messaging enabled, omit `receiver_role` to address any session in the
local space by name or session ID. The daemon derives your sender identity from
the current session; do not try to include a `from` field.

Call directly from the kernel:

```python
children = await rlm.list_subagents()
child = next((item for item in children if item.active_session_id), None)
if child is not None:
    receipt = await agent_message.send(
        "Please inspect the latest result.",
        receiver_role="child",
        receiver_name=child.session_name,
    )
    # Keep the child until this follow-up finishes so its result remains observable.
```

## API

- `await agent_observe.list_agents()` (agent-observe skill) is the roster: it
  lists the parent, siblings, and children this skill can reach, active or not,
  with the `relationship` and `sessionName` that `send` takes as
  `receiver_role` and `receiver_name`.
- `await agent_message.send(message, receiver_role="parent" | "sibling" | "child", receiver_name=None, can_wait=None, reply_to=None)` — sends one direct
  text message to one family member. Sending to an inactive or idle completed
  subagent wakes it and starts an ordinary follow-up turn in that same session
  and context.
  The child remains available only until its parent session closes. The daemon
  resolves `receiver_role` within the current agent family; `receiver_name` is
  required for siblings and children and omitted for the unique parent.
  `send("all", message)` broadcasts only to the family roster and returns
  `{receipts: [...]}` in roster order; successful entries are ordinary receipts
  and failed entries contain the target id and a short `error`. One failed delivery
  does not reject successful deliveries. Unmarked messages use steering delivery.
  Returns a receipt with a
  `deliveryStatus` field: `"delivered"` means the message reached an idle target's
  context; `"queued"` means a steering message was accepted and will deliver when
  the target's current work allows (`send` does not block waiting for that).
  Delivered receipts carry `deliveredAt`, queued receipts carry `queuedAt`.
- `await agent_message.send(message, receiver_name="name-or-session-id")` —
  with Cotal enabled, sends to any enrolled session in the local space. An exact
  session ID wins; otherwise one case-insensitive name match is required.
  Ambiguous names list the candidates. Unknown names and unsupported spaces fail
  before storage. The whole selector is tried as a local ID or name first,
  including names containing `/`. If no local match exists,
  `"space/name-or-session-id"` qualifies the space; only the local space works.
- On Cotal, every successful send returns `deliveryStatus: "stored"`, `sequence`
  and `cotalId`. This proves broker storage, not delivery to the target. It carries
  neither `deliveredAt` nor `queuedAt`. A storage-outcome-unknown error must not be
  retried automatically: a resend can show the message twice.

## Wait-safe messages and replies

- Before setting `can_wait=True`, ask: "Will someone stop, wait or come to harm
  until the recipient reads this?" Set it only when the answer is no. If uncertain,
  omit it. A message that needs no reply is not necessarily safe to delay.
- Never mark stop/cancel, relayed user instructions, a reply someone awaits,
  a request that starts work, a blocker or conflict, or a harmful time limit.
- On supported Cotal receivers, a marked message waits outside the active run.
  It starts a follow-up run when idle, without another prompt. After a user stop,
  a held message waits until the user or another input resumes the session.
  Steers and replies pass held messages. Sustained steering can delay follow-ups
  indefinitely.
- Set `reply_to` to the canonical received message ID shown in the message header,
  or to a receipt's `id` or `cotalId`. A linked reply always steers, even when marked.
  Direct parent-child messages also always steer, for each broadcast target.
- Native delivery and older receivers keep steering. A native receipt, or a Cotal
  receipt while the daemon's `agentMessageCanWait` setting is off, may report
  `schedulingFallback: "steer"`. An old Cotal receiver may show a cosmetic
  `[prime-agent-message v1 can_wait=true]` line. Do not copy that line into a body
  to select delivery; only the typed argument marks a message.
- FIFO follows the current arrival/admission queue. A broker or consumer crash
  can change redelivery order; original publication order is not guaranteed.
- Deleting a recipient drops held messages without notifying the sender.
  A `stored` receipt proves broker storage, not recipient delivery.
- A stop note records a user stop of active work. Do not restart work the user stopped
  because a later agent message or FYI arrives. Delivery grants no work authority.

## Safety

- Do not delete a child immediately after `send`: delivered follow-ups may still
  be running and queued receipts have not run yet. Wait until observation shows
  the child is idle and its context is no longer needed before calling
  `await rlm.delete_subagent(child)`.
- Role shortcuts and `"all"` remain limited to parent, siblings, and direct
  children. Name-only addressing reaches any local-space session on Cotal.
  Name-only sends require `agentMessageTransport: "cotal"`. With native messaging,
  send by family role.
- The `agent_message` API derives sender identity in the daemon. With Cotal, any
  same-OS-user process that can read the mesh files can act as the mesh signer.
  See "Mesh Agent Messaging" in the Prime Agent docs (`docs/daemon.md`).
- The daemon enforces message size, rate, and pending-queue limits before
  accepting delivery.
