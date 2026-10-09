import { type Node, node, type Surface, type TspEvent } from "@stencil-hq/tern";
import { type Component, Container, CURSOR_MARKER } from "../tui.js";
import type { NativeConnection } from "./connection.js";

type SurfaceState =
	| { readonly kind: "closed" }
	| { readonly kind: "live"; readonly surface: Surface }
	| { readonly kind: "failed" };

interface Piece {
	readonly cols: number;
	readonly lines: readonly string[];
	readonly node: Node;
}

function rowsNode(
	key: string,
	lines: string[],
	cols: number,
	previous: Map<string, Piece>,
	next: Map<string, Piece>,
): Node {
	const old = previous.get(key);
	const piece =
		old?.cols === cols && old.lines.length === lines.length && old.lines.every((line, i) => line === lines[i])
			? old
			: { cols, lines, node: node("rows", { key, cols, lines }) };
	next.set(key, piece);
	return piece.node;
}

function appendLeaves(
	component: Component,
	key: string,
	cols: number,
	previous: Map<string, Piece>,
	next: Map<string, Piece>,
	out: Node[],
): void {
	if (component instanceof Container && component.constructor === Container) {
		for (const [i, child] of component.children.entries()) {
			appendLeaves(child, `${key}-${i}`, cols, previous, next, out);
		}
		return;
	}
	const lines = component.render(cols).map((line) => line.replaceAll(CURSOR_MARKER, ""));
	for (let from = 0; from < Math.max(1, lines.length); from += 64) {
		out.push(rowsNode(`${key}_${from / 64}`, lines.slice(from, from + 64), cols, previous, next));
	}
}

/** Prime's component layout; Surface owns diffing and credit flow control. */
export class NativeBackend {
	private state: SurfaceState = { kind: "closed" };
	private pieces = new Map<string, Piece>();
	private firstLeaf: string | undefined;
	private readonly unsubscribe: () => void;

	constructor(
		private readonly connection: NativeConnection,
		private readonly changed: () => void,
		private readonly failed: () => void,
	) {
		this.unsubscribe = connection.subscribe((event) => this.handleEvent(event));
	}

	get live(): boolean {
		return this.state.kind === "live";
	}

	get columns(): number {
		const state = this.connection.probe.state;
		return state.kind === "available" ? state.caps.cols : 0;
	}

	open(): boolean {
		switch (this.state.kind) {
			case "live":
				return true;
			case "failed":
				return false;
			case "closed": {
				const surface = this.connection.open();
				this.state = surface ? { kind: "live", surface } : { kind: "failed" };
				return !!surface;
			}
			default: {
				const unhandled: never = this.state;
				throw new Error(`Unexpected surface state: ${unhandled}`);
			}
		}
	}

	render(main: readonly Component[], dock: readonly Component[]): void {
		if (this.state.kind !== "live") return;
		const cols = this.columns;
		const next = new Map<string, Piece>();
		const transcript: Node[] = [];
		const dockRows: Node[] = [];
		for (const [i, component] of main.entries()) {
			appendLeaves(component, `s${i}`, cols, this.pieces, next, transcript);
		}
		for (const [i, component] of dock.entries()) {
			appendLeaves(component, `d${i}`, cols, this.pieces, next, dockRows);
		}
		this.firstLeaf = transcript[0] ? `main.tx.${transcript[0].props.key}` : undefined;
		transcript.push(rowsNode("tail", [], cols, this.pieces, next));
		this.pieces = next;
		this.state.surface.render({
			main: [node("col", { key: "tx", gap: "none", min: { w: `${cols}ch` } }, transcript)],
			dock: dockRows,
		});
	}

	revealTop(): void {
		if (this.state.kind === "live" && this.firstLeaf) this.state.surface.reveal(this.firstLeaf, "start");
	}

	revealTail(): void {
		if (this.state.kind === "live") this.state.surface.reveal("main.tx.tail", "nearest");
	}

	close(keep: boolean): Promise<void> {
		if (this.state.kind !== "live") return Promise.resolve();
		const surface = this.state.surface;
		this.state = { kind: "closed" };
		return surface.close({ keep });
	}

	dispose(): void {
		this.unsubscribe();
	}

	private handleEvent(event: TspEvent): void {
		if (this.state.kind !== "live") return;
		const { surface } = this.state;
		switch (event.ev) {
			case "resize":
			case "theme":
				this.changed();
				return;
			case "gone":
				if (event.ids.length === 1 && event.ids[0] === surface.id) {
					this.state = { kind: "closed" };
					this.open();
					this.changed();
					return;
				}
				break;
			case "error":
				if (event.sf !== undefined && event.sf !== surface.id) return;
				break;
			default:
				return;
		}
		void this.close(false);
		this.state = { kind: "failed" };
		this.connection.probe.end();
		this.failed();
	}
}
