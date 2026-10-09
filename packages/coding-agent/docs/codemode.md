# Codemode

`codemode` runs JavaScript that calls the session's active tools. Only the script's output reaches the model.

```text
model -> codemode {code} -> fresh QuickJS worker
                            tools.name(args)
                                   |
                     host argument checks and before/after hooks
                                   |
                     tool text -> script -> output and calls
```

## Use

JavaScript only. The code is an async function body, so top-level `await` and `return` work.

```js
const reply = await tools.ipython({code: "print(6*7)"});
text(reply);
store("lastAnswer", 42);
```

The tool is active by default with `ipython`. Set `"codemode": false` in global or project settings to remove it from defaults. Set `"codemodeExcludeTools": ["name", ...]` to keep named tools out of scripts: they are absent from `ALL_TOOLS` and `describeTool()`, and calling them fails as an unknown tool. Use it for tools that need their own turn or a guarded, visible action.
An explicit CLI `--tools` or SDK tool list decides alone. For example, `--tools ipython` excludes it.
Use `Promise.allSettled` for independent calls. Sequential tools, including `ipython`, share one queue per script.
Python skills and MCP servers remain available through `ipython`, not as direct script tools.

## Exact model-visible definition

Name: `codemode`. Schema:

<!-- schema:start -->
```json
{
  "type": "object",
  "properties": {
    "code": {
      "description": "Raw JavaScript source.",
      "type": "string"
    }
  },
  "required": [
    "code"
  ]
}
```
<!-- schema:end -->

Description (exact text):

<!-- description:start -->
Run JavaScript that calls other tools. Pass {code: "..."} with raw JavaScript as the body of an async function; top-level await and return work. No Node, file system, network, process, or timers.
- Use codemode only to call several typed tools that ipython cannot reach, such as beads, pr_inspect or ask_jev, in parallel or in a chain, when only a filtered result should reach the context. For one call, call the tool directly. For files, shell, Python skills, MCP servers or state that must last between calls, use ipython; do not wrap tools.ipython in codemode only to run Python.
- Every other tool you can call is also tools.<name>(args), with the same arguments. It returns its text joined with newlines, or rejects with an Error carrying the tool's error text. Only active tools are callable; codemode cannot call itself, and tools named in the codemodeExcludeTools setting are not callable. Use tools["my-tool"] or tools.my_tool for non-identifier names.
- Use Promise.allSettled for independent calls, chain calls, or filter large results. Sequential tools such as ipython run one at a time. Calls still running or queued when the script ends are cancelled; completed effects are not undone.
- text(value), console.log/info/warn/error/debug(...), and return add output in order. image(dataUrlOrImageBlock) adds a PNG, JPEG, GIF, or WebP image; remote URLs are rejected. exit() completes immediately and keeps output and store writes.
- store(key, value) and load(key) keep JSON values on the current session branch. store(key, undefined) deletes a key; missing keys load as undefined. Only completed scripts persist writes.
- ALL_TOOLS lists names and TypeScript declarations. await describeTool(name) returns a declaration. Python skills and MCP servers stay reachable through ipython, not as direct tools.
- Optional first line: // @options: {"max_output_tokens": 10000, "timeout_ms": 60000}. max_output_tokens is a non-negative safe integer (default 10000, 4 characters per token); timeout_ms is an integer from 1 to 2147483647 (default none). Unknown fields are rejected.
- The budget applies only to user text; over budget it keeps the head and tail and spills the full text to a temp file. Failure keeps partial output and a list of calls already made. Each run is fresh, with a 256 MiB guest heap, 16777216 output characters, 100000 output items, 262144 JSON characters per store value, and 1048576 total store characters (keys plus values). These do not bound host process memory or tool results.
<!-- description:end -->

## Script semantics and limits

- Each run has a fresh sandbox. It exposes `tools`, `text`, `console.log/info/warn/error/debug`, `image`, `exit`, `store`, `load`, `ALL_TOOLS`, and `describeTool`.
- There is no file system, network, process, timer, `models`, or `searchTools` API. `eval` and `Function` only run inside the same VM.
- A name absent from `ALL_TOOLS` (unknown, inactive, or `codemode`) throws a synchronous `TypeError` at member access, before any call starts. No tool runs. `Promise.allSettled` cannot catch this throw while its input array is being built.
- `tools.name(args)` takes the direct tool's arguments after a JSON round trip. Results resolve to joined text. Failed calls reject with an `Error` carrying the tool's error text.
- Non-identifier names support both `tools["my-tool"]` and `tools.my_tool`. `ALL_TOOLS` lists identifier names and declarations from `pi-codemode/declarations`. `await describeTool(name)` returns the same declaration, or `undefined` for a missing name.
- An optional first line is `// @options: {"max_output_tokens": 10000, "timeout_ms": 60000}`. Invalid JSON, unknown fields, empty source, and an options line without code fail before execution.
- `timeout_ms` is an integer from 1 to 2,147,483,647. Its default is no deadline, implemented with `Number.POSITIVE_INFINITY`, not the package's 300,000 ms default. The timeout also stops CPU loops.
- `max_output_tokens` is a non-negative safe integer, default 10000. Four characters estimate one token. The budget covers joined user text only, not the header or failure block.
- Item 1 is `Script completed` or `Script failed`, then `Wall time <s> seconds` and `Output:`. `text()`, `console.*`, and `return` text stays in output order, joined with newlines. Images follow the text.
- Over budget, user text keeps the first half and last half of the character budget. With zero, only the truncation notice remains. The full user text goes to a temp file. The notice names `[Full output: <path>]`, and `details.fullOutputPath` holds it.
- If spilling fails, no path is advertised. The notice says `[Could not save the full output: <error>]`. The output and failure block remain.
- A failed script has `isError: true`. Its final text item starts `Script error:` and includes the error, then `Calls already made (not undone):` and one name/status line per call. The header and this block are never truncated.
- `image()` accepts a base64 `data:` URL, `{image_url}`, or an MCP block `{type:"image",data,mimeType}` for PNG, JPEG, GIF, and WebP. Remote `http(s)` URLs are rejected. Images become image content and are not saved to files.
- `exit()` completes immediately, keeping output and store writes. `store(key, undefined)` deletes a key. Missing keys load as `undefined`. Loaded values are copies.
- The guest heap is 256 MiB. This does not bound process memory, tool results, host call records, or queued calls. The sandbox is a capability boundary in the same OS process, not an OS security boundary.
- Script output is at most 16,777,216 characters (text plus base64 image data) and 100,000 output items. Store values are at most 262,144 JSON characters each. Store keys plus serialized values total at most 1,048,576 characters.

