import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { sendDesktopNotification } from "./desktop-notify.js";

export type NotificationProtocol = "bell" | "osc9" | "osc99";
export const NOTIFICATION_PROTOCOLS = {
	kitty: "osc99",
	ghostty: "osc9",
	wezterm: "osc9",
	iterm2: "osc9",
	vscode: "bell",
	alacritty: "bell",
	warp: "osc9",
	orca: "bell",
	otty: "osc99",
	rio: "bell",
	tern: "osc99",
	monstar: "osc9",
	trueColor: "bell",
	base: "bell",
} as const satisfies Record<string, NotificationProtocol>;
export type NotificationTerminalId = keyof typeof NOTIFICATION_PROTOCOLS;

export interface TerminalNotification {
	readonly title: string;
	readonly body: string;
	readonly id?: string;
	readonly type?: "completion" | "error" | "ask";
	readonly urgency?: "low" | "normal" | "critical";
	readonly actions?: "focus" | "report" | "focus-report" | "none";
}

function terminalFromProgram(program: string | undefined): NotificationTerminalId | undefined {
	const name = program?.toLowerCase();
	if (name === "iterm.app") return "iterm2";
	if (name === "warpterminal") return "warp";
	if (name && name !== "base" && name !== "truecolor" && Object.hasOwn(NOTIFICATION_PROTOCOLS, name)) {
		return name as NotificationTerminalId;
	}
	return undefined;
}

export function detectNotificationTerminal(env: NodeJS.ProcessEnv, tmuxClientName?: string): NotificationTerminalId {
	if (env.KITTY_WINDOW_ID) return "kitty";
	if (env.GHOSTTY_RESOURCES_DIR) return "ghostty";
	if (env.WEZTERM_PANE) return "wezterm";
	if (env.ITERM_SESSION_ID) return "iterm2";
	if (env.VSCODE_PID) return "vscode";
	if (env.ALACRITTY_WINDOW_ID) return "alacritty";
	const program = terminalFromProgram(env.TERM_PROGRAM) ?? terminalFromProgram(tmuxClientName);
	if (program) return program;
	const term = env.TERM?.toLowerCase();
	if (term?.includes("ghostty")) return "ghostty";
	if (term === "monstar") return "monstar";
	const color = env.COLORTERM?.toLowerCase();
	return color === "truecolor" || color === "24bit" ? "trueColor" : "base";
}

