import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join, posix } from "node:path";
import type { TerminalNotification } from "./terminal-notify.js";

type DesktopNotifier = "notify-send" | "gdbus";
let cachedNotifier: { readonly command: string; readonly kind: DesktopNotifier } | null | undefined;

function resolveNotifier(env: NodeJS.ProcessEnv): typeof cachedNotifier {
	if (cachedNotifier !== undefined) return cachedNotifier;
	for (const kind of ["notify-send", "gdbus"] as const) {
		for (const directory of (env.PATH ?? "").split(delimiter)) {
			if (!directory) continue;
			const command = join(directory, kind);
			try {
				accessSync(command, constants.X_OK);
				cachedNotifier = { command, kind };
				return cachedNotifier;
			} catch {
				// Try the next PATH entry or notifier.
			}
		}
	}
	cachedNotifier = null;
	return null;
}

export function hasLinuxDesktopSession(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
	return (
		platform === "linux" &&
		env.PI_NO_DESKTOP_NOTIFY !== "1" &&
		Boolean(
			env.DBUS_SESSION_BUS_ADDRESS || (env.XDG_RUNTIME_DIR && existsSync(posix.join(env.XDG_RUNTIME_DIR, "bus"))),
		)
	);
}

export function desktopNotificationArgs(kind: DesktopNotifier, notification: TerminalNotification): string[] {
	const urgency = notification.urgency ?? "normal";
	const title = notification.title.trim() || "Prime";
	if (kind === "notify-send") {
		return ["--app-name", "Prime", `--urgency=${urgency}`, "--expire-time=5000", "--", title, notification.body];
	}
	return [
		"call",
		"--session",
		"--dest",
		"org.freedesktop.Notifications",
		"--object-path",
		"/org/freedesktop/Notifications",
		"--method",
		"org.freedesktop.Notifications.Notify",
		"Prime",
		"0",
		"",
		title,
		notification.body,
		"[]",
		`{"urgency": <byte ${{ low: 0, normal: 1, critical: 2 }[urgency]}>}`,
		"5000",
	];
}

export function sendDesktopNotification(notification: TerminalNotification, env: NodeJS.ProcessEnv): void {
	if (!hasLinuxDesktopSession(process.platform, env)) return;
	const notifier = resolveNotifier(env);
	if (!notifier) return;
	try {
		const child = spawn(notifier.command, desktopNotificationArgs(notifier.kind, notification), {
			env,
			stdio: "ignore",
		});
		child.once("error", () => {}); // Best-effort desktop delivery must not crash the terminal client.
		child.unref();
	} catch {
		// BEL was already delivered; desktop delivery is optional.
	}
}
