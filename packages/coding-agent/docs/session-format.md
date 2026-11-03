# Session File Format

Sessions are stored as JSONL (JSON Lines) files. Each line is a JSON object with a `type` field. Session entries form a tree structure via `id`/`parentId` fields, enabling in-place branching without creating new files.

## File Location

```
~/.prime/agent/sessions/<session-id>.jsonl
```

The header records the working directory. Current releases keep sessions in a flat directory; older per-project directories are migrated automatically.

## Deleting Sessions

Use saved-session deletion to remove a transcript and its owned archives. Deleting only the `.jsonl` file by hand does not clean up archived evidence.

Prime Agent also supports deleting sessions interactively from `/resume` (select a session and press `Ctrl+D`, then confirm). When available, Prime Agent sends the transcript to the `trash` CLI. Its archives and relocation records are removed permanently. Restoring the transcript alone does not restore inherited evidence for forks.

## Session Version

Sessions have a version field in the header:

- **Version 1**: Linear entry sequence (legacy, auto-migrated on load)
- **Version 2**: Tree structure with `id`/`parentId` linking
- **Version 3**: Renamed `hookMessage` role to `custom` (extensions unification)

Existing sessions are automatically migrated to the current version (v3) when loaded.

## Source Files

- [`session-manager.ts`](../src/core/session-manager.ts) - Session entry types and `SessionManager`
- [`messages.ts`](../src/core/messages.ts) - Extended message types (`BashExecutionMessage`, `CustomMessage`, and others)
- [`packages/ai/src/types.ts`](../../ai/src/types.ts) - Base message types (`UserMessage`, `AssistantMessage`, `ToolResultMessage`)
- [`packages/agent/src/types.ts`](../../agent/src/types.ts) - `AgentMessage` union type

For TypeScript definitions in your project, inspect `node_modules/@earendil-works/pi-coding-agent/dist/` and `node_modules/@earendil-works/pi-ai/dist/`.

## Message Types

Session entries contain `AgentMessage` objects. Understanding these types is essential for parsing sessions and writing extensions.

### Content Blocks

Messages contain arrays of typed content blocks:

```typescript
interface TextContent {
  type: "text";
  text: string;
}

interface ImageContent {
  type: "image";
  data: string;      // base64 encoded
  mimeType: string;  // e.g., "image/jpeg", "image/png"
}

interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, any>;
}
```

### Base Message Types (from Prime Agent AI)

```typescript
interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;  // Unix ms
}

interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: string;
  provider: string;
  model: string;
  usage: Usage;
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
}

interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: any;      // Tool-specific metadata
  isError: boolean;
  timestamp: number;
}

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}
```

### Extended Message Types (from Prime Agent Coding Agent)

```typescript
interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;  // true for !! prefix commands
  timestamp: number;
}

interface CustomMessage {
  role: "custom";
  customType: string;            // Extension identifier
  content: string | (TextContent | ImageContent)[];
  display: boolean;              // Show in TUI
  details?: any;                 // Extension-specific metadata
  timestamp: number;
}

interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string;                // Entry we branched from
  timestamp: number;
}

interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}
```

### AgentMessage Union

```typescript
type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage;
```

## Entry Base

All ordinary entries extend `SessionEntryBase`. The session header and storage-only restart records are not tree entries:

```typescript
interface SessionEntryBase {
  type: string;
  id: string;           // Usually short hex; full UUID fallback/closed append, or s<n>- prefixed after rotation
  parentId: string | null;  // Parent entry ID (null for first entry)
  timestamp: string;    // ISO timestamp
}
```

## Entry Types

### SessionHeader

First line of the file. Its `id` identifies the session, not a tree entry. It has no `parentId`.

```json
{"type":"session","version":3,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project"}
```

For sessions with a parent (created via `/fork`, `/clone`, or `newSession({ parentSession })`):

```json
{"type":"session","version":3,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project","parentSession":"/path/to/original/session.jsonl"}
```

