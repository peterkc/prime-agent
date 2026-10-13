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

/** XTVERSION: terminals that do not know it ignore it, so it never prints. */
const XTVERSION = "\x1b[>0q";
const VERSION_REPLY = "\x1bP>|";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
/**
 * Terminals named here parse APC strings. Others get no hello, because some,
 * such as JetBrains JediTerm and Apple Terminal, print an APC payload as text.
 * Tern answers XTVERSION as kitty.
 */
const APC_TERMINAL = /^(?:kitty|tern)(?:[(\s]|$)/i;

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

/** The length of the longest end of `text` that starts `prefix`. */
function partialPrefix(text: string, prefix: string): number {
	for (let length = Math.min(prefix.length - 1, text.length); length > 0; length--) {
		if (text.endsWith(prefix.slice(0, length))) return length;
	}
	return 0;
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
	private awaitingSentinel = false;
	private write?: (text: string) => void;
	private hello = "";
	/** The XTVERSION reply to the identify query, until our DA1 reply decides. */
	private version?: string;
	/** XTVERSION queries still unanswered; their replies are removed from input. */
	private pendingVersionReplies = 0;
	/** The start of an XTVERSION reply or paste marker that the next input completes. */
	private held = "";
	/** Inside a bracketed paste, where nothing is a reply. */
	private pasting = false;

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
		this.write = write;
		this.hello = Buffer.from(
			encodeJson({ verb: "q", body: { q: "hello", v: [1], app: "prime-agent", ver } }),
		).toString("utf8");
		// Step 1: identify the terminal. Our DA1 reply ends this step (see route).
		this.awaitingSentinel = true;
		this.pendingVersionReplies++;
		this.probeTimer = setTimeout(() => this.end(), 1000);
		write(`${XTVERSION}\x1b[c`);
	}

	feed(text: string): void {
		this.clearFlushTimer();
		this.reading = true;
		try {
			for (const part of this.splitVersions(text)) {
				if (typeof part === "string") this.input(part);
				else this.versionReply(part.name);
			}
		} finally {
			this.reading = false;
		}
		if (this.state.kind === "off") this.flush();
		else if (this.parser.pending || this.held) this.flushTimer = setTimeout(() => this.flush(), 10);
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
		this.release();
		this.pendingVersionReplies = 0;
		this.pasting = false;
		this.awaitingSentinel = false;
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
		// Once the probe is off, nothing is held. While probing, a started XTVERSION
		// reply or a paste waits for its end; a bare prefix is input.
		if (this.outcome.kind === "off" || (!this.pasting && !this.held.startsWith(VERSION_REPLY))) this.release();
		this.route(this.parser.flush());
	}

	private release(): void {
		const text = this.held;
		this.held = "";
		this.input(text);
	}

	/** Probe replies go through the TSP parser; once the probe settles, input passes unchanged. */
	private input(text: string): void {
		if (!text) return;
		if ((this.outcome.kind === "off" && !this.awaitingSentinel) || this.outcome.kind === "unprobed") {
			this.keys?.(text);
		} else {
			this.route(this.parser.feed(Buffer.from(text, "utf8")));
		}
	}

	/** Splits input around the XTVERSION replies we wait for, keeping their order and pastes. */
	private splitVersions(text: string): (string | { readonly name: string })[] {
		const parts: (string | { readonly name: string })[] = [];
		let rest = this.held + text;
		this.held = "";
		while (rest && (this.pendingVersionReplies > 0 || this.pasting)) {
			const marker = this.pasting ? PASTE_END : PASTE_START;
			const paste = rest.indexOf(marker);
			const at = this.pasting ? -1 : rest.indexOf(VERSION_REPLY);
			if (paste >= 0 && (at < 0 || paste < at)) {
				parts.push(rest.slice(0, paste + marker.length));
				rest = rest.slice(paste + marker.length);
				this.pasting = !this.pasting;
				continue;
			}
			const end = at < 0 ? -1 : rest.indexOf("\x1b\\", at);
			if (end < 0) {
				let keep = Math.max(
					partialPrefix(rest, marker),
					at < 0 ? partialPrefix(rest, VERSION_REPLY) : rest.length - at,
				);
				// No real reply is this long; release it as input.
				if (keep > 256) keep = 0;
				parts.push(rest.slice(0, rest.length - keep));
				this.held = rest.slice(rest.length - keep);
				return parts;
			}
			parts.push(rest.slice(0, at), { name: rest.slice(at + VERSION_REPLY.length, end) });
			this.pendingVersionReplies--;
			rest = rest.slice(end + 2);
		}
		parts.push(rest);
		return parts;
	}

	private versionReply(name: string): void {
		if (this.awaitingSentinel) {
			this.version = name;
		} else if (this.outcome.kind === "pending") {
			// Step 2 sentinel: a terminal that speaks TSP answers hello before it.
			this.end();
		}
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
					if (this.awaitingSentinel) {
						this.awaitingSentinel = false;
						// Replies come in order: an XTVERSION reply can no longer follow our DA1's.
						this.pendingVersionReplies = 0;
						if (this.outcome.kind !== "pending") break;
						if (!APC_TERMINAL.test(this.version ?? "")) {
							this.end();
							break;
						}
						// Step 2: hello. XTVERSION, not DA1, marks its end: other startup
						// probes send DA1 too, and their replies would arrive first.
						clearTimeout(this.probeTimer);
						this.probeTimer = setTimeout(() => this.end(), 1000);
						this.pendingVersionReplies++;
						this.write?.(`${this.hello}${XTVERSION}`);
					} else {
						// InputParser discards DA1 attributes; downstream probes only need the sentinel.
						this.keys?.("\x1b[?c");
					}
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
