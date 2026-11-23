// Adapted from rynfar/meridian src/proxy/streamIdleGuard.ts at commit 510da1d9 (MIT, per its README)
// Adapted from rynfar/meridian src/proxy/turnOutcome.ts at commit 510da1d9 (MIT, per its README)
import type { AssistantMessage } from "@earendil-works/pi-ai";

const idle = Symbol("idle");

function isKeepalive(message: unknown): boolean {
	return (
		message !== null &&
		typeof message === "object" &&
		"type" in message &&
		message.type === "stream_event" &&
		"event" in message &&
		message.event !== null &&
		typeof message.event === "object" &&
		"type" in message.event &&
		message.event.type === "ping"
	);
}

export async function* guardClaudeStream<T>(
	query: AsyncIterable<T> & { close?(): void },
	seconds: number,
	abort: () => void,
): AsyncGenerator<T> {
	const iterator = query[Symbol.asyncIterator]();
	const idleMs = seconds * 1000;
	let lastMessage = performance.now();
	try {
		while (true) {
			const remaining = idleMs - (performance.now() - lastMessage);
			if (remaining <= 0) break;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let next: IteratorResult<T> | typeof idle;
			try {
				next = await Promise.race([
					iterator.next(),
					new Promise<typeof idle>((resolve) => {
						timer = setTimeout(() => resolve(idle), Math.ceil(remaining));
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
			if (next === idle) break;
			if (next.done) return;
			if (isKeepalive(next.value)) continue;
			lastMessage = performance.now();
			yield next.value;
		}
		abort();
		query.close?.();
		throw Error(`Claude query timed out after ${seconds} seconds without an SDK message.`);
	} finally {
		// Await the iterator's teardown before publishing a terminal event to Prime.
		await iterator.return?.();
	}
}

export function hasTurnOutput(content: AssistantMessage["content"], capturedTools: number): boolean {
	return capturedTools > 0 || content.some((block) => block.type === "text" && block.text.length > 0);
}
