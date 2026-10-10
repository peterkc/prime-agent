import assert from "node:assert/strict";
import { test } from "node:test";
import { desktopNotificationArgs, hasLinuxDesktopSession } from "../src/desktop-notify.js";

test("Linux desktop fallback requires a session bus and respects its opt-out", () => {
	const bus = { DBUS_SESSION_BUS_ADDRESS: "unix:path=/bus" };
	assert.equal(hasLinuxDesktopSession("linux", bus), true);
	assert.equal(hasLinuxDesktopSession("darwin", bus), false);
	assert.equal(hasLinuxDesktopSession("linux", { ...bus, PI_NO_DESKTOP_NOTIFY: "1" }), false);
	assert.equal(hasLinuxDesktopSession("linux", {}), false);
});
test("desktop delivery uses libnotify first or the freedesktop gdbus signature", () => {
	const notification = { title: "--help", body: "Waiting for input", urgency: "critical" } as const;
	const libnotify = "--app-name|Prime|--urgency=critical|--expire-time=5000|--|--help|Waiting for input";
	assert.deepEqual(desktopNotificationArgs("notify-send", notification), libnotify.split("|"));
	const method = "org.freedesktop.Notifications.Notify";
	const gdbus = [
		"call|--session|--dest|org.freedesktop.Notifications|--object-path|/org/freedesktop/Notifications|--method",
		`${method}|--|Prime|0||--help|Waiting for input|[]|{"urgency": <byte 2>}|5000`,
	].join("|");
	assert.deepEqual(desktopNotificationArgs("gdbus", notification), gdbus.split("|"));
});
