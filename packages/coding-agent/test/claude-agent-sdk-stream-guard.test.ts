import { expect, it, vi } from "vitest";
import { guardClaudeStream } from "../src/core/extensions/builtin/claude-agent-sdk-stream-guard.js";
import { createDeferred } from "./suite/scheduling.js";

it.each(["progress before the deadline"])(
	"extends the idle deadline for %s and clears the timer on completion",
	async () => {
		vi.useFakeTimers();
		const first = createDeferred();
		const second = createDeferred();
		const third = createDeferred();
		const abort = vi.fn();
		const progress = { type: "stream_event", event: { type: "message_start" } };
		const ping = { type: "stream_event", event: { type: "ping" } };
		async function* query() {
			await first.promise;
			yield progress;
			await second.promise;
			yield ping;
			await third.promise;
			yield { type: "result" };
		}
		const messages: unknown[] = [];
		async function read() {
			for await (const message of guardClaudeStream(query(), 2, abort)) messages.push(message);
			return messages;
		}
		const received = read().catch((error: unknown) => error);
		try {
			await vi.advanceTimersByTimeAsync(1_500);
			first.resolve();
			await vi.advanceTimersByTimeAsync(1_000);
			second.resolve();
			await vi.advanceTimersByTimeAsync(500);
			third.resolve();
			expect(await received).toEqual([progress, { type: "result" }]);
			expect(abort).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			first.resolve();
			second.resolve();
			third.resolve();
			await received;
			vi.useRealTimers();
		}
	},
);