Differences from pi's adapter at `6fb2e781`: only active tools are callable; there is no tool-search/loadout/model API; all nested results are text; output keeps console order; failure text is outside the budget; images are not saved; the fork retains aborted partial results for up to 5000 ms.

pi-codemode 1.1.0's unknown-tool error text mentions `searchTools(query)`. This fork does not provide that API.

## Language-neutral host protocol

These JSON examples describe observable tool calls and results, not a new daemon wire protocol.
Rust uses the same checks and `before_tool_call`/`after_tool_call` hooks for every nested call.
An adapter must never call a tool's executor directly. Resolve tools against the active set excluding `codemode`.
Before hooks can block execution. After hooks can change text and error status before the script receives it.
Nested results do not become model messages or separate session message entries.

Call:

```json
{"name":"codemode","id":"outer","arguments":{"code":"text(await tools.echo({value:42}));"}}
```

The checked nested call is `{"name":"echo","id":"outer/1","arguments":{"value":42}}`.
Its successful text reply resolves to `"42"`. The script result is:

```json
{"content":[{"type":"text","text":"Script completed\nWall time 0.1 seconds\nOutput:\n"},{"type":"text","text":"42"}],"details":{"calls":[{"id":"outer/1","name":"echo","args":"{\"value\":42}","status":"ok","durationMs":12}]},"isError":false}
```

Call records hold `id`, `name`, compact JSON `args` cut to 200 characters, `status`, `durationMs`, and optional `error` cut to 500.
Status is `running` during updates, then `ok`, `error`, or `cancelled`. IDs start at `<parent>/1` for each run.

Error:

```json
{"content":[{"type":"text","text":"Script failed\nWall time 0.1 seconds\nOutput:\n"},{"type":"text","text":"partial output"},{"type":"text","text":"Script error:\nError: permission denied\nCalls already made (not undone):\necho (error)"}],"details":{"calls":[{"id":"outer/1","name":"echo","args":"{}","status":"error","durationMs":12,"error":"permission denied"}]},"isError":true}
```

Unknown, inactive, invalid, blocked, or recursive calls never execute. Completed effects are not undone if later code fails.

Cancellation:

```json
{"isError":true,"details":{"calls":[{"id":"outer/1","name":"echo","args":"{}","status":"ok","durationMs":12},{"id":"outer/2","name":"pending","args":"{}","status":"cancelled","durationMs":20}]},"content":[{"type":"text","text":"Script failed\nWall time 0.1 seconds\nOutput:\n"},{"type":"text","text":"partial output"},{"type":"text","text":"Script error:\nScript aborted: Execution aborted\nCalls already made (not undone):\necho (ok)\npending (cancelled)"}]}
```

Ending a script cancels running and queued calls. A queued aborted call rejects with `Tool call aborted` and never starts.
Outer abort waits at most `abortResultGraceMs: 5000` for codemode's partial result. Other tools keep immediate abort handling.
The after hook shares that deadline. If it misses the deadline, its late changes are ignored and the tool result gains:
`Note: a tool_result handler did not finish before the abort deadline; its changes were not applied.`

Timeout and output limit requests:

```json
{"code":"// @options: {\"timeout_ms\":100}\nwhile(true) {}"}
{"code":"// @options: {\"max_output_tokens\":0}\ntext(\"large output\"); throw new Error(\"visible\");"}
```

Timeout returns `isError: true` with `Script timeout: Execution timed out after 100 ms` in the failure block.
The zero-budget example still returns the complete failure block and a full-output file or a visible spill error.

## Store format and older readers

Completed writes append one custom session entry. Failed or aborted scripts append none.
Rebuild the store by folding `set` and `delete` entries on the current branch from root to leaf.
Branching away from an entry removes those values from that branch's view.

```json
{"type":"custom","customType":"codemode-store","data":{"set":{"k":1},"delete":["old"]},"id":"a1b2c3d4","parentId":"previous","timestamp":"2026-10-09T12:00:00.000Z"}
```

Fork.3 and older TS readers ignore custom entries in model context. Rust readers retain them as opaque data and exclude them from model context.
A Rust port must read the full branch to rebuild the store. Its windowed reader can omit old custom entries.
The daemon protocol is unchanged. Call records stay in the codemode result's `details.calls`.

## Port fixtures

[`test/fixtures/codemode/cases.jsonl`](../test/fixtures/codemode/cases.jsonl) has one JSON object per line.
Each names the script, stubbed tool replies, expected text/image output, error status, and nested name/status records.
The TS tests execute every case with the real sandbox. Session-hook, branch, sequential-queue, setting, and outer-abort cases live in `test/codemode.test.ts`.
The adapter follows pi `packages/coding-agent/src/extensions/codemode/execute.ts`, `tool.ts`, and `renderer.ts` at commit `6fb2e781` (MIT).
