#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# SPDX-FileCopyrightText: 2026 Jire
#
# Records docs/demo.gif in a headless GNOME Shell with real apps (Files, Text
# Editor, System Monitor) and the freshly built extension. Needs ffmpeg.
#
#   tests/headless/demo.sh [OUTPUT.gif]
#
# Screenshots take a while in a software-rendered shell, so animations are
# slowed down by VDESK_DEMO_FACTOR (default 15) while frames are captured,
# and the frames are played back at their real speed.
set -euo pipefail
cd "$(dirname "$0")/../.."
# shellcheck source=tests/headless/lib.sh
. tests/headless/lib.sh

OUT=$(realpath -m "${1:-docs/demo.gif}")
FACTOR=${VDESK_DEMO_FACTOR:-15}
T=${VDESK_TEST_DIR:-$(mktemp -d)}
T=$(cd "$T" && pwd)
UNIT="vdesk-demo-$$"

# shellcheck disable=SC2317,SC2329 # used by the trap below
cleanup() { vdesk_stop "$T" "$UNIT"; }
trap cleanup EXIT

VDESK_KEYFILE_EXTRA="color-scheme='prefer-dark'
[org/gnome/desktop/notifications]
show-banners=false" vdesk_install "$T"

# A home folder that looks lived in, with a git project for the terminal.
mkdir -p "$T/home"/{Documents,Downloads,Music,Pictures,Projects,Videos}
printf '%s\n' "PROMPT='%F{green}sam@laptop%f %F{blue}%~%f %# '" > "$T/home/.zshrc"
printf '%s\n' "PS1='\[\e[32m\]sam@laptop\[\e[0m\] \[\e[34m\]\w\[\e[0m\] \$ '" > "$T/home/.bashrc"
(
    cd "$T/home/Projects" && git init -q -b main website && cd website &&
        git config user.name 'Sam' && git config user.email 'sam@example.com' &&
        for msg in 'First page' 'Add the photo gallery' 'Dark mode' 'Fix the menu on phones' 'Contact form'; do
            echo "$msg" >> notes.txt && git add notes.txt && git commit -q -m "$msg"
        done
)
cat > "$T/home/Documents/Plans.md" <<'MD'
# This week

- Finish the slides for Thursday
- Book the train to Lisbon
- Reply to Sam about the cabin

## Desktops

1. Work: mail, notes, files
2. Monitoring: the build server
3. A fresh one, whenever I need it
MD

vdesk_start "$T" "$UNIT" 1920x1080
vdesk_wait "$T"
rm -rf "$T/frames" && mkdir -p "$T/frames"

config=$(python3 -c 'import json, sys; print(json.dumps({"out": sys.argv[1], "home": sys.argv[2], "factor": int(sys.argv[3])}))' \
    "$T/frames" "$T/home" "$FACTOR")
script=$(sed "s|__CONFIG__|$config|" tests/headless/demo.js)
echo "==> Recording (this takes a few minutes)"
vdesk_eval "$T" "$script" 1200

echo "==> Making $OUT"
python3 - "$T/frames/frames.txt" "$FACTOR" "$T/frames/list.txt" <<'PY'
import sys
frames = [line.split() for line in open(sys.argv[1]) if line.strip()]
factor = float(sys.argv[2])
with open(sys.argv[3], "w") as out:
    for (path, t), (_, t_next) in zip(frames, frames[1:]):
        out.write(f"file '{path}'\nduration {(int(t_next) - int(t)) / factor / 1e6:.4f}\n")
    out.write(f"file '{frames[-1][0]}'\nduration 0.5\nfile '{frames[-1][0]}'\n")
PY
mkdir -p "$(dirname "$OUT")"
ffmpeg -loglevel error -y -f concat -safe 0 -i "$T/frames/list.txt" \
    -vf "fps=25,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
    -loop 0 "$OUT"
rm -rf "$T/frames"
ls -la "$OUT"
