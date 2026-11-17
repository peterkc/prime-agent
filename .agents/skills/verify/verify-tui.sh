#!/usr/bin/env bash
# Start and drive this checkout's TUI in a scratch root. See SKILL.md.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SKILL_DIR/../../.." && pwd)"

usage() {
	cat >&2 <<'EOF'
usage: verify-tui.sh start [--repo DIR] [--cols N] [--rows N] [-- prime-agent args...]
       verify-tui.sh keys <tmux send-keys arguments...>
       verify-tui.sh type <text>
       verify-tui.sh screen
       verify-tui.sh wait <extended regex> [seconds]
       verify-tui.sh stop
start prints `export VERIFY_ROOT=...`; every other command needs that variable.
EOF
	exit 2
}

# Every command that signals or deletes checks that VERIFY_ROOT is a root that
# start made: the exact mktemp shape, a real directory we own, and a state file
# whose launch environment names this root's HOME.
need_root() {
	local root="${VERIFY_ROOT:-}"
	if [[ ! "$root" =~ ^/tmp/pv-[A-Za-z0-9]{6}$ || ! -d "$root" || -L "$root" || ! -O "$root" ]]; then
		echo "verify-tui: VERIFY_ROOT must be a /tmp/pv-XXXXXX root made by start" >&2
		exit 2
	fi
	if [[ ! -f "$root/state" ]] || ! grep -qF "HOME=$root/home " "$root/state"; then
		echo "verify-tui: $root has no valid state file; remove it by hand if start failed" >&2
		exit 2
	fi
}

tm() { tmux -S "$VERIFY_ROOT/tmux.sock" "$@"; }

cmd="${1:-}"
[[ -n "$cmd" ]] || usage
shift

