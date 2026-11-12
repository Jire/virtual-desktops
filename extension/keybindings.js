// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// The four Windows 11 shortcuts, registered with GNOME Shell's window manager
// so they work everywhere: over any app, and in the overview (like Task View).
//
// They're dropped while the screen is locked, and while the settings window
// records a new shortcut (otherwise pressing the current one would switch
// desktops instead of reaching the settings window).

import Meta from 'gi://Meta';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/** Settings key → what it does. `repeat`: act again while the keys are held. */
export const SHORTCUTS = [
    {key: 'virtual-desktop-left', action: 'left', repeat: true},
    {key: 'virtual-desktop-right', action: 'right', repeat: true},
    // Holding these down shouldn't create or close a pile of desktops.
    {key: 'virtual-desktop-new', action: 'new', repeat: false},
    {key: 'virtual-desktop-close', action: 'close', repeat: false},
];

const MODES = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;

// The settings window un-pauses the shortcuts when it's done recording; if it
// crashed in between, don't stay paused for longer than this.
const MAX_PAUSE_SECONDS = 60;

export class Keybindings {
    constructor(ext, handlers) {
        this._ext = ext;
        this._settings = ext.settings;
        this._handlers = handlers;
        this._added = false;
        this._pauseTimeoutId = 0;

        if (this._settings.get_boolean('suspend-shortcuts'))
            this._settings.set_boolean('suspend-shortcuts', false);

        this._settings.connectObject('changed::suspend-shortcuts', () => this._sync(), this);
        Main.sessionMode.connectObject('updated', () => this._sync(), this);
        this._sync();
    }

    destroy() {
        Main.sessionMode.disconnectObject(this);
        this._settings.disconnectObject(this);
        if (this._pauseTimeoutId) {
            GLib.source_remove(this._pauseTimeoutId);
            this._pauseTimeoutId = 0;
        }
        this._remove();
    }

    _sync() {
        const paused = this._settings.get_boolean('suspend-shortcuts');
        if (paused && !this._pauseTimeoutId) {
            this._pauseTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, MAX_PAUSE_SECONDS, () => {
                this._pauseTimeoutId = 0;
                this._settings.set_boolean('suspend-shortcuts', false);
                return GLib.SOURCE_REMOVE;
            });
        } else if (!paused && this._pauseTimeoutId) {
            GLib.source_remove(this._pauseTimeoutId);
            this._pauseTimeoutId = 0;
        }

        const wanted = !paused && !Main.sessionMode.isLocked && Main.sessionMode.hasWorkspaces;
        if (wanted)
            this._add();
        else
            this._remove();
    }

    _add() {
        if (this._added)
            return;
        for (const {key, action, repeat} of SHORTCUTS) {
            const flags = repeat ? Meta.KeyBindingFlags.NONE : Meta.KeyBindingFlags.IGNORE_AUTOREPEAT;
            // The handler's arguments differ between GNOME versions; none are needed.
            Main.wm.addKeybinding(key, this._settings, flags, MODES, () => {
                try {
                    this._handlers[action]();
                } catch (e) {
                    logError(e, `[virtual-desktops] ${action}`);
                }
            });
        }
        this._added = true;
        this._ext.log('Shortcuts on');
    }

    _remove() {
        if (!this._added)
            return;
        for (const {key} of SHORTCUTS)
            Main.wm.removeKeybinding(key);
        this._added = false;
        this._ext.log('Shortcuts off');
    }
}
