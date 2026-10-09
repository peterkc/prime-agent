import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { encodeJson, type HelloReply, type InputItem, InputParser, type TspEvent } from "@stencil-hq/tern";

// Read only when probing. Same order as coding-agent getPackageDir: PI_PACKAGE_DIR
// (with its expandTildePath rules), then next to a compiled Bun binary, then this package's root.
function packageVersion(): string {
	const dir = process.env.PI_PACKAGE_DIR;
	const home = dir === "~" || dir?.startsWith("~/") || (process.platform === "win32" && dir?.startsWith("~\\"));
	const path = dir
		? join(home ? join(homedir(), dir.slice(2)) : dir, "package.json")
		: /\$bunfs|~BUN|%7EBUN/.test(import.meta.url)
			? join(dirname(process.execPath), "package.json")
			: new URL("../../package.json", import.meta.url);
	return (JSON.parse(readFileSync(path, "utf8")) as { readonly version: string }).version;
}

export interface NativeCapabilities {
	readonly apc: number;
	readonly credits: number;
	readonly cols: number;
}

export type NativeState =
	| { readonly kind: "unprobed" }
	| { readonly kind: "pending" }
	| { readonly kind: "available"; readonly caps: NativeCapabilities }
	| { readonly kind: "off" };

function helloCapabilities(reply: HelloReply): NativeCapabilities | undefined {
	const { v, apc, credits, cols } = reply.raw;
	if (
		v !== 1 ||
		typeof apc !== "number" ||
		!Number.isInteger(apc) ||
		apc < 64 ||
		apc > 262_144 ||
		typeof credits !== "number" ||
		!Number.isInteger(credits) ||
		credits < 1 ||
		typeof cols !== "number" ||
		!Number.isInteger(cols) ||
		cols < 1
	)
		return undefined;
	return { apc, credits, cols };
}

export class NativeProbe {
	private readonly parser = new InputParser();
	private readonly listeners = new Set<() => void>();
	private outcome: NativeState = { kind: "unprobed" };
	private keys?: (text: string) => void;
	private event?: (event: TspEvent) => void;
	private probeTimer?: ReturnType<typeof setTimeout>;
	private flushTimer?: ReturnType<typeof setTimeout>;
	private reading = false;

	get state(): NativeState {
		return this.outcome;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	start(write: (text: string) => void, keys: (text: string) => void, event: (event: TspEvent) => void): void {
		this.keys = keys;
		this.event = event;
		if (this.outcome.kind !== "unprobed") return;
		let ver: string;
		try {
			ver = packageVersion();
		} catch {
			// The version is metadata only; without it, stay on the ANSI renderer instead of failing startup.
			this.end();
			return;
		}
		this.outcome = { kind: "pending" };
		this.probeTimer = setTimeout(() => this.end(), 1000);
		write(
			Buffer.from(encodeJson({ verb: "q", body: { q: "hello", v: [1], app: "prime-agent", ver } })).toString("utf8"),
		);
		write("\x1b[c");
	}

	feed(text: string): void {
		this.clearFlushTimer();
		if (this.outcome.kind === "off" || this.outcome.kind === "unprobed") {
			this.keys?.(text);
			return;
		}
		this.reading = true;
		try {
			this.route(this.parser.feed(Buffer.from(text, "utf8")));
		} finally {
			this.reading = false;
		}
		if (this.state.kind === "off") this.flush();
		else if (this.parser.pending) this.flushTimer = setTimeout(() => this.flush(), 10);
	}

	end(): void {
		if (this.outcome.kind === "off") return;
		this.setState({ kind: "off" });
		this.clearFlushTimer();
		if (!this.reading) this.flush();
	}

	resize(cols: number): void {
		if (this.outcome.kind === "available") {
			this.outcome = { kind: "available", caps: { ...this.outcome.caps, cols } };
		}
	}

	stop(): void {
		if (this.outcome.kind === "pending") this.end();
		else this.flush();
		this.keys = undefined;
		this.event = undefined;
	}

	private setState(state: NativeState): void {
		clearTimeout(this.probeTimer);
		this.probeTimer = undefined;
		this.outcome = state;
		for (const listener of this.listeners) listener();
	}

	private clearFlushTimer(): void {
		clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
	}

	private flush(): void {
		this.clearFlushTimer();
		this.route(this.parser.flush());
	}

	private route(items: readonly InputItem[]): void {
		for (const item of items) {
			switch (item.type) {
				case "keys":
					this.keys?.(Buffer.from(item.bytes).toString("utf8"));
					break;
				case "reply":
					if (this.outcome.kind === "pending" && item.reply.r === "hello") {
						const caps = helloCapabilities(item.reply);
						this.setState(caps ? { kind: "available", caps } : { kind: "off" });
					}
					break;
				case "da1":
					if (this.outcome.kind === "pending") this.end();
					break;
				case "event":
					if (this.outcome.kind === "available") this.event?.(item.event);
					break;
				default: {
					const unhandled: never = item;
					throw new Error(`Unexpected input item: ${unhandled}`);
				}
			}
		}
	}
}
