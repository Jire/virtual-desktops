// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// Keyboard shortcut strings for the settings window: parsing, comparing,
// writing them the way Mutter reads them, and showing them the way Windows
// does ("Super + Ctrl + →"). GTK only; not used by the extension itself.

import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';

const M = Gdk.ModifierType;

// Windows order: Win, Ctrl, Alt, Shift.
const MODIFIERS = [
    [M.SUPER_MASK, '<Super>', 'Super'],
    [M.HYPER_MASK, '<Hyper>', 'Hyper'],
    [M.META_MASK, '<Meta>', 'Meta'],
    [M.CONTROL_MASK, '<Control>', 'Ctrl'],
    [M.ALT_MASK, '<Alt>', 'Alt'],
    [M.SHIFT_MASK, '<Shift>', 'Shift'],
];

const KEY_LABELS = new Map([
    [Gdk.KEY_Left, '←'],
    [Gdk.KEY_Right, '→'],
    [Gdk.KEY_Up, '↑'],
    [Gdk.KEY_Down, '↓'],
    [Gdk.KEY_Page_Up, 'Page Up'],
    [Gdk.KEY_Page_Down, 'Page Down'],
    [Gdk.KEY_space, 'Space'],
    [Gdk.KEY_Return, 'Enter'],
    [Gdk.KEY_KP_Enter, 'Enter'],
]);

const MODIFIER_KEYS = new Set([
    Gdk.KEY_Shift_L, Gdk.KEY_Shift_R, Gdk.KEY_Control_L, Gdk.KEY_Control_R,
    Gdk.KEY_Alt_L, Gdk.KEY_Alt_R, Gdk.KEY_Super_L, Gdk.KEY_Super_R,
    Gdk.KEY_Meta_L, Gdk.KEY_Meta_R, Gdk.KEY_Hyper_L, Gdk.KEY_Hyper_R,
    Gdk.KEY_ISO_Level3_Shift, Gdk.KEY_ISO_Level5_Shift, Gdk.KEY_Caps_Lock,
    Gdk.KEY_Num_Lock, Gdk.KEY_Mode_switch,
]);

/** The modifiers that count in a shortcut. */
export function shortcutMask(state) {
    return state & (Gtk.accelerator_get_default_mod_mask() | M.SHIFT_MASK) & ~M.LOCK_MASK;
}

export function isModifierKey(keyval) {
    return MODIFIER_KEYS.has(keyval);
}

/** [keyval, mods] for an accelerator string, or null if GTK can't read it. */
export function parse(accelerator) {
    if (!accelerator)
        return null;
    const [ok, keyval, mods] = Gtk.accelerator_parse(accelerator);
    if (!ok || !keyval)
        return null;
    return [Gdk.keyval_to_lower(keyval), shortcutMask(mods)];
}

/** True when two accelerator strings are the same keys. */
export function same(a, b) {
    const pa = parse(a), pb = parse(b);
    return !!pa && !!pb && pa[0] === pb[0] && pa[1] === pb[1];
}

/** True for the XF86 keys: media, brightness, touchpad and so on. */
function isXF86Key(keyval) {
    return keyval >= 0x10080001 && keyval <= 0x1008ffff;
}

/** Accelerator string the way Mutter reads it, e.g. "<Super><Control>Left". */
export function name(keyval, mods) {
    const prefix = MODIFIERS.filter(([mask]) => mods & mask).map(([, text]) => text).join('');
    let keyName = Gdk.keyval_name(keyval) ?? '';
    // GTK 4 names these without their prefix; Mutter (xkbcommon) needs it.
    if (isXF86Key(keyval) && !keyName.startsWith('XF86'))
        keyName = `XF86${keyName}`;
    return prefix + keyName;
}

/** The name of one key as it's printed on a keycap. */
export function keyLabel(keyval) {
    if (KEY_LABELS.has(keyval))
        return KEY_LABELS.get(keyval);
    const label = Gtk.accelerator_get_label(keyval, 0);
    return label.length === 1 ? label.toUpperCase() : label;
}

/** Keycap texts for an accelerator string, Windows order: ['Super', 'Ctrl', '→']. */
export function keycaps(accelerator) {
    const parsed = parse(accelerator);
    if (!parsed)
        return [];
    const [keyval, mods] = parsed;
    return [...modifierLabels(mods), keyLabel(keyval)];
}

/** Keycap texts for held modifiers. */
export function modifierLabels(mods) {
    return MODIFIERS.filter(([mask]) => mods & mask).map(([,, label]) => label);
}

/**
 * The key and modifiers of a key press, the way GNOME Settings records
 * shortcuts: Shift stays an explicit modifier, and number-row keys are
 * recorded as their numbers whatever the layout puts on them.
 */
export function fromKeyPress(keyval, keycode, state, group) {
    const display = Gdk.Display.get_default();
    const explicit = Gtk.accelerator_get_default_mod_mask() | M.SHIFT_MASK;
    const mods = shortcutMask(state);
    let key = Gdk.keyval_to_lower(keyval);

    try {
        const [ok, unmodified] = display.translate_key(keycode, state & ~explicit, group);
        if (ok && unmodified)
            key = unmodified;
        const [okShifted, shifted] = display.translate_key(keycode, M.SHIFT_MASK | (state & ~explicit), group);
        if (okShifted && shifted >= Gdk.KEY_0 && shifted <= Gdk.KEY_9)
            key = shifted;
    } catch {
        // Keep the keyval from the event.
    }

    if (key === Gdk.KEY_ISO_Left_Tab)
        key = Gdk.KEY_Tab;
    // Alt+Print arrives as SysRq.
    if (key === Gdk.KEY_Sys_Req && (mods & M.ALT_MASK))
        key = Gdk.KEY_Print;
    return [key, mods];
}

/** Keys that make a sensible shortcut without Super, Ctrl or Alt. */
export function standsAlone(keyval) {
    if (keyval >= Gdk.KEY_F1 && keyval <= Gdk.KEY_F35)
        return true;
    return isXF86Key(keyval) || keyval === Gdk.KEY_Print || keyval === Gdk.KEY_Pause ||
        keyval === Gdk.KEY_Scroll_Lock;
}
