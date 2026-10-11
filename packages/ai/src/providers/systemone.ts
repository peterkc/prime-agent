import { calculateCost } from "../models.js";
import type { AssistantMessage, Context, Model, SimpleStreamOptions, StreamFunction, StreamOptions } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";

export const streamSystemOne: StreamFunction<"systemone", StreamOptions> = (model, context, options) => {
	const stream = new AssistantMessageEventStream();
	void serveSystemOne(model, context, options, stream);
	return stream;
};

export const streamSimpleSystemOne: StreamFunction<"systemone", SimpleStreamOptions> = streamSystemOne;

async function serveSystemOne(
	model: Model<"systemone">,
	context: Context,
	options: StreamOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	const output = createOutput(model);
	try {
		const user = context.messages
			.slice()
			.reverse()
			.find((message) => message.role === "user");
		const text = user
			? typeof user.content === "string"
				? user.content
				: user.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n")
			: "";
		let payload: unknown;
		try {
			payload = JSON.parse(text);
		} catch {
			throw new Error("The newest user message is not JSON");
		}
		const timeout = AbortSignal.timeout(options?.timeoutMs ?? 30000);
		const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
		const headers = new Headers({ "Content-Type": "application/json" });
		if (options?.apiKey !== undefined) headers.set("Authorization", `Bearer ${options.apiKey}`);
		for (const [name, value] of Object.entries(options?.headers ?? {})) headers.set(name, value);
		stream.push({ type: "start", partial: output });
		const response = await fetch(`${model.baseUrl.replace(/\/+$/, "")}/systemone`, {
			method: "POST",
			headers,
			body: JSON.stringify(payload),
			signal,
		});
		const body = await response.text();
		if (!response.ok) throw new Error(`systemone returned HTTP ${response.status}: ${body.slice(0, 500)}`);
		signal.throwIfAborted();
		output.content = [{ type: "text", text: body }];
		const usage = replyUsage(body);
		output.usage.input = usage.input;
		output.usage.output = usage.output;
		output.usage.totalTokens = usage.input + usage.output;
		calculateCost(model, output.usage);
		stream.push({ type: "done", reason: "stop", message: output });
	} catch (error) {
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = error instanceof Error ? error.message : String(error);
		stream.push({ type: "error", reason: output.stopReason, error: output });
	} finally {
		stream.end();
	}
}

function replyUsage(body: string): { input: number; output: number } {
	let reply: unknown;
	try {
		reply = JSON.parse(body);
	} catch {
		// Successful response bodies remain text, even without a JSON usage envelope.
		return { input: 0, output: 0 };
	}
	const usage = reply && typeof reply === "object" && "usage" in reply ? reply.usage : undefined;
	if (!usage || typeof usage !== "object") return { input: 0, output: 0 };
	return {
		input: "input_tokens" in usage && typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
		output: "output_tokens" in usage && typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
	};
}

function createOutput(model: Model<"systemone">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}
