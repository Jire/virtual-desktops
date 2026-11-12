// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// Virtual Desktops
//
// Windows 11 virtual desktops for GNOME Shell, with the same shortcuts:
//
//  - Super+Ctrl+← / →  switch to the desktop on the left / right, with a
//    bounce at the first and last one (desktops.js, bounce.js)
//  - Super+Ctrl+D      create a new desktop and switch to it
//  - Super+Ctrl+F4     close the current desktop; its windows move to the
//    desktop on the left and stay where they are on screen
//  - the desktop's name pops up as you switch (flyout.js)
//  - desktops stay until they're closed and every display switches together
//    (workspaceMode.js): GNOME's dynamic workspaces and "workspaces on the
//    primary display only" are switched off while this runs and given back
//    when it's turned off.

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {EdgeBounce} from './bounce.js';
import {DesktopController} from './desktops.js';
import {DesktopFlyout} from './flyout.js';
import {Keybindings} from './keybindings.js';
import {WorkspaceMode} from './workspaceMode.js';

export default class VirtualDesktopsExtension extends Extension {
    enable() {
        this.settings = this.getSettings();
        this._debug = this.settings.get_boolean('debug');
        this.settings.connectObject('changed::debug', () => {
            this._debug = this.settings.get_boolean('debug');
        }, this);

        try {
            this.workspaceMode = new WorkspaceMode(this);
            this.flyout = new DesktopFlyout(this);
            this.bounce = new EdgeBounce();
            this.desktops = new DesktopController(this);
            this.keybindings = new Keybindings(this, {
                left: () => this.desktops.switchSideways(-1),
                right: () => this.desktops.switchSideways(+1),
                new: () => this.desktops.newDesktop(),
                close: () => this.desktops.closeDesktop(),
            });
        } catch (e) {
            // GNOME doesn't call disable() after a failed enable(): undo what
            // was done, so GNOME's own settings are never left changed.
            this.disable();
            throw e;
        }
        this.log('enabled');
    }

    disable() {
        // Runs when the extension is turned off or GNOME Shell disables all
        // extensions, but not when the screen locks (see metadata.json's
        // session-modes): locking mustn't hand the desktops back to GNOME's
        // dynamic workspaces, which would delete the empty ones.
        this.keybindings?.destroy();
        this.desktops?.destroy();
        this.bounce?.destroy();
        this.flyout?.destroy();
        this.workspaceMode?.destroy();
        this.keybindings = this.desktops = this.bounce = this.flyout = this.workspaceMode = null;

        this.log('disabled');
        this.settings?.disconnectObject(this);
        this.settings = null;
    }

    log(message) {
        if (this._debug)
            console.log(`[virtual-desktops] ${message}`);
    }
}
