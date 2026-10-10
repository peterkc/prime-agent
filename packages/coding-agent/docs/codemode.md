# Codemode

`codemode` runs JavaScript that calls the session's active tools. Only the script's output reaches the model.

```text
model -> codemode {code} -> fresh in-process AST interpreter
                            tools.name(args)
                                   |
                     host argument checks and before/after hooks
                                   |
                     tool text -> script -> output and calls
```

## Use

JavaScript only. The code is an async function body, so top-level `await` and `return` work.

```js
const matches = search({query: "echo"});
text(matches);
text(await tools.echo({value: "hello"}));
store("lastAnswer", 42);
```

Use this example only when the session has an active `echo` tool. For a single call, call `echo` directly.

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
Run JavaScript that calls other tools. Pass {code: "..."} with raw JavaScript as the body of an async function; top-level await and return work. No Node, file system, process, timers or ambient network access. Configured OpenAPI tools may make approved HTTP calls.
- Every other tool you can call is also tools.<name>(args), with the same arguments. Ordinary tools return their text joined with newlines; configured OpenAPI tools return structured JSON. Failed calls reject with an Error carrying the tool's error text. Only active tools are callable; codemode cannot call itself, and tools named in the codemodeExcludeTools setting are not callable. Use tools["my-tool"] or tools.my_tool for non-identifier names.
- Sequential tools such as ipython run one at a time. Calls still running or queued when the script ends are cancelled; completed effects are not undone.
- text(value), console.log/info/warn/error/debug/dir/table(...), and final expressions or return add output in order. image(dataUrlOrImageBlock) adds a PNG, JPEG, GIF, or WebP image; remote URLs are rejected. exit() completes immediately and keeps output and store writes.
- store(key, value) and load(key) keep JSON values on the current session branch. store(key, undefined) deletes a key; missing keys load as undefined. Only completed scripts persist writes.
- ALL_TOOLS lists names and TypeScript declarations. await describeTool(name) returns a declaration. Python skills and MCP servers stay reachable through ipython, not as direct tools.
- Optional first line: // @options: {"max_output_tokens": 10000, "timeout_ms": 60000, "max_tool_calls": 100}. max_output_tokens is a non-negative safe integer (default 10000, 4 characters per token); timeout_ms is an integer from 1 to 2147483647 (default none); max_tool_calls is a non-negative safe integer (default unlimited), including native search. Unknown fields, including max_output_bytes, are rejected.
- The budget applies only to user text; over budget it keeps the head and tail and spills the full text to a temp file. Failure keeps partial output and a list of calls already made. Each run uses a fresh in-process interpreter, with no heap cap, 16777216 output characters, 100000 output items, 262144 JSON characters per store value, and 1048576 total store characters (keys plus values). These do not bound host process memory, tool results or synchronous regex steps. search({query}) looks up an exact tool path and search({namespace, limit, offset}) browses a namespace; results include schema-backed signatures. describeTool(name), toolExpression(path), and searchSignature() describe call syntax. Script output also includes diagnostics and warnings.
<!-- description:end -->

## Native tool-use guidance

The native system prompt includes these ordered guidelines only while the corresponding tool is active. Custom system prompts retain their existing rendering contract.

Codemode:

<!-- codemode-guidelines:start -->
```json
[
  "Use codemode for chains or parallel calls to typed tools that Python cannot reach, when only a filtered result should reach the context.",
  "Filter large results before returning them to the model.",
  "Use Promise.allSettled for independent calls; chain dependent calls with await.",
  "For one tool call, call the tool directly.",
  "Do not wrap tools.ipython in codemode only to run Python.",
  "Call search({query}) to look up an exact tool path, or search({namespace, limit, offset}) to browse a namespace; results include schema-backed signatures.",
  "toolExpression(path) and searchSignature() describe the call syntax.",
  "Configured OpenAPI operations are codemode-only tools. Use their structured JSON results."
]
```
<!-- codemode-guidelines:end -->

Ipython:

