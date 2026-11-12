// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// Unit tests for the parts that don't need a running GNOME Shell:
//
//   gjs -m tests/unit.test.js
//
// The behaviour in the Shell itself is covered by tests/headless/run.sh.

import 'gi://Gtk?version=4.0';
import 'gi://Gdk?version=4.0';
import Gdk from 'gi://Gdk';
import System from 'system';

import * as Accel from '../extension/accelerators.js';
import {defaultName, namesWith, namesWithout, trimNames} from '../extension/names.js';

let failures = 0;
let count = 0;

function eq(actual, expected, what) {
    count++;
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) {
        print(`  ✔ ${what}`);
    } else {
        failures++;
        print(`  ✘ ${what}\n      expected ${e}\n      got      ${a}`);
    }
}

print('Desktop names');
eq(defaultName(0), 'Desktop 1', 'default names count from 1');
eq(trimNames(['Work', '', '  ', '']), ['Work'], 'trailing empty names are dropped');
eq(trimNames([' Work ', '', 'Music']), ['Work', '', 'Music'], 'names are trimmed, gaps kept');
eq(namesWithout(['Work', 'Games', '', 'Music'], 1), ['Work', '', 'Music'],
    'closing a desktop moves the later names down');
eq(namesWithout(['Work', 'Games'], 1), ['Work'], 'closing the last named desktop');
eq(namesWithout(['Work'], 3), ['Work'], 'closing an unnamed desktop past the list changes nothing');
eq(namesWithout(['', 'Games', ''], 0), ['Games'], 'closing the first desktop');
eq(namesWith([], 2, 'Music'), ['', '', 'Music'], 'naming a later desktop pads the list');
eq(namesWith(['Work', 'Games'], 1, ''), ['Work'], 'clearing a name gives back the default');
eq(namesWith(['Work'], 0, '  Play  '), ['Play'], 'renaming trims');

print('Shortcuts');
eq(Accel.same('<Super><Control>Left', '<Control><Super>Left'), true, 'modifier order doesn’t matter');
eq(Accel.same('<Super><Control>d', '<Super><Primary>D'), true, '<Primary> is Ctrl, letters ignore case');
eq(Accel.same('<Super><Control>Left', '<Super><Alt>Left'), false, 'different modifiers differ');
eq(Accel.same('<Super><Control>F4', ''), false, 'an empty shortcut matches nothing');
eq(Accel.same('<Super>Above_Tab', '<Super>Above_Tab'), false, 'Mutter-only key names are skipped');
eq(Accel.keycaps('<Super><Control>Left'), ['Super', 'Ctrl', '←'], 'keycaps in Windows order with arrows');
eq(Accel.keycaps('<Control><Super>d'), ['Super', 'Ctrl', 'D'], 'letters as capitals');
eq(Accel.keycaps('<Super><Control>F4'), ['Super', 'Ctrl', 'F4'], 'function keys');
eq(Accel.keycaps('<Super><Shift><Alt>Page_Up'), ['Super', 'Alt', 'Shift', 'Page Up'], 'Alt before Shift');
eq(Accel.keycaps('nonsense'), [], 'no keycaps for something that isn’t a shortcut');
const M = Gdk.ModifierType;
eq(Accel.name(Gdk.KEY_Left, M.SUPER_MASK | M.CONTROL_MASK), '<Super><Control>Left',
    'written the way the defaults are');
eq(Accel.name(Gdk.KEY_d, M.CONTROL_MASK | M.SUPER_MASK | M.SHIFT_MASK), '<Super><Control><Shift>d',
    'Shift stays explicit');
eq(Accel.name(0x1008ffa9, M.SUPER_MASK), '<Super>XF86TouchpadToggle', 'XF86 key names keep their prefix');
eq(Accel.same(Accel.name(Gdk.KEY_F4, M.SUPER_MASK | M.CONTROL_MASK), '<Super><Control>F4'), true,
    'what the dialog writes reads back as the same keys');
eq(Accel.standsAlone(Gdk.KEY_F9), true, 'F-keys work without modifiers');
eq(Accel.standsAlone(Gdk.KEY_d), false, 'letters need a modifier');
eq(Accel.isModifierKey(Gdk.KEY_Super_L), true, 'Super is a modifier key');
eq(Accel.modifierLabels(M.SUPER_MASK | M.CONTROL_MASK | M.LOCK_MASK), ['Super', 'Ctrl'], 'Caps Lock is ignored');

print(`\n${count - failures}/${count} passed`);
System.exit(failures ? 1 : 0);