### Segmented Headers and Restart Records

Rotation keeps the active pathname and session ID. Old bytes live at `archive/<sessionId>/<segment>.jsonl` beside the active transcript. Archives are immutable evidence. Openers, writers, leases and scanners refuse or omit archive paths and symlink aliases. They are not sessions to resume or navigate.

A segmented header adds `rotation`:

```typescript
interface SessionRotation {
  version: 1;
  segment: number; // Nonnegative current segment; an unrotated header has no rotation field
  archives: { segment: number; bytes: number; sha256: string }[];
  restart: { version: 1; count: number; sha256: string };
  compactionId?: string;
  parent?: { sessionId: string; leafId: string; segment: number };
  accounting: { messageCount: number; lastActivityTime?: number; usage: Usage };
}
```

`accounting.messageCount`, `accounting.lastActivityTime` and `accounting.usage` describe snapshot-time values. `accounting.usage` is not a live total: later child attribution does not rewrite it. Usage readers apply retained attribution entries to the per-assistant records instead.

The header contains no per-entry maps or assistant arrays. Its complete UTF-8 line, including LF, must stay below 64 * 1024 bytes. Rotation, both fork serializers, move/recovery and rewrites enforce this before publication. Oversize refusal keeps the authoritative source and does not raise reader limits.

The next `restart.count` physical lines use this storage-only envelope:

```typescript
interface RotationStateRecord {
  type: "rotation_state";
  version: 1;
  segment: number;
  index: number;
  kind: "cut_edges" | "accounting" | "preview";
  data: unknown;
}
```

Records have no `id` or `parentId`. Their segment matches the header, and indices run from zero in physical order. Every serialized record line, including LF, stays below 1024 * 1024 UTF-8 bytes. Arrays split between rows, never within a row.

- `cut_edges` contains `[entryId, originalParentId]` pairs only where the retained parent link changed.
- `accounting` contains assistant rows with a stripped `entry` and an `accountingParentId`, the nearest assistant ancestor or null. Bridge rows map a cut target ID to its nearest assistant ancestor. Bridges have no usage and do not count as messages. Accounting ancestry is separate from original entry ancestry and never authorizes evidence access.
- `preview` contains the first-message preview. There is at most one preview record.

`restart.sha256` hashes the exact next `count` UTF-8 record lines with their LF bytes. A zero count uses SHA-256 of the empty byte sequence. Full sync/async/public loaders validate the complete prefix before tolerant ordinary-line parsing or repair. Missing, duplicate, malformed, conflicting or misplaced storage records fail closed. Header-only discovery, selection, deletion, move preflight and fast metadata append validate witness shape without demanding payload rows or archives. Full-open fallback validates the whole prefix.

Storage rows are excluded from public parsing results, `getEntries`, both tree views, branch/leaf/index candidates, trace entry counts and model context. Catalog and disk usage readers consume complete accounting once. Raw move, fork and rewrite paths preserve the prefix or regenerate matching rows and witness when they transform it.

A fork of segmented history records a source ID and leaf cutoff in `rotation.parent`. Its `s<n>-` namespace stays above the recorded inherited range. Existing entry IDs do not change. Exact reads can follow the bounded source lineage, but later source entries are not inherited. A never-rotated, self-contained fork adds neither cutoff metadata nor restart records.

A segmented source move records canonical old active paths in optional `previousSessionPaths` and publishes `<oldActivePath>.relocated` records through its existing move journal. These are not sessions. Archives keep their exact bytes.

Permanent source deletion removes owned archives and redirects. Forks retain active reads, appends and active-ID branch membership; inherited archive-only reads fail visibly.

An inherited-only fork (no own archives) can branch again without reading its deleted source, copying active payload and retaining its recorded parent, segment and parentSession. If a fork owns archives and its upstream source is gone, branching it may fail with `Parent session evidence is unavailable` before any write. A missing own committed archive is storage corruption: non-active membership and forking can fail with the actionable archive error. Ordinary close, update and artifact-only child cleanup retain evidence.

