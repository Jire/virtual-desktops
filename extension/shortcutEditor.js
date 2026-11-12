// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// Settings window: a row per shortcut, showing its keys like Windows does
// (Super + Ctrl + →), and the "press the new shortcut" dialog.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import * as Accel from './accelerators.js';

// GObject type names must be unique in the process, and the settings window
// may load a second copy of this file from another folder after the extension
// was reloaded without logging out (scripts/hot-load.js).
const TYPE_SUFFIX = import.meta.url.replace(/[^A-Za-z0-9]+/g, '_');

/** True while `key` is still Windows 11's shortcut. */
export function isDefaultShortcut(settings, key) {
    const defaults = settings.get_default_value(key).deepUnpack();
    const current = settings.get_strv(key);
    return defaults.length === current.length && defaults.every((d, i) => Accel.same(d, current[i]));
}

// Adwaita draws `.keycap` labels as keys only inside a "shortcut" node (what
// Gtk.ShortcutLabel uses). That one orders keys Ctrl first, so this is a box
// with the same CSS name that keeps Windows' order: Super + Ctrl + key.
const KeycapBox = GObject.registerClass({
    GTypeName: `VirtualDesktopsKeycapBox_${TYPE_SUFFIX}`,
    CssName: 'shortcut',
}, class KeycapBox extends Gtk.Box {});

/** Keycaps for `labels`, e.g. ['Super', 'Ctrl', '→']. */
export function keycapBox(labels, {dim = false} = {}) {
    const box = new KeycapBox({spacing: 4, valign: Gtk.Align.CENTER});
    labels.forEach((label, i) => {
        if (i > 0)
            box.append(new Gtk.Label({label: '+', css_classes: ['dim-label']}));
        box.append(new Gtk.Label({label, css_classes: dim ? ['keycap', 'dim-label'] : ['keycap']}));
    });
    return box;
}

export const ShortcutRow = GObject.registerClass({
    GTypeName: `VirtualDesktopsShortcutRow_${TYPE_SUFFIX}`,
}, class ShortcutRow extends Adw.ActionRow {
    /**
     * @param {object} params
     * @param {Gio.Settings} params.settings - the extension's settings
     * @param {string} params.key - which shortcut
     * @param {string} params.title - what it does
     * @param {string} params.subtitle - more about what it does
     * @param {Function} params.labelFor - key → title of another shortcut
     */
    _init({settings, key, title, subtitle, labelFor}) {
        super._init({title, subtitle, activatable: true});
        this._settings = settings;
        this._key = key;
        this._labelFor = labelFor;

        this._keys = new Gtk.Box({valign: Gtk.Align.CENTER});
        this.add_suffix(this._keys);

        this._reset = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Back to the Windows shortcut',
            css_classes: ['flat', 'circular'],
        });
        this._reset.connect('clicked', () => this._settings.reset(this._key));
        this.add_suffix(this._reset);

        this.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic', css_classes: ['dim-label']}));

        this.connect('activated', () => this.edit());
        const id = settings.connect(`changed::${key}`, () => this._sync());
        this.connect('destroy', () => settings.disconnect(id));
        this._sync();
    }

    get accelerator() {
        return this._settings.get_strv(this._key)[0] ?? '';
    }

    _sync() {
        const accelerator = this.accelerator;
        const caps = Accel.keycaps(accelerator);
        const box = caps.length
            ? keycapBox(caps)
            : new Gtk.Label({label: accelerator ? accelerator : 'Off', css_classes: ['dim-label']});
        this._keys.get_first_child()?.unparent();
        this._keys.append(box);

        const isDefault = isDefaultShortcut(this._settings, this._key);
        this._reset.visible = !isDefault;
        this.set_tooltip_text(isDefault ? null : 'Changed from the Windows shortcut');
    }

    /** Open the dialog that records a new shortcut. */
    edit() {
        const dialog = new ShortcutDialog({
            settings: this._settings,
            key: this._key,
            action: this.title,
            labelFor: this._labelFor,
        });
        dialog.present(this);
    }
});

