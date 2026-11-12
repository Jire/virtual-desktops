#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# SPDX-FileCopyrightText: 2026 Jire
#
# A headless test GNOME Shell to poke at by hand (see lib.sh for how it's kept
# apart from your own session):
#
#   tests/headless/session.sh start DIR [MONITOR...]   start it (default 1920x1080)
#   tests/headless/session.sh eval DIR 'JS'            run JavaScript in it
#   tests/headless/session.sh eval-file DIR FILE       … from a file
#   tests/headless/session.sh shot DIR FILE.png        screenshot
#   tests/headless/session.sh run DIR CMD…             start an app in it
#   tests/headless/session.sh stop DIR                 stop it
set -euo pipefail
cd "$(dirname "$0")/../.."
# shellcheck source=tests/headless/lib.sh
. tests/headless/lib.sh

cmd=${1:?usage: session.sh start|eval|eval-file|shot|run|stop DIR …}
T=${2:?a folder for the test session}
mkdir -p "$T"
T=$(cd "$T" && pwd)
shift 2

case "$cmd" in
start)
    vdesk_install "$T"
    unit="vdesk-session-$RANDOM"
    echo "$unit" > "$T/unit"
    [ $# -gt 0 ] || set -- 1920x1080
    vdesk_start "$T" "$unit" "$@"
    vdesk_wait "$T"
    echo "started ($unit); log: $T/shell.log"
    ;;
eval)
    vdesk_eval "$T" "$1" "${2:-120}"
    ;;
eval-file)
    vdesk_eval "$T" "$(cat "$1")" "${2:-120}"
    ;;
shot)
    out=$(realpath -m "$1")
    vdesk_eval "$T" "new Promise(r => { const f = Gio.File.new_for_path('$out'); const s = f.replace(null, false, 0, null); new Shell.Screenshot().screenshot(false, s, (o, res) => { o.screenshot_finish(res); s.close(null); r('$out'); }); })"
    ;;
run)
    rt=$(cat "$T/runtime")
    env -u DISPLAY HOME="$T/home" XDG_CONFIG_HOME="$T/config" XDG_DATA_HOME="$T/data" \
        XDG_STATE_HOME="$T/state" XDG_CACHE_HOME="$T/cache" XDG_RUNTIME_DIR="$rt" \
        GSETTINGS_BACKEND=keyfile DBUS_SESSION_BUS_ADDRESS="$(cat "$T/bus")" \
        WAYLAND_DISPLAY="$(cat "$T/display")" "$@" &
    ;;
stop)
    vdesk_stop "$T" "$(cat "$T/unit" 2>/dev/null || echo none)"
    echo stopped
    ;;
*)
    echo "unknown command: $cmd" >&2
    exit 2
    ;;
esac