function tmuxClientTerminal(env: NodeJS.ProcessEnv): string | undefined {
	if (!env.TMUX) return undefined;
	try {
		const output = execFileSync("tmux", ["display-message", "-p", "#{client_termtype}"], {
			env,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 500,
			killSignal: "SIGKILL",
		});
		return /^([A-Za-z][A-Za-z0-9._+-]*)(?=\s|\(|$)/u.exec(output.trim())?.[1];
	} catch {
		return undefined; // A missing tmux client leaves environment detection in charge.
	}
}

function insideHerdr(env: NodeJS.ProcessEnv): boolean {
	return env.HERDR_ENV === "1" || Boolean(env.HERDR_PANE_ID || env.HERDR_TAB_ID || env.HERDR_WORKSPACE_ID);
}

export function canProbeNotifications(env: NodeJS.ProcessEnv): boolean {
	return (
		!insideHerdr(env) &&
		!(
			env.TMUX ||
			env.STY ||
			env.ZELLIJ ||
			env.CMUX_WORKSPACE_ID ||
			env.CMUX_SURFACE_ID ||
			env.CMUX_REMOTE_TRANSPORT ||
			env.WMUX === "1" ||
			env.WMUX_SURFACE_ID ||
			/^(tmux|screen)/iu.test(env.TERM ?? "")
		)
	);
}

export function notificationsSuppressed(env: NodeJS.ProcessEnv): boolean {
	return (
		process.stdout.isTTY !== true ||
		env.PI_NOTIFICATIONS === "off" ||
		env.PI_NOTIFICATIONS === "0" ||
		env.PI_NOTIFICATIONS === "false"
	);
}

function plainLine(value: string): string {
	return stripVTControlCharacters(value)
		.replace(/[\p{Cc}\s]+/gu, " ")
		.trim();
}

function base64(value: string): string {
	return Buffer.from(value).toString("base64");
}

function payloadChunks(value: string): string[] {
	const chunks: string[] = [];
	let chunk = "";
	let bytes = 0;
	for (const char of value) {
		const size = Buffer.byteLength(char);
		if (bytes + size > 2048) {
			chunks.push(chunk);
			chunk = "";
			bytes = 0;
		}
		chunk += char;
		bytes += size;
	}
	chunks.push(chunk);
	return chunks;
}

function formatPayload(metadata: readonly string[], value: string, hold: boolean): string {
	const chunks = payloadChunks(value);
	return chunks
		.map((chunk, index) => {
			const fields = [...metadata];
			if (hold || index < chunks.length - 1) fields.push("d=0");
			const unsafe = /[\x00-\x1f\x7f-\x9f]/u.test(chunk);
			if (unsafe) fields.push("e=1");
			return `\x1b]99;${fields.join(":")};${unsafe ? base64(chunk) : chunk}\x1b\\`;
		})
		.join("");
}

export function formatTerminalNotification(
	protocol: NotificationProtocol,
	notification: TerminalNotification,
	richId?: string,
): string {
	if (protocol === "bell") return "\x07";
	if (protocol === "osc99" && richId) {
		const id = notification.id?.replace(/[^a-zA-Z0-9_+.-]/gu, "");
		const safeId = id && id !== "0" ? id : richId;
		const metadata = [`i=${safeId}`, `f=${base64("Prime")}`];
		if (notification.type) metadata.push(`t=${base64(notification.type)}`);
		if (notification.urgency) metadata.push(`u=${{ low: 0, normal: 1, critical: 2 }[notification.urgency]}`);
		if (notification.actions) {
			metadata.push(
				`a=${{ focus: "focus", report: "report", "focus-report": "focus,report", none: "-focus" }[notification.actions]}`,
			);
		}
		const title = notification.title || notification.body;
		const body = notification.title ? notification.body : "";
		return (
			formatPayload(metadata, title, Boolean(body)) +
			(body ? formatPayload([`i=${safeId}`, "p=body"], body, false) : "")
		);
	}
	const title = plainLine(notification.title);
	const body = plainLine(notification.body);
	const line = title && body ? `${title}: ${body}` : title || body;
	return `\x1b]${protocol === "osc99" ? "99;;" : "9;"}${line}\x1b\\`;
}

export function wrapNotification(sequence: string, protocol: NotificationProtocol, env: NodeJS.ProcessEnv): string {
	if (protocol === "bell") return sequence;
	if (env.TMUX) return `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\\x07`;
	return env.ZELLIJ ? `${sequence}\x07` : sequence;
}

function responseFields(value: string): Map<string, string> {
	const fields = new Map<string, string>();
	for (const field of value.split(":")) {
		const match = /^([a-z])=(.*)$/su.exec(field);
		if (match) fields.set(match[1]!, match[2]!);
	}
	return fields;
}

/** Resolves on spawn, not exit. Node reports a missing binary through its error event. */
async function spawnNotification(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<boolean> {
	try {
		const child = spawn(command, args, { env, stdio: "ignore" });
		child.unref();
		return await new Promise<boolean>((resolve) => {
			child.once("error", () => resolve(false));
			child.once("spawn", () => resolve(true));
		});
	} catch {
		return false; // Optional notification CLIs must not prevent terminal delivery.
	}
}

/** Per-client probe state and best-effort delivery; stop invalidates pending CLI fallbacks. */
export class TerminalNotifications {
	private protocol: NotificationProtocol = "bell";
	private support: "unconfirmed" | "supported" | { readonly probeId: string } = "unconfirmed";
	private awaitingSentinel = false;
	private generation = 0;
	private active = false;
	private tmuxClientName: string | undefined;
	private tmuxQueried = false;

	constructor(private readonly write: (sequence: string) => void) {}

	start(): void {
		this.stop();
		this.active = true;
		const env = process.env;
		if (notificationsSuppressed(env)) return;
		if (env.TMUX && !this.tmuxQueried) {
			this.tmuxClientName = tmuxClientTerminal(env);
			this.tmuxQueried = true;
		}
		this.protocol = NOTIFICATION_PROTOCOLS[detectNotificationTerminal(env, this.tmuxClientName)];
		if (this.protocol !== "osc99" || process.stdin.isTTY !== true || !canProbeNotifications(env)) return;
		const probeId = `prime-probe-${randomUUID()}`;
		this.support = { probeId };
		this.awaitingSentinel = true;
		this.write(`\x1b]99;i=${probeId}:p=?;\x1b\\\x1b[c`);
	}

	handleResponse(sequence: string): boolean {
		if (/^\x1b\[\?[\d;]*c$/u.test(sequence) && this.awaitingSentinel) {
			this.awaitingSentinel = false;
			if (typeof this.support === "object") this.support = "unconfirmed";
			return true;
		}
		const response = /^\x1b\]99;([^;]*);(.*?)(?:\x07|\x1b\\)$/su.exec(sequence);
		if (!response) return false;
		if (typeof this.support !== "object") return true;
		const metadata = responseFields(response[1]!);
		if (metadata.get("i") !== this.support.probeId || metadata.get("p") !== "?") return true;
		const payload = responseFields(response[2]!);
		this.support = payload.get("p")?.split(",").includes("title") ? "supported" : "unconfirmed";
		return true;
	}

	stop(): void {
		this.active = false;
		this.awaitingSentinel = false;
		this.generation++;
		this.support = "unconfirmed";
	}

	private isDeliverable(generation: number): boolean {
		return this.active && generation === this.generation && !notificationsSuppressed(process.env);
	}

	async send(notification: TerminalNotification): Promise<void> {
		const env = process.env;
		const generation = this.generation;
		if (!this.isDeliverable(generation)) return;
		const title = notification.title.trim() || "Prime";
		if (insideHerdr(env) && /^[0-9A-Za-z:_-]{1,64}$/u.test(env.HERDR_PANE_ID?.trim() ?? "")) {
			const sound =
				notification.type === "ask" || notification.type === "error"
					? "request"
					: notification.type === "completion"
						? "done"
						: "none";
			const safeTitle = ["help", "--help", "-h"].includes(title) ? "Prime" : title;
			if (
				await spawnNotification(
					"herdr",
					["notification", "show", safeTitle, "--body", notification.body, "--sound", sound],
					env,
				)
			)
				return;
		}
		if (!this.isDeliverable(generation)) return;
		const surface = env.CMUX_SURFACE_ID?.trim();
		if (surface && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(surface)) {
			if (
				await spawnNotification(
					"cmux",
					["notify", "--surface", surface, "--title", title, "--body", notification.body],
					env,
				)
			)
				return;
		}
		if (!this.isDeliverable(generation)) return;
		const sequence = formatTerminalNotification(
			this.protocol,
			notification,
			this.support === "supported" ? `prime-${randomUUID()}` : undefined,
		);
		this.write(wrapNotification(sequence, this.protocol, env));
		if (this.protocol === "bell") sendDesktopNotification(notification, env);
	}
}
