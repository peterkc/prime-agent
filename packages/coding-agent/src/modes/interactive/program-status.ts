import { stripVTControlCharacters } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { APP_NAME } from "../../config.js";

/**
 * The run status Prime reports to the terminal with OSC 7501, the Program Status
 * Protocol (https://mitchellh.com/writing/program-status-osc7501). Terminals such
 * as Tern show it on the tab and in their inbox; others ignore the sequence.
 */
export type RunStatus =
	| { readonly state: "idle" | "working" | "done" }
	| { readonly state: "blocked" | "error"; readonly msg?: string };

/** Removes the record, so none outlives the session. */
export const PROGRAM_STATUS_CLEAR = "\x1b]7501;state=clear\x1b\\";

/** The protocol's limit on decoded `msg` bytes. */
const MSG_MAX_BYTES = 2048;

/** The status a finished run leaves: its error, `idle` after an abort, or `done`. */
export function settledRunStatus(messages: readonly AgentMessage[]): RunStatus {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role !== "assistant") continue;
		if (message.stopReason === "aborted") return { state: "idle" };
		if (message.stopReason === "error") return { state: "error", msg: message.errorMessage };
		return { state: "done" };
	}
	return { state: "idle" };
}

/** A working run waits on the user while a dialog is open; other states stand. */
export function withOpenDialog(status: RunStatus, dialogTitle: string | undefined): RunStatus {
	if (status.state !== "working" || dialogTitle === undefined) return status;
	return { state: "blocked", msg: dialogTitle };
}

export function formatProgramStatus(status: RunStatus): string {
	let body = `state=${status.state}`;
	if (status.state === "blocked") body += ":kind=question";
	body += `:app=${APP_NAME}`;
	const msg = "msg" in status ? encodeMsg(status.msg) : undefined;
	if (msg) body += `:msg=${msg}`;
	return `\x1b]7501;${body}\x1b\\`;
}

/** Base64 of one control-free line within the byte limit; terminals drop reports that break either rule. */
function encodeMsg(text: string | undefined): string | undefined {
	const line = stripVTControlCharacters(text ?? "")
		.replace(/[\p{Cc}\s]+/gu, " ")
		.trim();
	let kept = "";
	let bytes = 0;
	for (const char of line) {
		bytes += Buffer.byteLength(char);
		if (bytes > MSG_MAX_BYTES) break;
		kept += char;
	}
	return kept ? Buffer.from(kept).toString("base64") : undefined;
}
