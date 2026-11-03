# Sessions

Prime Agent saves conversations as sessions so you can continue work, branch from earlier turns, and revisit previous paths.

## Session Storage

Sessions auto-save to `~/.prime/agent/sessions/`. Each session is a JSONL file with a tree structure.

```bash
prime-agent --continue          # Continue the most recent session
prime-agent --resume [path|id|name] # Browse past sessions or resume one directly
prime-agent --no-session        # Ephemeral mode; do not save
prime-agent --fork <path|id|name>   # Fork a session file, partial session ID or name into a new session
```

Use `/session` in interactive mode to see the current session file, session ID, and message count. Use `/usage` for token, cost, and context usage.

For the JSONL file format and SessionManager API, see [Session Format](session-format.md).

## Log Rotation and Archived Evidence

After a successful compaction, a persisted active log above 32 * 1024 * 1024 bytes (32 MiB) can rotate under its runtime's exclusive writer lease. The session keeps its ID and active pathname. The new active segment keeps restart state, the compaction and its kept messages. The threshold is not a hard storage limit. A caller without a proven writer lease keeps normal compaction and reports that rotation was skipped.

Archive ownership belongs to a transcript named `<sessionId>.jsonl` or any name ending in `_<sessionId>.jsonl`, including legacy timestamp names and backup names. An imported copy with another filename keeps its ID and can read available evidence, but never rotates or cleans the owner's archives. A move of that copy with committed evidence refuses before writing; move the owning transcript instead. Import and move refuse a second owner-name transcript for the same ID in the destination. Replacing the existing destination pathname stays allowed.

When another owner-name transcript with the same ID remains in the folder, saved deletion keeps existing archives and reports a cleanup diagnostic. A move with committed or inherited evidence also refuses while another owner-name transcript remains in its source folder.

Sessions at explicit filenames that do not embed their UUID, such as `--resume ./work.jsonl` or an SDK-chosen name, compact normally but do not rotate. A rotation attempt prints a skip diagnostic.

Prior bytes stay in `archive/<sessionId>/<segment>.jsonl` beside the active log. Archives are read-only evidence, not sessions. The existing-segment check and publication rename are separate operations, so concurrent writers can still race. Open, resume, fork, metadata writes, leases, move and delete reject archive paths, including symlink aliases. Session pickers and `/tree` show active history only. Exact entry lookup and logical branch membership can still resolve committed archived entries without adding that text to model context.

The complete header stays below 64 KiB, including its newline, at every rotation, fork, move and rewrite. Cut edges, first-message preview and per-assistant accounting use versioned records directly after the header. Each record stays below 1 MiB. A count and SHA-256 witness commits the whole record prefix, including an explicit empty set. Full loaders reject missing or corrupt restart records before ordinary repair. Header-only selectors and fast metadata appends check the witness shape without loading archives.

Restart records never appear as messages, tree nodes or model context. Accounting uses its own projected ancestry, not archive reads. Exact active entry hits also need no archive access. Archived evidence lookups release parsed archive payloads when the operation ends; branch membership reuses ancestry for the same leaf and storage generation.

If a header or one indivisible restart row cannot fit, rotation or the segmented transformation refuses without dropping state. Retained state and path history can still grow. Custom non-UUID session IDs keep ordinary compaction and emit a rotation-skip diagnostic.

Navigation and fork targets whose archived ancestry has no covering compaction are refused. Their retained state stays stored for restart; Prime does not build an incomplete conversation from it.

JSONL import does not copy archives. Importing a transcript with committed archives or inherited evidence requires that evidence to be available from the destination. Otherwise, import refuses before writing files. Move the complete session with its evidence instead of importing only its active transcript.

Forking a rotated session copies only the parts that can still produce a full context, while keeping the selected branch. Uncovered off-branch entries and their descendants stay in the source but are omitted from the fork.

Labels keep their own tree position even when their target is archived or omitted. A label from an omitted position can be re-pointed under a kept target; otherwise it is omitted. Kept children of a dropped label pass through to its parent. Labels do not choose the fork's branch or cutoff.

A fork of segmented history records a source ID and fork-time boundary for older evidence. Later source messages are not inherited. Moving a segmented source moves its own archives and leaves a small `.relocated` record so existing forks can find it. Never-rotated, self-contained forks and moves add no cutoff or relocation metadata.

**Before confirming permanent saved-session deletion:** deletion removes the source's own archives and relocation records after its transcript is removed. Forks keep their own active entries, state and archives, but inherited archive-only reads fail with a missing-source error. Deletion does not cascade to forks or retain a hidden archive copy.

For sessions with committed evidence, deletion validates the archive folder and relocation records first. An unknown file refuses deletion and leaves the transcript intact. Recognizable dead-process temporary files and `.DS_Store` files can be removed. A later cleanup failure reports the remaining orphan path and still attempts artifact cleanup.

