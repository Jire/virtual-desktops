#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# SPDX-FileCopyrightText: 2026 Jire
#
# Installs, updates or removes the Virtual Desktops GNOME Shell extension for
# the current user. No root needed.
#
#   curl -fsSL https://raw.githubusercontent.com/Jire/virtual-desktops/main/install.sh | bash
#   wget -qO- https://raw.githubusercontent.com/Jire/virtual-desktops/main/install.sh | bash
#
# Options (append after "bash -s --"):
#   --uninstall        remove the extension (GNOME's own workspace settings
#                      come back)
#   --version vX       install a specific release instead of the latest
#   --zip FILE         install from a local zip (as built by scripts/build.sh)

set -euo pipefail

REPO="Jire/virtual-desktops"
UUID="virtual-desktops@jire.github.io"
NAME="Virtual Desktops"
SCHEMA="org.gnome.shell.extensions.virtual-desktops"
ZIP_NAME="$UUID.shell-extension.zip"
MIN_SHELL=46
EXT_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions"
EXT_DIR="$EXT_ROOT/$UUID"
# The optional hot-load script lives here (not in the extension itself).
HELPER_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/virtual-desktops"
RAW_URL="https://raw.githubusercontent.com/$REPO"

if [ -t 1 ]; then
    BOLD=$'\e[1m' GREEN=$'\e[32m' YELLOW=$'\e[33m' RED=$'\e[31m' RESET=$'\e[0m'
else
    BOLD='' GREEN='' YELLOW='' RED='' RESET=''
fi
info() { printf '%s==>%s %s\n' "$BOLD$GREEN" "$RESET" "$*"; }
warn() { printf '%swarning:%s %s\n' "$BOLD$YELLOW" "$RESET" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$BOLD$RED" "$RESET" "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

download() { # url dest
    if have curl; then
        curl -fsSL --retry 3 -o "$2" "$1"
    elif have wget; then
        wget -q -O "$2" "$1"
    else
        die "need curl or wget to download the extension"
    fi
}

extract() { # zip destdir
    if have unzip; then
        unzip -qo "$1" -d "$2"
    elif have bsdtar; then
        bsdtar -xf "$1" -C "$2"
    elif have python3; then
        python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$1" "$2"
    else
        die "need gnome-extensions, unzip, bsdtar or python3 to unpack the extension"
    fi
}

enabled_list() { gsettings get org.gnome.shell enabled-extensions 2>/dev/null || echo "[]"; }

enable_uuid() {
    # gnome-extensions enable talks to the running shell, which on Wayland
    # does not see newly installed extensions until the next login, so also
    # write the setting directly.
    gnome-extensions enable "$1" >/dev/null 2>&1 || true
    local current
    current=$(enabled_list)
    if [[ "$current" != *"'$1'"* ]]; then
        if [[ "$current" == "@as []" || "$current" == "[]" ]]; then
            gsettings set org.gnome.shell enabled-extensions "['$1']"
        else
            gsettings set org.gnome.shell enabled-extensions "${current%]}, '$1']"
        fi
    fi
}

disable_uuid() {
    gnome-extensions disable "$1" >/dev/null 2>&1 || true
    local current
    current=$(enabled_list)
    if [[ "$current" == *"'$1'"* ]]; then
        current=${current//", '$1'"/}
        current=${current//"'$1', "/}
        current=${current//"'$1'"/}
        gsettings set org.gnome.shell enabled-extensions "$current"
    fi
}

ext_setting() { # key
    gsettings --schemadir "$EXT_DIR/schemas" get "$SCHEMA" "$1" 2>/dev/null || true
}

# The extension puts GNOME's workspace settings back when it's turned off.
# If it couldn't (it wasn't running, or the shell refused), do it here.
restore_gnome_settings() {
    [ -f "$EXT_DIR/schemas/gschemas.compiled" ] || return 0
    local restored=0 number
    if [ "$(ext_setting saved-dynamic-workspaces)" = "'true'" ]; then
        gsettings set org.gnome.mutter dynamic-workspaces true
        number=$(ext_setting saved-num-workspaces)
        if [[ "$number" =~ ^[0-9]+$ ]] && [ "$number" -gt 0 ]; then
            gsettings set org.gnome.desktop.wm.preferences num-workspaces "$number"
        fi
        gsettings --schemadir "$EXT_DIR/schemas" reset "$SCHEMA" saved-dynamic-workspaces
        gsettings --schemadir "$EXT_DIR/schemas" reset "$SCHEMA" saved-num-workspaces
        restored=1
    fi
    if [ "$(ext_setting saved-workspaces-only-on-primary)" = "'true'" ]; then
        gsettings set org.gnome.mutter workspaces-only-on-primary true
        gsettings --schemadir "$EXT_DIR/schemas" reset "$SCHEMA" saved-workspaces-only-on-primary
        restored=1
    fi
    if [ "$restored" -eq 1 ]; then
        echo "  Put GNOME's own workspace settings back."
    fi
    return 0
}

reload_hint() {
    if [ "${XDG_SESSION_TYPE:-}" = "x11" ]; then
        echo "  Restart GNOME Shell to load it: press Alt+F2, type r, press Enter."
    else
        echo "  Log out and back in to load it (GNOME on Wayland only loads new extensions at login)."
        echo "  To load it right now instead, see \"Load without logging out\" in the README."
    fi
}

install_helper() {
    local ref="main" here
    [ "$VERSION" = latest ] || ref="$VERSION"
    here=$(dirname "${BASH_SOURCE[0]:-.}")
    mkdir -p "$HELPER_DIR"
    if [ -n "$LOCAL_ZIP" ] && [ -f "$here/scripts/hot-load.js" ]; then
        cp "$here/scripts/hot-load.js" "$HELPER_DIR/hot-load.js"
    elif ! download "$RAW_URL/$ref/scripts/hot-load.js" "$HELPER_DIR/hot-load.js"; then
        warn "couldn't download the optional reload helper; everything else is installed"
    fi
}

uninstall() {
    disable_uuid "$UUID"
    # Give the running shell a moment to turn it off (that restores GNOME's
    # settings), then make sure they're back either way.
    sleep 1
    restore_gnome_settings
    if have gnome-extensions && gnome-extensions uninstall "$UUID" >/dev/null 2>&1; then
        :
    fi
    rm -rf "$EXT_DIR" "$HELPER_DIR"
    info "Removed $UUID."
    echo "  GNOME's own workspaces are back: dynamic workspaces and its display setting, as you had them."
    echo "  Your desktops and windows stay where they are."
    exit 0
}

# ---------------------------------------------------------------------------

VERSION="latest"
LOCAL_ZIP=""
ACTION=""
while [ $# -gt 0 ]; do
    case "$1" in
        --uninstall) ACTION=uninstall ;;
        --version) VERSION="${2:?--version needs a tag, e.g. v1}"; shift ;;
        --zip) LOCAL_ZIP="${2:?--zip needs a file}"; shift ;;
        -h|--help)
            cat <<'USAGE'
Usage: install.sh [--uninstall] [--version vX] [--zip FILE]
  (no options)       install or update to the latest release
  --uninstall        remove the extension (GNOME's own workspace settings come back)
  --version vX       install a specific release tag
  --zip FILE         install from a local zip built by scripts/build.sh
USAGE
            exit 0 ;;
        *) die "unknown option: $1" ;;
    esac
    shift
done

[ "$(id -u)" -ne 0 ] || die "run this as your normal user, not with sudo (it installs into your home folder)"
have gsettings || die "gsettings not found; is this a GNOME desktop?"

if [ -n "$ACTION" ]; then
    uninstall
fi

shell_major=""
if have gnome-shell; then
    shell_major=$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -n1 || true)
    if [ -n "$shell_major" ] && [ "$shell_major" -lt "$MIN_SHELL" ]; then
        die "GNOME Shell $shell_major is too old; version $MIN_SHELL or newer is required"
    fi
