#!/usr/bin/env bash
# Start and drive this checkout's TUI in a scratch home. See SKILL.md.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SKILL_DIR/../../.." && pwd)"

usage() {
	cat <<'EOF'
usage: verify-tui.sh start [--repo DIR] [--cols N] [--rows N] [-- prime-agent args...]
       verify-tui.sh keys <tmux send-keys arguments...>
       verify-tui.sh type <text>
       verify-tui.sh screen
       verify-tui.sh wait <extended regex> [seconds]
       verify-tui.sh stop
After start, export the printed VERIFY_ROOT for the other commands.
EOF
	exit 2
}

need_root() {
	[[ -n "${VERIFY_ROOT:-}" && -f "$VERIFY_ROOT/.verify-tui" ]] || {
		echo "VERIFY_ROOT is not a verify-tui scratch root; run start first" >&2
		exit 2
	}
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
		--cols) cols="$2"; shift 2 ;;
		--rows) rows="$2"; shift 2 ;;
		--repo) REPO="$(cd "$2" && pwd)"; shift 2 ;;
		--) shift; break ;;
		*) usage ;;
		esac
	done
	[[ -x "$REPO/node_modules/.bin/tsx" ]] || { echo "run npm ci in $REPO first" >&2; exit 1; }
	command -v tmux >/dev/null || { echo "tmux is required" >&2; exit 1; }
	# A short root keeps the daemon socket path under the macOS 104-byte limit.
	VERIFY_ROOT="$(mktemp -d /tmp/pv-XXXXXX)"
	mkdir -p "$VERIFY_ROOT"/{home,agent,tmp,work}
	touch "$VERIFY_ROOT/.verify-tui"
	cat >"$VERIFY_ROOT/agent/settings.json" <<'EOF'
{
  "defaultProvider": "faux",
  "defaultModel": "faux",
  "onboardingShown": true,
  "agentTraces": { "enabled": false },
  "autoReload": "off"
}
EOF
	# Share uv's download caches so the scratch kernel venv builds offline and fast.
	uv_cache="$(uv cache dir 2>/dev/null || true)"
	uv_python="$(uv python dir 2>/dev/null || true)"
	launch=(env -i
		"HOME=$VERIFY_ROOT/home" "USER=${USER:-}" "LOGNAME=${LOGNAME:-${USER:-}}"
		"PATH=$PATH" "LANG=${LANG:-en_US.UTF-8}" "TERM=xterm-256color" "SHELL=/bin/bash"
		"TMPDIR=$VERIFY_ROOT/tmp"
		"PRIME_AGENT_CODING_AGENT_DIR=$VERIFY_ROOT/agent"
		"PRIME_AGENT_KERNEL_VENV=$VERIFY_ROOT/kernel-venv"
		"TSX_TSCONFIG_PATH=$REPO/tsconfig.json"
		${uv_cache:+"UV_CACHE_DIR=$uv_cache"} ${uv_python:+"UV_PYTHON_INSTALL_DIR=$uv_python"}
		"PI_SKIP_VERSION_CHECK=1" "PI_OFFLINE=1")
	# Keep a crashed TUI on screen; csi-u keys follow docs/tmux.md.
	printf '%s\n' 'set -g remain-on-exit on' 'set -g extended-keys on' 'set -g extended-keys-format csi-u' \
		>"$VERIFY_ROOT/tmux.conf"
	printf -v run '%q ' "$REPO/prime-agent.sh" --offline -e "$SKILL_DIR/faux-provider.ts" \
		--provider faux --model faux "$@"
	(cd "$VERIFY_ROOT/work" && "${launch[@]}" tmux -S "$VERIFY_ROOT/tmux.sock" -f "$VERIFY_ROOT/tmux.conf" \
		new-session -d -s verify -x "$cols" -y "$rows" "$run")
	printf '%q ' "${launch[@]}" >"$VERIFY_ROOT/env"
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
	while ((SECONDS < end)); do
		if tm capture-pane -p -t verify | grep -Eq -- "$pattern"; then exit 0; fi
		if [[ "$(tm display-message -p -t verify '#{pane_dead}')" == 1 ]]; then
			echo "verify-tui: the TUI exited" >&2
			break
		fi
		sleep 0.2
	done
	((SECONDS < end)) || echo "verify-tui: '$pattern' not on screen after ${limit}s" >&2
	tm capture-pane -p -t verify >&2
	exit 1
	;;
stop)
	need_root
	tm kill-server 2>/dev/null || true
	# Stop the scratch daemon this run started; it never touches the shared daemons.
	(cd "$VERIFY_ROOT/work" && eval "$(cat "$VERIFY_ROOT/env")" "$REPO/prime-agent.sh" shutdown) >/dev/null 2>&1 || true
	# The kernel and its installs can outlive the daemon; the unique root path names only this run's processes.
	for signal in TERM KILL; do
		pkill "-$signal" -f -- "$VERIFY_ROOT/" 2>/dev/null || true
		for _ in 1 2 3 4 5 6 7 8 9 10; do
			pgrep -f -- "$VERIFY_ROOT/" >/dev/null || break 2
			sleep 0.5
		done
	done
	rm -rf "$VERIFY_ROOT"
	echo "stopped; removed $VERIFY_ROOT"
	;;
*) usage ;;
esac
