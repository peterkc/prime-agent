/*!
 * Adapted from rynfar/meridian src/proxy/streamIdleGuard.ts at commit 510da1d9 (MIT, per its README)
 * Adapted from rynfar/meridian src/proxy/turnOutcome.ts at commit 510da1d9 (MIT, per its README)
 *
 * MIT License
 *
 * Copyright (c) 2026 Trevor Walker
 * (per the upstream LICENSE added after 510da1d9).
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
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

function idleError(seconds: number) {
	return Error(`Claude query timed out after ${seconds} seconds without an SDK message.`);
}

export async function guardClaudeInit<T>(init: Promise<T>, seconds: number, abort: () => void): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await Promise.race([
			init,
			new Promise<typeof idle>((resolve) => {
				timer = setTimeout(() => resolve(idle), seconds * 1000);
			}),
		]);
		if (result !== idle) return result;
	} finally {
		clearTimeout(timer);
	}
	abort();
	throw idleError(seconds);
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
		throw idleError(seconds);
	} finally {
		// Await the iterator's teardown before publishing a terminal event to Prime.
		await iterator.return?.();
	}
}