else
    warn "gnome-shell not found on PATH; installing anyway"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if [ -n "$LOCAL_ZIP" ]; then
    cp "$LOCAL_ZIP" "$tmp/$ZIP_NAME"
else
    if [ "$VERSION" = latest ]; then
        url="https://github.com/$REPO/releases/latest/download/$ZIP_NAME"
    else
        url="https://github.com/$REPO/releases/download/$VERSION/$ZIP_NAME"
    fi
    info "Downloading $url"
    download "$url" "$tmp/$ZIP_NAME" || die "download failed"
fi

was_installed=0
[ -d "$EXT_DIR" ] && was_installed=1

if have gnome-extensions && gnome-extensions install --force "$tmp/$ZIP_NAME" 2>/dev/null; then
    :
else
    rm -rf "$EXT_DIR"
    mkdir -p "$EXT_DIR"
    extract "$tmp/$ZIP_NAME" "$EXT_DIR"
fi
[ -f "$EXT_DIR/metadata.json" ] || die "install failed: $EXT_DIR/metadata.json is missing"

# gnome-extensions compiles the settings schema itself; a plain unzip doesn't.
if [ ! -f "$EXT_DIR/schemas/gschemas.compiled" ]; then
    have glib-compile-schemas || die "glib-compile-schemas not found; install your distro's glib2 tools and run this again"
    glib-compile-schemas "$EXT_DIR/schemas"
fi

enable_uuid "$UUID"
install_helper

if [ "$(gsettings get org.gnome.shell disable-user-extensions 2>/dev/null)" = "true" ]; then
    warn "user extensions are switched off on this system. Turn them on in the Extensions app,"
    warn "or run: gsettings set org.gnome.shell disable-user-extensions false"
fi

if [ -n "$shell_major" ] && ! grep -q "\"$shell_major\"" "$EXT_DIR/metadata.json"; then
    warn "this release isn't marked as supporting GNOME $shell_major yet, so GNOME may refuse to load it."
    warn "Check https://github.com/$REPO/releases for a newer one."
fi

if [ "$was_installed" -eq 1 ]; then
    info "Updated $NAME in $EXT_DIR"
else
    info "Installed $NAME to $EXT_DIR"
fi
reload_hint
echo "  Then press Super + Ctrl + D for a new desktop, Super + Ctrl + ← / → to switch,"
echo "  and Super + Ctrl + F4 to close one, just like on Windows."
echo "  Settings: open the Extensions app, or run: gnome-extensions prefs $UUID"
echo
echo "  Enjoying it? Star the repo and follow @Jire on GitHub for more free tools:"
echo "    https://github.com/$REPO"
