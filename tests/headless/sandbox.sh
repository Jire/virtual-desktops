#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# SPDX-FileCopyrightText: 2026 Jire
#
# An older GNOME Shell for the headless tests, without root: installs that
# GNOME release from an Arch Linux Archive snapshot into DIR/gnome-VERSION and
# prints a command that runs its gnome-shell in bubblewrap (software
# rendering, no /dev/dri), ready for VDESK_SHELL:
#
#   VDESK_SHELL="$(tests/headless/sandbox.sh 46 ~/gnome-sandboxes)" tests/headless/run.sh
#
# Needs pacman, unshare and bwrap (bubblewrap); about 1.5 GB per version.
set -euo pipefail

version=${1:?GNOME version: 46, 47, 48, 49 or 50}
dir=${2:?a folder for the sandboxes}
case "$version" in
46) date=2024/06/15 ;;
47) date=2024/11/20 ;;
48) date=2025/06/15 ;;
49) date=2025/11/20 ;;
50) date=2026/05/20 ;;
*) echo "no snapshot date known for GNOME $version" >&2; exit 2 ;;
esac

mkdir -p "$dir"
dir=$(cd "$dir" && pwd)
root="$dir/gnome-$version"

if [ ! -x "$root/usr/bin/gnome-shell" ]; then
    mkdir -p "$root/var/lib/pacman" "$dir/pkg-cache"
    cat > "$dir/pacman-$version.conf" <<CONF
[options]
Architecture = x86_64
SigLevel = Never
DisableSandbox

[core]
Server = https://archive.archlinux.org/repos/$date/\$repo/os/\$arch

[extra]
Server = https://archive.archlinux.org/repos/$date/\$repo/os/\$arch
CONF
    unshare -r -- pacman -Sy --root "$root" --dbpath "$root/var/lib/pacman" \
        --config "$dir/pacman-$version.conf" --cachedir "$dir/pkg-cache" --noconfirm --noprogressbar \
        gnome-shell gjs gtk4 libadwaita mesa dbus adwaita-icon-theme ttf-dejavu >&2
    # Compile the settings schemas in case the install hooks couldn't.
    "$root/usr/bin/glib-compile-schemas" "$root/usr/share/glib-2.0/schemas" 2>/dev/null ||
        glib-compile-schemas "$root/usr/share/glib-2.0/schemas"
fi

# The sandbox sees its own /usr and /etc, plus the host's /tmp, home folder,
# users and system bus (GNOME 46 won't start without one).
echo "bwrap --die-with-parent" \
    "--bind $root/usr /usr --symlink usr/lib /lib --symlink usr/lib /lib64 --symlink usr/bin /bin --symlink usr/bin /sbin" \
    "--ro-bind $root/etc /etc --ro-bind /etc/passwd /etc/passwd --ro-bind /etc/group /etc/group" \
    "--ro-bind /etc/machine-id /etc/machine-id --bind $root/var /var" \
    "--proc /proc --dev /dev --ro-bind /sys /sys --bind /tmp /tmp --bind $HOME $HOME --ro-bind /run/dbus /run/dbus" \
    "/usr/bin/gnome-shell"