case "$cmd" in
start)
	cols=120
	rows=40
	while [[ $# -gt 0 ]]; do
		case "$1" in
		--cols) [[ $# -ge 2 ]] || usage; cols="$2"; shift 2 ;;
		--rows) [[ $# -ge 2 ]] || usage; rows="$2"; shift 2 ;;
		--repo) [[ $# -ge 2 ]] || usage; REPO="$(cd "$2" && pwd)"; shift 2 ;;
		--) shift; break ;;
		*) usage ;;
		esac
	done
	[[ "$cols" =~ ^[0-9]+$ && "$rows" =~ ^[0-9]+$ ]] || usage
	# Flags that pick a working folder, a session or a daemon could reach live state.
	args=()
	while [[ $# -gt 0 ]]; do
		case "$1" in
		--cwd | --session-dir | --session | --daemon-socket | --socket | --resume | -r | --fork)
			echo "verify-tui: $1 is not allowed; a run uses only its scratch root" >&2
			exit 2
			;;
		-e | --extension)
			[[ $# -ge 2 ]] || usage
			# The TUI runs in <root>/work, so make extension paths absolute here.
			ext="$2"
			[[ "$ext" == /* ]] || ext="$PWD/$ext"
			args+=("$1" "$ext")
			shift 2
			;;
		*) args+=("$1"); shift ;;
		esac
	done
	[[ -x "$REPO/node_modules/.bin/tsx" ]] || { echo "run npm ci in $REPO first" >&2; exit 1; }
	command -v tmux >/dev/null || { echo "tmux is required" >&2; exit 1; }
	# A short root keeps the daemon socket path under the macOS 104-byte limit.
	VERIFY_ROOT="$(mktemp -d /tmp/pv-XXXXXX)"
	trap 'rm -rf "$VERIFY_ROOT"' ERR
	mkdir -p "$VERIFY_ROOT"/{home,agent,tmp,work}
	cat >"$VERIFY_ROOT/agent/settings.json" <<'EOF'
{
  "defaultProvider": "faux",
  "defaultModel": "faux",
  "onboardingShown": true,
  "agentTraces": { "enabled": false },
  "autoReload": "off"
}
EOF
	# The kernel venv installs from uv's shared caches and fails rather than download.
	uv_cache="$(uv cache dir 2>/dev/null || true)"
	uv_python="$(uv python dir 2>/dev/null || true)"
	launch=(env -i
		"HOME=$VERIFY_ROOT/home" "USER=${USER:-}" "LOGNAME=${LOGNAME:-${USER:-}}"
		"PATH=$PATH" "LANG=${LANG:-en_US.UTF-8}" "TERM=xterm-256color" "SHELL=/bin/bash"
		"TMPDIR=$VERIFY_ROOT/tmp"
		"PRIME_AGENT_CODING_AGENT_DIR=$VERIFY_ROOT/agent"
		"PRIME_AGENT_KERNEL_VENV=$VERIFY_ROOT/kernel-venv"
		"TSX_TSCONFIG_PATH=$REPO/tsconfig.json"
		"UV_OFFLINE=1"
		${uv_cache:+"UV_CACHE_DIR=$uv_cache"} ${uv_python:+"UV_PYTHON_INSTALL_DIR=$uv_python"}
		"PI_SKIP_VERSION_CHECK=1" "PI_OFFLINE=1")
	# The state file holds the exact launch environment and program; stop reuses it.
	printf '%q ' "${launch[@]}" "$REPO/prime-agent.sh" >"$VERIFY_ROOT/state"
	# Keep a crashed TUI on screen; csi-u keys follow packages/coding-agent/docs/tmux.md.
	printf '%s\n' 'set -g remain-on-exit on' 'set -g history-limit 5000' \
		'set -g extended-keys on' 'set -g extended-keys-format csi-u' >"$VERIFY_ROOT/tmux.conf"
	printf -v run '%q ' "$REPO/prime-agent.sh" --offline -e "$SKILL_DIR/faux-provider.ts" \
		--provider faux --model faux ${args[@]+"${args[@]}"}
	(cd "$VERIFY_ROOT/work" && "${launch[@]}" tmux -S "$VERIFY_ROOT/tmux.sock" -f "$VERIFY_ROOT/tmux.conf" \
		new-session -d -s verify -x "$cols" -y "$rows" "$run")
	trap - ERR
	echo "export VERIFY_ROOT=$VERIFY_ROOT"
	;;
keys)
	need_root
	tm send-keys -t verify "$@"
	;;
type)
	need_root
	tm send-keys -t verify -l -- "$*"
	;;
screen)
	need_root
	tm capture-pane -p -t verify
	;;
wait)
	need_root
	pattern="${1:?pattern required}"
	limit="${2:-20}"
	end=$((SECONDS + limit))
	while :; do
		if ! tm has-session -t verify 2>/dev/null; then
			echo "verify-tui: the tmux session is gone" >&2
			exit 1
		fi
		# Liveness first: after a crash, remain-on-exit keeps the old screen.
		if [[ "$(tm display-message -p -t verify '#{pane_dead}')" == 1 ]]; then
			echo "verify-tui: the TUI exited" >&2
			tm capture-pane -p -S - -t verify >&2
			exit 1
		fi
		screen="$(tm capture-pane -p -t verify)"
		if grep -Eq -- "$pattern" <<<"$screen"; then exit 0; fi
		if ((SECONDS >= end)); then
			echo "verify-tui: '$pattern' not on screen after ${limit}s" >&2
			printf '%s\n' "$screen" >&2
			exit 1
		fi
		sleep 0.2
	done
	;;
stop)
	need_root
	status=0
	tm kill-server 2>/dev/null || true
	# Stop the scratch daemon through its own launch environment, bounded to 20 s.
	state="$(<"$VERIFY_ROOT/state")"
	(cd "$VERIFY_ROOT/work" && eval "$state shutdown --force" </dev/null >"$VERIFY_ROOT/shutdown.log" 2>&1) &
	pid=$!
	for _ in $(seq 1 40); do
		kill -0 "$pid" 2>/dev/null || break
		sleep 0.5
	done
	if kill -0 "$pid" 2>/dev/null; then
		kill "$pid" 2>/dev/null || true
		echo "verify-tui: daemon shutdown did not finish in 20 s" >&2
		status=1
	elif ! wait "$pid"; then
		echo "verify-tui: daemon shutdown failed:" >&2
		cat "$VERIFY_ROOT/shutdown.log" >&2
		status=1
	fi
	# Then end leftover processes whose command line names this root, such as the
	# kernel and its installs. Processes that do not name it are not found here.
	for signal in TERM KILL; do
		pkill "-$signal" -f -- "$VERIFY_ROOT/" 2>/dev/null || true
		for _ in 1 2 3 4 5 6 7 8 9 10; do
			pgrep -f -- "$VERIFY_ROOT/" >/dev/null || break 2
			sleep 0.5
		done
	done
	rm -rf "$VERIFY_ROOT"
	echo "stopped; removed $VERIFY_ROOT"
	exit "$status"
	;;
*) usage ;;
esac
