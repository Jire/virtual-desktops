// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// Test-only. Turns on unsafe mode so the headless test session accepts
// org.gnome.Shell.Eval and Screenshot calls. Only ever installed into the
// throwaway data directory tests/headless/run.sh creates.

export default class TestHelper {
    enable() {
        global.context.unsafe_mode = true;
    }

    disable() {
        global.context.unsafe_mode = false;
    }
}