Saved deletion also attempts to remove recognizable archives and temporary files from an interrupted first rotation. If the session has no committed evidence, cleanup failures produce a diagnostic without changing the transcript delete result. If the transcript is already missing and its archive folder remains, a retry refuses and names the orphan folder for inspection.

Ordinary close, shutdown, update and child tombstoning retain archives; artifact-only child cleanup removes runtime caches, not evidence.

Do not downgrade an older build onto rotated sessions. It does not understand segmented history. Stop writers, preserve all segments and have the operator reconstruct and verify a complete transcript before changing builds. Never replace a newer active segment with an old archive.

## Session Commands

| Command | Description |
|---------|-------------|
| `/resume` | Browse and select previous sessions |
| `/new` | Start a new session |
| `/name <name>` | Set the current session display name |
| `/session` | Show session info |
| `/usage` | Show token, cost, and context usage |
| `/tree` | Navigate the current session tree |
| `/fork` | Create a new session from a previous user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact [prompt]` | Summarize older context; see [Compaction](compaction.md) |
| `/export [file]` | Export session to HTML |
| `/share` | Upload as private GitHub gist with shareable HTML link |

## Resuming and Deleting Sessions

`/resume` opens an interactive session picker for the current project. `prime-agent --resume` opens the same picker at startup, and `prime-agent --resume <path|id|name>` resumes a specific session.

An invalid ID exits with the closest unambiguous session ID when one is available. To open the picker and send an initial prompt after selecting a session, separate the prompt with `--`: `prime-agent --resume -- "continue this work"`.

In the picker you can:

- search by typing
- toggle path display with Ctrl+P
- toggle sort mode with Ctrl+S
- filter to named sessions with Ctrl+N
- rename with Ctrl+R
- delete with Ctrl+D, then confirm

When available, Prime Agent uses the `trash` CLI for transcript deletion. For a segmented session, its archives and relocation records are permanently removed even when the transcript goes to Trash. Restoring that transcript alone does not restore its archived evidence.

## Naming Sessions

Use `/name <name>` to set a human-readable session name:

```text
/name Refactor auth module
```

Named sessions are easier to find in `/resume` and `prime-agent --resume`. You can also resume or fork a session by its exact name, for example `prime-agent --resume "Refactor auth module"`. If two saved sessions share a name, use the session ID instead.

## Branching with `/tree`

Sessions are stored as trees. Every entry has an `id` and `parentId`, and the current position is the active leaf. `/tree` lets you jump to any previous point and continue from there without creating a new file.

<p align="center"><img src="images/tree-view.png" alt="Tree View" width="600"></p>

Example shape:

```text
├─ user: "Hello, can you help..."
│  └─ assistant: "Of course! I can..."
│     ├─ user: "Let's try approach A..."
│     │  └─ assistant: "For approach A..."
│     │     └─ user: "That worked..."  ← active
│     └─ user: "Actually, approach B..."
│        └─ assistant: "For approach B..."
```

### Tree Controls

| Key | Action |
|-----|--------|
| ↑/↓ | Navigate visible entries |
| ←/→ | Page up/down |
| Ctrl+←/Ctrl+→ or Alt+←/Alt+→ | Fold/unfold or jump between branch segments |
| Shift+L | Set or clear a label on the selected entry |
| Shift+T | Toggle label timestamps |
| Enter | Select entry |
| Escape/Ctrl+C | Cancel |
| Ctrl+O | Cycle filter mode |

Filter modes are: default, no-tools, user-only, labeled-only, and all. Configure the default with `treeFilterMode` in [Settings](settings.md).

### Selection Behavior

Selecting a user or custom message:

1. Moves the leaf to the selected message's parent.
2. Places the selected message text in the editor.
3. Lets you edit and resubmit, creating a new branch.

Selecting an assistant, tool, compaction, or other non-user entry:

1. Moves the leaf to that entry.
2. Leaves the editor empty.
3. Lets you continue from that point.

Selecting the root user message resets the leaf to an empty conversation and places the original prompt in the editor.

## `/tree`, `/fork`, and `/clone`

| Feature | `/tree` | `/fork` | `/clone` |
|---------|---------|---------|----------|
| Output | Same session file | New session file | New session file |
| View | Full tree | User-message selector | Current active branch |
| Typical use | Explore alternatives in place | Start a new session from an earlier prompt | Duplicate current work before continuing |
| Summary | Optional branch summary | None | None |

Use `/tree` when you want to keep alternatives together. Use `/fork` or `/clone` when you want a separate session file.

## Branch Summaries

When `/tree` switches away from one branch to another, Prime Agent can summarize the abandoned branch and attach that summary at the new position. This preserves important context from the path you left without replaying the whole branch.

When prompted, choose one of:

1. no summary
2. summarize with the default prompt
3. summarize with custom focus instructions

See [Compaction](compaction.md) for branch summarization internals and extension hooks.

## Session Format

Session files are JSONL and contain message entries, model changes, thinking-level changes, labels, compactions, branch summaries, and extension entries.

For parsers, extensions, SDK usage, and the full SessionManager API, see [Session Format](session-format.md).
