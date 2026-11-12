#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# SPDX-FileCopyrightText: 2026 Jire
#
# Runs tests/headless/scenarios.js in a separate, headless GNOME Shell with the
# freshly built extension, and prints the results. See lib.sh for how the test
# shell is kept apart from your own session.
#
#   tests/headless/run.sh [NAME-FILTER]
#
#   VDESK_TEST_DIR=dir   keep the test files (report.json, shell.log, shots/) there
#   VDESK_SHOTS=1        save screenshots of the interesting moments in shots/
#   VDESK_MONITORS="1920x1080 1280x1024"   virtual monitors (default: these two)
#   VDESK_SHELL="cmd"    run another gnome-shell, e.g. inside a GNOME 46 sandbox
set -euo pipefail
cd "$(dirname "$0")/../.."
# shellcheck source=tests/headless/lib.sh
. tests/headless/lib.sh

FILTER=${1:-}
T=${VDESK_TEST_DIR:-$(mktemp -d)}
T=$(cd "$T" && pwd)
UNIT="vdesk-test-$$"
read -r -a MONITORS <<< "${VDESK_MONITORS:-1920x1080 1280x1024}"

# shellcheck disable=SC2317,SC2329 # used by the trap below
cleanup() { vdesk_stop "$T" "$UNIT"; }
trap cleanup EXIT

vdesk_install "$T"
echo "==> Starting a headless GNOME Shell (${MONITORS[*]}) in $T"
vdesk_start "$T" "$UNIT" "${MONITORS[@]}"
vdesk_wait "$T"

shots=""
[ "${VDESK_SHOTS:-0}" = 1 ] && shots="$T/shots"
config=$(python3 -c 'import json, sys; print(json.dumps(dict(zip(["report", "shots", "windowScript", "filter", "hotLoad"], sys.argv[1:]))))' \
    "$T/report.json" "$shots" "$PWD/tests/headless/window.js" "$FILTER" "$PWD/scripts/hot-load.js")
script=$(sed "s|__CONFIG__|$config|" tests/headless/scenarios.js)

echo "==> Running scenarios${FILTER:+ matching \"$FILTER\"}"
rm -f "$T/report.json"
vdesk_eval "$T" "$script" 900 > "$T/eval.out" || true
if [ ! -s "$T/report.json" ]; then
    echo "error: no report; Eval said: $(cat "$T/eval.out")" >&2
    exit 1
fi

status=0
python3 - "$T/report.json" <<'PY' || status=$?
import json, sys
report = json.load(open(sys.argv[1]))
print(f"    GNOME Shell {report['shell']}")
failed = 0
last = None
for r in report["results"]:
    if r["scenario"] != last:
        print(f"\n  {r['scenario']}")
        last = r["scenario"]
    if r.get("timing"):
        print(f"      ({r['detail']})")
        continue
    mark = "✔" if r["ok"] else "✘"
    detail = "" if r["ok"] or not r["detail"] else f"  [{r['detail']}]"
    print(f"    {mark} {r['name']}{detail}")
    failed += 0 if r["ok"] else 1
total = sum(1 for r in report["results"] if not r.get("timing"))
print(f"\n==> {total - failed}/{total} checks passed")
sys.exit(1 if failed else 0)
PY

echo "==> Errors in the shell log mentioning the extension:"
grep -n -i -E "virtual-desktops|JS ERROR|TypeError|ReferenceError" "$T/shell.log" |
    grep -v -E "\[virtual-desktops\] (enabled|disabled|Shortcuts|Desktop|New|Clos|Already|GNOME|Keeping)" | head -40 || true
echo "    (full log: $T/shell.log)"
exit $status