Older builds do not understand this format. Do not downgrade onto segmented sessions. Preserve all segments and reconstruct and verify a complete transcript before an approved rollback. State, lineage and path-history growth can eventually force a safe refusal instead of useful shrinkage.

### SessionMessageEntry

A message in the conversation. The `message` field contains an `AgentMessage`.

```json
{"type":"message","id":"a1b2c3d4","parentId":"prev1234","timestamp":"2024-12-03T14:00:01.000Z","message":{"role":"user","content":"Hello"}}
{"type":"message","id":"b2c3d4e5","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}],"provider":"anthropic","model":"claude-sonnet-4-5","usage":{...},"stopReason":"stop"}}
{"type":"message","id":"c3d4e5f6","parentId":"b2c3d4e5","timestamp":"2024-12-03T14:00:03.000Z","message":{"role":"toolResult","toolCallId":"call_123","toolName":"bash","content":[{"type":"text","text":"output"}],"isError":false}}
```

### ModelChangeEntry

Emitted when the user switches models mid-session.

```json
{"type":"model_change","id":"d4e5f6g7","parentId":"c3d4e5f6","timestamp":"2024-12-03T14:05:00.000Z","provider":"openai","modelId":"gpt-4o"}
```

### ThinkingLevelChangeEntry

Emitted when the user changes the thinking/reasoning level.

```json
{"type":"thinking_level_change","id":"e5f6g7h8","parentId":"d4e5f6g7","timestamp":"2024-12-03T14:06:00.000Z","thinkingLevel":"high"}
```

### ServiceTierChangeEntry

Emitted when the user changes provider service tier.

```json
{"type":"service_tier_change","id":"e6f7g8h9","parentId":"e5f6g7h8","timestamp":"2024-12-03T14:07:00.000Z","serviceTier":"priority"}
```

### CompactionEntry

Created when context is compacted. Stores a summary of earlier messages.

```json
{"type":"compaction","id":"f6g7h8i9","parentId":"e5f6g7h8","timestamp":"2024-12-03T14:10:00.000Z","summary":"User discussed X, Y, Z...","firstKeptEntryId":"c3d4e5f6","tokensBefore":50000}
```

Optional fields:
- `details`: Implementation-specific data (e.g., `{ readFiles: string[], modifiedFiles: string[] }` for default, or custom data for extensions)
- `fromHook`: `true` if generated by an extension, `false`/`undefined` if generated by Prime Agent (legacy field name)

### BranchSummaryEntry

Created when switching branches via `/tree` with an LLM generated summary of the left branch up to the common ancestor. Captures context from the abandoned path.

```json
{"type":"branch_summary","id":"g7h8i9j0","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:15:00.000Z","fromId":"f6g7h8i9","summary":"Branch explored approach A..."}
```

Optional fields:
- `details`: File tracking data (`{ readFiles: string[], modifiedFiles: string[] }`) for default, or custom data for extensions
- `fromHook`: `true` if generated by an extension, `false`/`undefined` if generated by Prime Agent (legacy field name)

### CustomEntry

Extension state persistence. Does NOT participate in LLM context.

```json
{"type":"custom","id":"h8i9j0k1","parentId":"g7h8i9j0","timestamp":"2024-12-03T14:20:00.000Z","customType":"my-extension","data":{"count":42}}
```

Use `customType` to identify your extension's entries on reload.

### Codemode Store

Completed codemode scripts persist branch-local JSON values as custom entries. Failed scripts append no writes.

```json
{"type":"custom","customType":"codemode-store","data":{"set":{"k":1},"delete":["old"]},"id":"a1b2c3d4","parentId":"previous","timestamp":"2026-10-09T12:00:00.000Z"}
```

Fold these entries from root to leaf on the current branch. Older readers ignore them in model context. See [codemode.md](codemode.md) for the port protocol.

### ChildUsageAttributionEntry

Records RLM child usage folded into a parent assistant message. This entry is daemon bookkeeping and does not enter model context.

