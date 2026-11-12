# SPDX-License-Identifier: GPL-2.0-or-later
# SPDX-FileCopyrightText: 2026 Jire
# shellcheck shell=bash
# shellcheck disable=SC2317 # a library: run.sh and session.sh call these
#
# Starting and talking to a separate, headless GNOME Shell for tests. Sourced
# by run.sh and session.sh. Your own session is never touched: the test shell
# gets its own D-Bus, its own settings (GSETTINGS_BACKEND=keyfile), its own
# HOME, XDG folders and runtime folder, all under $T, and runs in a transient
# systemd scope that is stopped as a whole.

UUID=virtual-desktops@jire.github.io

# vdesk_install T: build the extension and install it (plus the test helper
# that turns on unsafe mode for Eval) into T's data folder, with settings.
vdesk_install() {
    local t=$1 zip ext
    rm -rf "${t:?}"/{home,config,data,state,cache}
    mkdir -p "$t"/{home,config,data,state,cache,shots}
    zip=$(scripts/build.sh)
    ext="$t/data/gnome-shell/extensions/$UUID"
    mkdir -p "$ext"
    python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$zip" "$ext"
    glib-compile-schemas "$ext/schemas"
    cp -r tests/headless/helper@vdesk-test "$t/data/gnome-shell/extensions/"

    mkdir -p "$t/config/glib-2.0/settings"
    cat > "$t/config/glib-2.0/settings/keyfile" <<KEYFILE
[org/gnome/shell]
enabled-extensions=['helper@vdesk-test', '$UUID']
disable-user-extensions=false
welcome-dialog-last-shown-version='999'

[org/gnome/desktop/interface]
enable-hot-corners=false
enable-animations=true
${VDESK_KEYFILE_EXTRA:-}
KEYFILE
}

# vdesk_start T UNIT MONITOR...: start the shell in the background. Writes
# the bus address to T/bus and the runtime folder to T/runtime.
vdesk_start() {
    local t=$1 unit=$2 rt shell_cmd monitor_args=()
    shift 2
    for m in "$@"; do monitor_args+=(--virtual-monitor "$m"); done
    read -r -a shell_cmd <<< "${VDESK_SHELL:-gnome-shell}"
    # Kept short: Unix socket paths are limited to 108 bytes.
    rt=$(mktemp -d "${VDESK_RUNTIME_PARENT:-/tmp}/vdrt.XXXXXX")
    chmod 700 "$rt"
    echo "$rt" > "$t/runtime"
    echo "vdesk-${unit##*-}" > "$t/display"
    rm -f "$t/bus"

    # Export the isolated environment *before* the bus starts: D-Bus
    # activated helpers inherit the bus daemon's environment, not the shell's.
    # shellcheck disable=SC2016 # $DBUS_SESSION_BUS_ADDRESS is expanded by the inner bash
    systemd-run --user --scope --quiet --unit="$unit" --collect \
        env -u DBUS_SESSION_BUS_ADDRESS -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_ID \
            HOME="$t/home" XDG_CONFIG_HOME="$t/config" XDG_DATA_HOME="$t/data" \
            XDG_STATE_HOME="$t/state" XDG_CACHE_HOME="$t/cache" XDG_RUNTIME_DIR="$rt" \
            GSETTINGS_BACKEND=keyfile NO_AT_BRIDGE=1 GTK_A11Y=none \
        dbus-run-session -- bash -c 'echo "$DBUS_SESSION_BUS_ADDRESS" > "$1/bus"; shift; exec "$@"' _ "$t" \
            "${shell_cmd[@]}" --headless --wayland --no-x11 --wayland-display "$(cat "$t/display")" \
            "${monitor_args[@]}" --force-animations \
        > "$t/shell.log" 2>&1 &
}

# vdesk_eval T CODE [TIMEOUT]: run JavaScript in the test shell.
vdesk_eval() {
    # gdbus reads arguments as GVariant text (a bare one gets quoted and its
    # backslash escapes processed), so hand it a properly escaped string.
    local literal
    literal=$(python3 -c 'import json, sys; print(json.dumps(sys.argv[1], ensure_ascii=False))' "$2")
    gdbus call --address "$(cat "$1/bus")" --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$literal" --timeout "${3:-30}"
}

# vdesk_wait T: wait until the shell is up and the extension is active.
vdesk_wait() {
    local t=$1
    for _ in $(seq 1 150); do
        if [ -s "$t/bus" ] &&
            vdesk_eval "$t" 'Main.extensionManager.lookup("'"$UUID"'")?.state' 2>/dev/null | grep -q "(true, '1')"; then
            sleep 2 # let the session settle (startup animation, first frame)
            # GNOME opens the overview at login; start from the plain desktop.
            vdesk_eval "$t" 'Main.overview.hide(); "ok"' >/dev/null
            sleep 1
            return 0
        fi
        sleep 0.2
    done
    echo "error: the test shell didn't come up; see $t/shell.log" >&2
    tail -30 "$t/shell.log" >&2
    return 1
}

# vdesk_stop T UNIT: stop the shell and everything it started.
vdesk_stop() {
    systemctl --user stop "$2.scope" >/dev/null 2>&1 || true
    [ -f "$1/runtime" ] && rm -rf "$(cat "$1/runtime")"
    rm -f "$1/runtime" "$1/bus" "$1/display"
}