<!-- ipython-guidelines:start -->
```json
[
  "Use ipython for files, shell commands, Python skills, MCP servers, data analysis, long-running work, and state that must last across calls.",
  "Orchestrate tools and resources reachable through Python in ipython.",
  "Call typed tools that Python cannot reach directly.",
  "Run project imports, tests, scripts, CLIs, and dependency checks through the target project's own environment, not by importing the project into the kernel."
]
```
<!-- ipython-guidelines:end -->

## Script semantics and limits

- Each run has fresh lexical state in `@opencode/codemode@2.0.26`'s AST interpreter. It exposes `tools`, native `search`, `text`, `console.log/info/warn/error/debug/dir/table`, `image`, `exit`, `store`, `load`, `ALL_TOOLS`, `describeTool`, `toolExpression`, and `searchSignature`.
- User code cannot redeclare the lexical prelude names `ALL_TOOLS` or `console`.
- There is no ambient file system, network, process, timer, `models`, or `searchTools` API. `eval`, `Function`, `globalThis` and unsupported JavaScript syntax, including classes, do not carry over from QuickJS. The interpreter supports a JavaScript subset, not a general JavaScript VM.
- Native `search({})` browses the callable catalog. `search({query:"echo"})` looks up an exact path. `search({namespace:"math",limit:1,offset:1})` browses a namespace with pagination. Results carry callable paths and schema-backed signatures. `toolExpression(path)` returns callable source; `searchSignature()` describes search arguments.
- Unknown, inactive, excluded and recursive tools are unavailable. Native diagnostics replace QuickJS's synchronous member-access `TypeError` contract. A missing tool call can be caught in script code; its diagnostic names the unknown tool, and no checked call starts.
- `tools.name(args)` takes the direct tool's arguments after JSON conversion and host validation. Ordinary tools resolve to joined text. Configured OpenAPI operations resolve to structured JSON after the result hooks; a non-JSON hook result fails visibly. Failed calls reject with a tool error.
- Canonical dotted identifier paths form namespaces without underscore aliases. Non-identifier names support `tools["my-tool"]` and an unambiguous sanitized alias such as `tools.my_tool`. Canonical names take precedence; ambiguous aliases are omitted. Duplicate or prefix-conflicting canonical registrations fail before effects. `ALL_TOOLS` lists callable paths and native declarations. `await describeTool(name)` returns a declaration, or `undefined` for a missing name.
- An optional first line is `// @options: {"max_output_tokens": 10000, "timeout_ms": 60000, "max_tool_calls": 100}`. Invalid JSON, unknown fields (including `max_output_bytes`), empty source, and an options line without code fail before execution.
- `timeout_ms` is an integer from 1 to 2,147,483,647; the default is no deadline. Native cancellation bounds asynchronous work and interpreter loops. Synchronous regular expressions cannot be preempted. `max_tool_calls` is a non-negative safe integer, default unlimited, and counts native search as well as tools. Helpers such as `text` do not count.
- `max_output_tokens` is a non-negative safe integer, default 10000. Four characters estimate one token. The budget covers joined user text only, not the header, diagnostics, skipped operations or failure block. Prime does not configure the native output-byte limit.
- Item 1 is `Script completed` or `Script failed`, then `Wall time <s> seconds` and `Output:`. `text()`, `console.*`, final expressions and explicit `return` add output in order, joined with newlines. Only non-null final values add output; scripts without a completion value and explicit `return null` add nothing. Images follow the text. Diagnostics and tool-call metadata also appear in `details`; the native value does not.
- Over budget, user text keeps the first half and last half of the character budget. With zero, only the truncation notice remains. The full user text goes to a temp file. The notice names `[Full output: <path>]`, and `details.fullOutputPath` holds it.
- If spilling fails, no path is advertised. The notice says `[Could not save the full output: <error>]`. The output and failure block remain.
- A failed script has `isError: true`. Its final text item starts `Script error:` and includes the native diagnostic or host error, then `Calls already made (not undone):` and one name/status line per call. The header and this block are never truncated. Successful native warnings remain visible as `Script warnings:`. A `TimeoutExceeded` cleanup warning still fails the script and prevents store writes.
- `image()` accepts a base64 `data:` URL, `{image_url}`, or an MCP block `{type:"image",data,mimeType}` for PNG, JPEG, GIF, and WebP. Remote `http(s)` URLs are rejected. Images become image content and are not saved to files.
- `exit()` stops immediately, including catch/finally and queued work, keeping output and store writes. `store(key, undefined)` deletes a key. Missing keys load as `undefined`. Loaded values are copies. Failure, timeout and external abort never persist writes.
- There is no heap cap. The interpreter runs in the host OS process and is not an OS security boundary. Output limits do not bound host memory, tool results, host call records or synchronous regex steps.
- Script output is at most 16,777,216 characters (text plus base64 image data) and 100,000 output items. Store values are at most 262,144 JSON characters each. Store keys plus serialized values total at most 1,048,576 characters. Exceeding a producer limit fails before appending that item and prevents a store commit.

