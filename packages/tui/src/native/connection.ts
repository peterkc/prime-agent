import { encodeJson, type OutMessage, Surface, type SurfaceLink, type TspEvent } from "@stencil-hq/tern";
import type { Terminal } from "../terminal.js";
import { NativeProbe } from "./probe.js";

export class NativeConnection implements SurfaceLink {
	readonly probe = new NativeProbe();
	private terminal?: Pick<Terminal, "write">;
	private live?: Surface;
	private readonly closed = new Map<string, Surface>();
	private readonly kept = new Set<string>();
	private readonly listeners = new Set<(event: TspEvent) => void>();
	private surfaceCount = 1;
	private draining = false;

	start(terminal: Pick<Terminal, "write">, keys: (text: string) => void): void {
		this.terminal = terminal;
		this.draining = false;
		this.probe.start(
			(text) => terminal.write(text),
			(text) => {
				if (!this.draining) keys(text);
			},
			(event) => this.route(event),
		);
	}

	subscribe(listener: (event: TspEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	open(): Surface | undefined {
		if (this.probe.state.kind !== "available") return undefined;
		if (this.live) return this.live;
		const id = this.surfaceCount === 1 ? "prime" : `prime-${this.surfaceCount}`;
		const previous = this.closed.get(id);
		const options = {
			mode: "inline",
			title: "Prime",
			role: "prime.session",
			...(previous ? { adopt: true } : {}),
		} as const;
		this.send({ verb: "o", body: { id, ...options } });
		this.live = new Surface(this, id, options, previous);
		// Hide Tern's "fallback" label on rows; an adopted surface keeps the sheet.
		// The class is internal to Tern, so a Tern update can bring the label back.
		if (!previous) this.live.stylesheet("prime", ".sf-rows-mark { display: none; }");
		this.closed.delete(id);
		this.kept.delete(id);
		return this.live;
	}

	get liveSurfaceId(): string | undefined {
		return this.live?.id;
	}

	credits(): number {
		return this.probe.state.kind === "available" ? this.probe.state.caps.credits : 0;
	}

	send(message: OutMessage): void {
		if (this.probe.state.kind !== "available") return;
		this.terminal?.write(Buffer.from(encodeJson(message, { limit: this.probe.state.caps.apc })).toString("utf8"));
		if (message.verb === "x") {
			if (message.body.keep) this.kept.add(message.body.id);
			else this.kept.delete(message.body.id);
		}
	}

	dropped(surface: Surface): void {
		if (this.live !== surface) return;
		this.live = undefined;
		if (this.kept.delete(surface.id)) this.closed.set(surface.id, surface);
		else this.closed.delete(surface.id);
	}

	beginDrain(): void {
		this.draining = true;
	}

	private route(event: TspEvent): void {
		if (this.draining) return;
		switch (event.ev) {
			case "ack":
				if (this.live?.id === event.sf) this.live.acknowledge(event.s);
				return;
			case "resize":
				if (!Number.isInteger(event.cols) || event.cols < 1) return;
				this.probe.resize(event.cols);
				break;
			case "gone":
				for (const id of event.ids) {
					this.kept.delete(id);
					const wasClosed = this.closed.delete(id);
					if (this.live?.id === id) {
						this.live.gone();
						this.surfaceCount++;
					} else if (wasClosed) this.surfaceCount++;
				}
				break;
			case "theme":
			case "error":
				break;
			default:
				return;
		}
		for (const listener of this.listeners) listener(event);
	}
}

export const nativeConnection = new NativeConnection();