```typescript
interface ChildUsageAttributionEntry extends SessionEntryBase {
  type: "child_usage_attributed";
  targetId: string;       // Parent assistant message entry
  childUsage: Usage;      // Usage added by one child
  aggregateUsage: Usage;  // Updated parent aggregate
}
```

Reload applies `aggregateUsage` to the target assistant message. Context-tree accounting can then subtract `childUsage` when reporting the parent node's own usage.

### CustomMessageEntry

Extension-injected messages that DO participate in LLM context.

```json
{"type":"custom_message","id":"i9j0k1l2","parentId":"h8i9j0k1","timestamp":"2024-12-03T14:25:00.000Z","customType":"my-extension","content":"Injected context...","display":true}
```

Fields:
- `content`: String or `(TextContent | ImageContent)[]` (same as UserMessage)
- `display`: `true` = show in TUI with distinct styling, `false` = hidden
- `details`: Optional extension-specific metadata (not sent to LLM)

### LabelEntry

User-defined bookmark/marker on an entry.

```json
{"type":"label","id":"j0k1l2m3","parentId":"i9j0k1l2","timestamp":"2024-12-03T14:30:00.000Z","targetId":"a1b2c3d4","label":"checkpoint-1"}
```

Set `label` to `undefined` to clear a label.

### SessionInfoEntry

Session metadata (e.g., user-defined display name). Set via `/name` command or `pi.setSessionName()` in extensions.

```json
{"type":"session_info","id":"k1l2m3n4","parentId":"j0k1l2m3","timestamp":"2024-12-03T14:35:00.000Z","name":"Refactor auth module"}
```

The session name is displayed in the session selector (`/resume`) instead of the first message when set.

### SessionStateEntry

Stores daemon-managed lifecycle state. Current persisted states are `active`, `archived`, and legacy `crash`; older `sleep` values normalize to `archived` when read.

### AgentStatusEntry

Stores the latest short agent status shown in the agents view, including its summary, optional task state, and source message count. It does not enter model context.

### GitStateEntry

Stores an append-only repository-state snapshot for agent status and recovery views. It does not enter model context.

## Tree Structure

Entries form a tree:
- First entry has `parentId: null`
- Each subsequent entry points to its parent via `parentId`
- Branching creates new children from an earlier entry
- The "leaf" is the current position in the tree

```
[user msg] ─── [assistant] ─── [user msg] ─── [assistant] ─┬─ [user msg] ← current leaf
                                                            │
                                                            └─ [branch_summary] ─── [user msg] ← alternate branch
```

## Context Building

`buildSessionContext()` walks from the current leaf to the root, producing the message list for the LLM:

1. Collects all entries on the path
2. Extracts current model and thinking level settings
3. If a `CompactionEntry` is on the path:
   - Emits the summary first
   - Then messages from `firstKeptEntryId` to compaction
   - Then messages after compaction
4. Converts `BranchSummaryEntry` and `CustomMessageEntry` to appropriate message formats

Bookkeeping entries such as child usage attribution, session lifecycle, agent status, and git state are ignored when building model context.

## Parsing Example

```typescript
import { readFileSync } from "fs";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";

// Validates a segmented restart prefix and excludes storage-only records.
for (const entry of parseSessionEntries(readFileSync("session.jsonl", "utf8"))) {

  switch (entry.type) {
    case "session":
      console.log(`Session v${entry.version ?? 1}: ${entry.id}`);
      break;
    case "message":
      console.log(`[${entry.id}] ${entry.message.role}: ${JSON.stringify(entry.message.content)}`);
      break;
    case "compaction":
      console.log(`[${entry.id}] Compaction: ${entry.tokensBefore} tokens summarized`);
      break;
    case "branch_summary":
      console.log(`[${entry.id}] Branch from ${entry.fromId}`);
      break;
    case "custom":
      console.log(`[${entry.id}] Custom (${entry.customType}): ${JSON.stringify(entry.data)}`);
      break;
    case "custom_message":
      console.log(`[${entry.id}] Extension message (${entry.customType}): ${entry.content}`);
      break;
    case "label":
      console.log(`[${entry.id}] Label "${entry.label}" on ${entry.targetId}`);
      break;
    case "model_change":
      console.log(`[${entry.id}] Model: ${entry.provider}/${entry.modelId}`);
      break;
    case "thinking_level_change":
      console.log(`[${entry.id}] Thinking: ${entry.thinkingLevel}`);
      break;
  }
}
```