Node requires version 24.0.0 or later. The compiled binary uses Bun 1.4.0. Neither runtime needs a codemode WASM asset or worker. The host retains the fork's checked hooks, branch store, text budgeting, image output, call records and 5000 ms aborted-result grace period.

## OpenAPI operations

Configure a local OpenAPI 3.x JSON or YAML document in global settings or explicit SDK runtime overrides. Project `codemodeOpenAPI` settings are ignored, like MCP server settings:

```json
{
  "codemodeOpenAPI": [{
    "name": "service",
    "specFile": "./openapi.yaml",
    "baseUrl": "https://api.example.com",
    "headersFromEnv": {"x-client": "SERVICE_CLIENT"},
    "authFromEnv": {"bearerAuth": {"type": "bearer", "tokenEnv": "SERVICE_TOKEN"}}
  }]
}
```

Relative `specFile` paths resolve from the global settings directory. SDK runtime overrides have no defining directory; use an absolute path or `~/` path. The catalog is snapshotted at each script's start; changes take effect next run. Invalid global settings or specs fail before execution, without a partial catalog. Only local-document `$ref` references are allowed.

Operations appear under `tools.openapi.service.<operation>` and native namespace search. They are not direct model-active tools. Native skipped operations remain visible in the result. `codemodeExcludeTools` also applies to generated canonical names. Argument validation and the session's before/after hooks apply to every admitted call; a hook refusal starts no HTTP request.

`baseUrl` approves one exact final origin. Use HTTPS, or explicitly configured loopback HTTP. Spec servers cannot retarget it. Userinfo, authority escapes and redirects are refused; writes are not retried. Already-admitted network effects are not undone by later failure or cancellation.

Settings contain environment variable names, never credential values. Values resolve only inside the checked host executor. `authFromEnv` keys name declared security schemes. Mappings support `bearer` (`tokenEnv`), `apiKey` (`valueEnv`), `basic` (`usernameEnv`, `passwordEnv`), and `header` (`name`, `valueEnv`). Default headers do not overwrite explicit/native headers. Missing environment values fail before a request. The host redacts configured credentials from visible values and errors and disables HTTP tracing. Do not pass credentials in script arguments or embed them in specs.

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

Error (the diagnostic text depends on the native failure):

```json
{"content":[{"type":"text","text":"Script failed\nWall time 0.1 seconds\nOutput:\n"},{"type":"text","text":"partial output"},{"type":"text","text":"Script error:\n<native diagnostic>\nCalls already made (not undone):\necho (error)"}],"details":{"calls":[{"id":"outer/1","name":"echo","args":"{}","status":"error","durationMs":12,"error":"permission denied"}]},"isError":true}
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

Timeout returns `isError: true` with `Script timeout: <native TimeoutExceeded message>` in the failure block.
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
The TS tests execute every case with the real interpreter. Session-hook, branch, sequential-queue, setting, and outer-abort cases live in `test/codemode.test.ts`.
The adapter follows pi `packages/coding-agent/src/extensions/codemode/execute.ts`, `tool.ts`, and `renderer.ts` at commit `6fb2e781` (MIT).
