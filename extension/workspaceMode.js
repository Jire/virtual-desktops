// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// The two GNOME settings that make desktops behave differently from Windows:
//
//  - Dynamic workspaces. Windows keeps every desktop until you close it;
//    GNOME removes an empty workspace as soon as you leave it, and always
//    keeps a spare empty one at the end. So while "Keep desktops until I
//    close them" is on, GNOME gets a fixed number of workspaces instead.
//    Mutter then keeps that number in sync by itself as desktops are created
//    and closed, and it survives logging out, like Windows 11's desktops do.
//
//  - Workspaces on the primary display only (GNOME's default). Windows
//    switches every display together, so while "Desktops span all displays"
//    is on, so does GNOME.
//
// GNOME's own value is put back when the option or the extension is turned
// off. Until then it's kept in our own settings, so a crash or a logout in
// between can't lose it. If the setting is changed back elsewhere (GNOME
// Settings › Multitasking), that wins: our option turns itself off.

import Gio from 'gi://Gio';

import {WM_PREFERENCES_SCHEMA} from './names.js';
import {desktopsToKeep} from './workspaces.js';

const MUTTER_SCHEMA = 'org.gnome.mutter';

const MANAGED = [
    {
        option: 'persistent-desktops',
        key: 'dynamic-workspaces',
        saved: 'saved-dynamic-workspaces',
        name: 'dynamic workspaces',
    },
    {
        option: 'span-all-displays',
        key: 'workspaces-only-on-primary',
        saved: 'saved-workspaces-only-on-primary',
        name: 'workspaces on the primary display only',
    },
];

export class WorkspaceMode {
    constructor(ext) {
        this._ext = ext;
        this._settings = ext.settings;
        this._mutter = new Gio.Settings({schema_id: MUTTER_SCHEMA});
        this._wmPreferences = new Gio.Settings({schema_id: WM_PREFERENCES_SCHEMA});

        for (const managed of MANAGED) {
            this._settings.connectObject(`changed::${managed.option}`, () => this._sync(managed), this);
            this._mutter.connectObject(`changed::${managed.key}`, () => this._onChangedElsewhere(managed), this);
            this._sync(managed);
        }
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._mutter.disconnectObject(this);
        for (const managed of MANAGED)
            this._giveBack(managed);
    }

    _sync(managed) {
        if (this._settings.get_boolean(managed.option))
            this._takeOver(managed);
        else
            this._giveBack(managed);
    }

    /** Both settings are off on Windows; turn GNOME's off, remembering it was on. */
    _takeOver(managed) {
        if (!this._mutter.get_boolean(managed.key))
            return; // Already like Windows (ours, or the user's own choice).

        if (this._settings.get_string(managed.saved) !== 'true') {
            if (managed.key === 'dynamic-workspaces')
                this._settings.set_int('saved-num-workspaces', this._wmPreferences.get_int('num-workspaces'));
            this._settings.set_string(managed.saved, 'true');
        }

        if (managed.key === 'dynamic-workspaces') {
            // Keep the desktops that are in use; drop the spare empty one
            // GNOME keeps at the end. Set the number first, so Mutter applies
            // it the moment dynamic workspaces go off.
            const keep = desktopsToKeep();
            this._wmPreferences.set_int('num-workspaces', keep);
            this._ext.log(`Keeping ${keep} desktop(s)`);
        }
        this._mutter.set_boolean(managed.key, false);
        this._ext.log(`GNOME's ${managed.name}: off`);
    }

    _giveBack(managed) {
        if (this._settings.get_string(managed.saved) !== 'true')
            return;

        this._settings.set_string(managed.saved, '');
        this._mutter.set_boolean(managed.key, true);

        if (managed.key === 'dynamic-workspaces') {
            // Only shown in GNOME Settings' "fixed number of workspaces"
            // field, so put the user's number back too (ignored while dynamic).
            const savedNumber = this._settings.get_int('saved-num-workspaces');
            this._settings.set_int('saved-num-workspaces', 0);
            if (savedNumber > 0)
                this._wmPreferences.set_int('num-workspaces', savedNumber);
        }
        this._ext.log(`GNOME's ${managed.name}: back on`);
    }

    _onChangedElsewhere(managed) {
        if (!this._mutter.get_boolean(managed.key) || !this._settings.get_boolean(managed.option))
            return;

        // Turned back on elsewhere: that's what the user wants now, so stop
        // managing it instead of fighting over the setting.
        this._settings.set_string(managed.saved, '');
        if (managed.key === 'dynamic-workspaces')
            this._settings.set_int('saved-num-workspaces', 0);
        this._settings.set_boolean(managed.option, false);
        this._ext.log(`GNOME's ${managed.name} turned on elsewhere; option off`);
    }
}