## SessionManager API

Key methods for working with sessions programmatically.

### Static Creation Methods
- `SessionManager.create(cwd, sessionDir?)` - New session
- `SessionManager.open(path, sessionDir?)` - Open existing session file
- `SessionManager.continueRecent(cwd, sessionDir?)` - Continue most recent or create new
- `SessionManager.inMemory(cwd?)` - No file persistence
- `SessionManager.forkFrom(sourcePath, targetCwd, sessionDir?)` - Fork session from another project

### Static Listing Methods
- `SessionManager.list(cwd, sessionDir?, callbacks?)` - List sessions for a directory
- `SessionManager.listAll(callbacks?, sessionDir?)` - List all sessions across all projects

`callbacks` can provide `onProgress(loaded, total)` and `onSession(session)` handlers.

### Instance Methods - Session Management
- `newSession(options?)` - Start a new session (options: `{ parentSession?: string }`)
- `setSessionFile(path)` - Switch to a different session file
- `createBranchedSession(leafId)` - Extract branch to new session file

### Instance Methods - Appending (all return entry ID)
- `appendMessage(message)` - Add message
- `appendThinkingLevelChange(level)` - Record thinking change
- `appendServiceTierChange(tier)` - Record provider service-tier change
- `appendModelChange(provider, modelId)` - Record model change
- `appendCompaction(summary, firstKeptEntryId, tokensBefore, details?, fromHook?, customInstructions?)` - Add compaction
- `appendCustomEntry(customType, data?)` - Extension state (not in context)
- `appendChildUsageAttribution(targetId, childUsage, aggregateUsage)` - Persist RLM child usage folded into a parent assistant message
- `appendSessionInfo(name)` - Set session display name
- `appendSessionState(state)` - Record daemon-managed lifecycle state
- `appendAgentStatus(status)` - Record an agents-view status summary
- `appendGitState(git)` - Record repository state
- `appendCustomMessageEntry(customType, content, display, details?)` - Extension message (in context)
- `appendLabelChange(targetId, label)` - Set/clear label

### Instance Methods - Tree Navigation
- `getLeafId()` - Current position
- `getLeafEntry()` - Get current leaf entry
- `getEntry(id)` - Exact active entry first, then committed archives and bounded parent evidence. An active hit performs no archive I/O.
- `isEntryOnBranch(id)` - Read-only logical branch membership through original archived ancestry. Check it before admitting an archived exact read. False or an error never authorizes a weaker fallback.
- `getBranch(fromId?)` - Active-segment ancestry only; archived IDs are not navigation targets
- `getTree()` - Active-segment tree only
- `getChildren(parentId)` - Get direct children
- `getLabel(id)` - Get label for entry
- `branch(entryId)` - Move leaf to earlier entry
- `resetLeaf()` - Reset leaf to null (before any entries)
- `branchWithSummary(entryId, summary, details?, fromHook?)` - Branch with context summary

### Instance Methods - Context & Info
- `buildSessionContext()` - Get messages, thinkingLevel, and model for LLM
- `getEntries()` - Active ordinary entries only, excluding the header and storage-only records
- `getHeader()` - Session header metadata
- `getSessionName()` - Get display name from latest session_info entry
- `getCwd()` - Working directory
- `getSessionDir()` - Session storage directory
- `getSessionId()` - Session UUID
- `getSessionFile()` - Session file path (undefined for in-memory)
- `isPersisted()` - Whether session is saved to disk