const ShortcutDialog = GObject.registerClass({
    GTypeName: `VirtualDesktopsShortcutDialog_${TYPE_SUFFIX}`,
}, class ShortcutDialog extends Adw.Dialog {
    _init({settings, key, action, labelFor}) {
        super._init({
            title: 'Set Shortcut',
            content_width: 440,
            content_height: 270,
        });
        this._settings = settings;
        this._key = key;
        this._labelFor = labelFor;

        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(new Adw.HeaderBar());
        this.set_child(toolbar);

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 18,
            margin_top: 12,
            margin_bottom: 24,
            margin_start: 24,
            margin_end: 24,
            valign: Gtk.Align.CENTER,
        });
        toolbar.set_content(box);

        box.append(new Gtk.Label({
            label: `Press the new shortcut for\n<b>${GLib.markup_escape_text(action, -1)}</b>`,
            use_markup: true,
            justify: Gtk.Justification.CENTER,
            wrap: true,
        }));

        // What's held down right now, like Windows' own shortcut boxes.
        this._preview = new Gtk.Box({halign: Gtk.Align.CENTER, height_request: 34});
        box.append(this._preview);

        this._error = new Gtk.Label({
            css_classes: ['error'],
            wrap: true,
            justify: Gtk.Justification.CENTER,
            visible: false,
        });
        box.append(this._error);

        const hint = new Gtk.Box({halign: Gtk.Align.CENTER, spacing: 6});
        hint.append(keycapBox(['Esc'], {dim: true}));
        hint.append(new Gtk.Label({label: 'to cancel,', css_classes: ['dim-label']}));
        hint.append(keycapBox(['Backspace'], {dim: true}));
        hint.append(new Gtk.Label({label: 'to turn it off', css_classes: ['dim-label']}));
        box.append(hint);

        this._showHeld(0);

        const keys = new Gtk.EventControllerKey({propagation_phase: Gtk.PropagationPhase.CAPTURE});
        keys.connect('key-pressed', (c, keyval, keycode, state) => this._onKeyPressed(c, keyval, keycode, state));
        keys.connect('modifiers', (c, state) => {
            this._showHeld(Accel.shortcutMask(state));
            return false;
        });
        this.add_controller(keys);

        // Our own shortcuts would switch desktops instead of reaching this
        // dialog, so the extension pauses them while it's open.
        this._settings.set_boolean('suspend-shortcuts', true);
        this.connect('closed', () => this._settings.set_boolean('suspend-shortcuts', false));
    }

    _showHeld(mods) {
        this._preview.get_first_child()?.unparent();
        const labels = Accel.modifierLabels(mods);
        if (labels.length)
            this._preview.append(keycapBox([...labels, '…']));
        else
            this._preview.append(new Gtk.Label({label: 'Waiting for keys…', css_classes: ['dim-label', 'title-4']}));
    }

    _fail(message) {
        this._error.label = message;
        this._error.visible = true;
    }

    _onKeyPressed(controller, keyval, keycode, state) {
        const mods = Accel.shortcutMask(state);
        if (Accel.isModifierKey(keyval)) {
            this._showHeld(mods | modifierFor(keyval));
            return Gdk.EVENT_STOP;
        }

        if (mods === 0 && keyval === Gdk.KEY_Escape) {
            this.close();
            return Gdk.EVENT_STOP;
        }
        if (mods === 0 && keyval === Gdk.KEY_BackSpace) {
            this._settings.set_strv(this._key, []);
            this.close();
            return Gdk.EVENT_STOP;
        }

        const [key, keyMods] = Accel.fromKeyPress(keyval, keycode, state, controller.get_group());
        const strong = keyMods & ~Gdk.ModifierType.SHIFT_MASK;
        if (!strong && !Accel.standsAlone(key)) {
            this._fail('Hold Super, Ctrl or Alt too, so you can still type that key.');
            return Gdk.EVENT_STOP;
        }
        if (!Gtk.accelerator_valid(key, keyMods)) {
            this._fail('That key can’t be used for a shortcut.');
            return Gdk.EVENT_STOP;
        }

        const accelerator = Accel.name(key, keyMods);
        const taken = this._labelFor(accelerator, this._key);
        if (taken) {
            this._fail(`${Accel.keycaps(accelerator).join(' + ')} is already “${taken}”.`);
            return Gdk.EVENT_STOP;
        }

        this._settings.set_strv(this._key, [accelerator]);
        this.close();
        return Gdk.EVENT_STOP;
    }
});

function modifierFor(keyval) {
    switch (keyval) {
    case Gdk.KEY_Super_L:
    case Gdk.KEY_Super_R:
        return Gdk.ModifierType.SUPER_MASK;
    case Gdk.KEY_Control_L:
    case Gdk.KEY_Control_R:
        return Gdk.ModifierType.CONTROL_MASK;
    case Gdk.KEY_Alt_L:
    case Gdk.KEY_Alt_R:
        return Gdk.ModifierType.ALT_MASK;
    case Gdk.KEY_Shift_L:
    case Gdk.KEY_Shift_R:
        return Gdk.ModifierType.SHIFT_MASK;
    default:
        return 0;
    }
}
