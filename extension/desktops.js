// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// What the shortcuts do, the way Windows 11 does it:
//
//  - Super+Ctrl+← / →: the desktop on the left / right. At the first or last
//    desktop the screen bounces instead (no wrapping, unless asked for).
//  - Super+Ctrl+D: a new desktop at the end (the right), switched to at once.
//  - Super+Ctrl+F4: close the current desktop. Its windows move to the desktop
//    on the left (on the right when closing the first one) and you go there.
//    Closing the only desktop does nothing.
//
// Switching uses GNOME's own slide animation. While closing a desktop, its
// windows stay exactly where they are on screen and the neighbouring desktop
// slides in underneath them: they're pinned to every desktop (exactly what
// "Always on Visible Workspace" does) for the length of GNOME's animation, then
// handed over to the desktop they were merged into.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {WorkspaceSwitcherPopup} from 'resource:///org/gnome/shell/ui/workspaceSwitcherPopup.js';

import {animationsEnabled, isSwitchAnimationActor} from './compat.js';
import {DesktopNames} from './names.js';
import {isWorkspaceEmpty, maxWorkspaces, windowsOn, workspaceExists} from './workspaces.js';

// GNOME's workspace switch animation (workspaceAnimation.js WINDOW_ANIMATION_TIME).
const SWITCH_ANIMATION_MS = 250;

export class DesktopController {
    constructor(ext) {
        this._ext = ext;
        this._settings = ext.settings;
        this._flyout = ext.flyout;
        this._bounce = ext.bounce;
        this._names = new DesktopNames();
        this._closing = null; // windows of a closed desktop, pinned until the slide ends
        this._busy = false; // inside our own workspace changes
        this._gnomePopup = null;

        global.workspace_manager.connectObject('active-workspace-changed',
            () => this._onActiveWorkspaceChanged(), this);
    }

    destroy() {
        global.workspace_manager.disconnectObject(this);
        this._settleClosedDesktop();
        this._gnomePopup?.destroy();
        this._gnomePopup = null;
    }

    // -- Super+Ctrl+← / → ---------------------------------------------------

    /** `key`: -1 for ←, +1 for →. */
    switchSideways(key) {
        if (!Main.sessionMode.hasWorkspaces)
            return;

        const wm = global.workspace_manager;
        const count = wm.get_n_workspaces();
        const from = wm.get_active_workspace_index();
        let to = from + this._indexStep(key);

        if (to < 0 || to >= count) {
            if (count > 1 && this._settings.get_boolean('wrap-around')) {
                to = (to + count) % count;
            } else {
                this._ext.log(`Already on the ${to < 0 ? 'first' : 'last'} desktop`);
                if (this._settings.get_boolean('bounce'))
                    this._bounce.play(key);
                this._indicate(from);
                return;
            }
        }

        this._ext.log(`Desktop ${from + 1} → ${to + 1}`);
        this._activate(wm.get_workspace_by_index(to));
        this._indicate(to);
    }

    /** Which way through the desktops a ← / → press goes. */
    _indexStep(key) {
        // Vertical layouts (some extensions use them): ← previous, → next.
        if (global.workspace_manager.layout_rows === -1)
            return key;
        // Right-to-left languages lay the desktops out from the right.
        return Clutter.get_default_text_direction() === Clutter.TextDirection.RTL ? -key : key;
    }

    // -- Super+Ctrl+D -------------------------------------------------------

    newDesktop() {
        if (!Main.sessionMode.hasWorkspaces)
            return;

        const wm = global.workspace_manager;

        if (Meta.prefs_get_dynamic_workspaces()) {
            // GNOME's dynamic workspaces always keep a spare empty one at the
            // end, and remove any other empty one: the spare *is* the new desktop.
            const last = wm.get_workspace_by_index(wm.get_n_workspaces() - 1);
            if (isWorkspaceEmpty(last)) {
                this._ext.log('New desktop: GNOME’s spare empty workspace');
                if (!last.active)
                    this._activate(last);
                this._indicate(last.index());
                return;
            }
        } else if (wm.get_n_workspaces() >= maxWorkspaces()) {
            this._ext.log('New desktop: limit reached');
            if (this._settings.get_boolean('bounce'))
                this._bounce.play(+1);
            this._flyout.show({
                title: 'No more desktops',
                caption: `GNOME allows up to ${maxWorkspaces()}`,
            });
            return;
        }

        const workspace = wm.append_new_workspace(false, global.get_current_time());
        if (!workspace)
            return;
        const index = workspace.index();
        // A new desktop always starts with the default name, like on Windows.
        this._names.reset(index);
        this._ext.log(`New desktop ${index + 1}`);
        this._activate(workspace);
        this._indicate(index);
    }

    // -- Super+Ctrl+F4 ------------------------------------------------------

    closeDesktop() {
        if (!Main.sessionMode.hasWorkspaces)
            return;

        // A desktop closed a moment ago may still be sliding away.
        this._settleClosedDesktop();

        const wm = global.workspace_manager;
        const count = wm.get_n_workspaces();
        if (count < 2) {
            this._ext.log('Close desktop: it’s the only one');
            return;
        }

        const closing = wm.get_active_workspace();
        const index = closing.index();
        // The desktop on the left gets the windows, or the one on the right
        // when closing the first desktop.
        const targetIndex = index > 0 ? index - 1 : 1;
        const target = wm.get_workspace_by_index(targetIndex);
        const time = global.get_current_time();

        if (Meta.prefs_get_dynamic_workspaces() && index === count - 1 && isWorkspaceEmpty(closing)) {
            // GNOME's spare empty workspace at the end would come straight
            // back, so closing it just means leaving it.
            this._ext.log('Close desktop: leaving GNOME’s spare empty workspace');
            this._activate(target);
            this._indicate(targetIndex);
            return;
        }

        // Bottom to top, so raising them in this order keeps their order.
        const windows = global.display.sort_windows_by_stacking(windowsOn(closing));
        const visible = windows.filter(w => w.showing_on_its_workspace());
        const focus = global.display.focus_window;
        const focusWindow = focus && windows.includes(focus) ? focus : null;

        // GNOME slides between desktops unless animations are off or the
        // overview is open; windows pinned to every desktop stay put during
        // the slide. Everything else moves right away.
        const slide = animationsEnabled() && !Main.overview.visible;
        let pinned = slide ? visible : [];
        // Move the rest first: Mutter moves a window's dialogs and parent
        // along with it, which would undo a pin made before.
        for (const w of windows) {
            if (!pinned.includes(w))
                w.change_workspace(target);
        }
        for (const w of pinned)
            w.stick();
        // Anything that couldn't be pinned just moves.
        for (const w of pinned.filter(p => !p.is_on_all_workspaces()))
            w.change_workspace(target);
        pinned = pinned.filter(w => w.is_on_all_workspaces());
        // They end up on top of the other desktop's windows, the way they're
        // drawn during the slide, and keep their order.
        for (const w of visible)
            w.raise();

        this._ext.log(`Closing desktop ${index + 1}: ${windows.length} window(s) → desktop ${targetIndex + 1}`);

        this._busy = true;
        try {
            if (focusWindow)
                target.activate_with_focus(focusWindow, time);
            else
                target.activate(time);
            wm.remove_workspace(closing, time);
        } finally {
            this._busy = false;
        }
        // Custom names stay with their desktops; default ones renumber.
        this._names.remove(index);

        if (pinned.length)
            this._pinUntilSlideEnds(pinned, target);

        this._indicate(target.index());
    }

    /** Keep `windows` pinned until GNOME's switch animation is over. */
    _pinUntilSlideEnds(windows, target) {
        const closing = {
            target,
            windows: new Map(), // window → 'unmanaged' handler id
            groups: [], // [actor, 'destroy' handler id]
            timeoutId: 0,
        };
        this._closing = closing;

        for (const w of windows) {
            const id = w.connect('unmanaged', () => {
                w.disconnect(id);
                closing.windows.delete(w);
            });
            closing.windows.set(w, id);
        }

        // GNOME draws the slide with one actor per monitor, right above the
        // window group, and destroys them when it's done. On GNOME 46–49 a
        // window must not stop being pinned while they exist (GNOME throws on
        // the next restack), so wait for them rather than for a timer.
        const groups = Main.uiGroup.get_children().filter(isSwitchAnimationActor);
        if (!groups.length) {
            // Finished already (or this GNOME draws it differently).
            this._settleClosedDesktop();
            return;
        }

        let left = groups.length;
        for (const group of groups) {
            const id = group.connect('destroy', () => {
                closing.groups = closing.groups.filter(([g]) => g !== group);
                if (--left === 0 && this._closing === closing)
                    this._settleClosedDesktop();
            });
            closing.groups.push([group, id]);
        }

        // Just in case the animation never ends.
        const slowDown = St.Settings.get().slow_down_factor || 1;
        closing.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            Math.round(SWITCH_ANIMATION_MS * slowDown) + 2000, () => {
                closing.timeoutId = 0;
                if (this._closing === closing)
                    this._settleClosedDesktop();
                return GLib.SOURCE_REMOVE;
            });
    }

    /** Unpin a closed desktop's windows and leave them on the desktop they joined. */
    _settleClosedDesktop() {
        const closing = this._closing;
        if (!closing)
            return;
        this._closing = null;

        if (closing.timeoutId)
            GLib.source_remove(closing.timeoutId);
        for (const [group, id] of closing.groups)
            group.disconnect(id);

        const target = workspaceExists(closing.target)
            ? closing.target : global.workspace_manager.get_active_workspace();
        for (const [w, id] of closing.windows) {
            w.disconnect(id);
            // Unpinning puts a window on the current desktop, which isn't
            // necessarily the one it was merged into if you've moved on since.
            w.unstick();
            if (w.get_workspace() !== target)
                w.change_workspace(target);
        }
        this._ext.log(`Closed desktop's windows settled on desktop ${target.index() + 1}`);
    }

    _onActiveWorkspaceChanged() {
        if (this._busy || !this._closing)
            return;
        // Removing a desktop on the left only renumbers the current one.
        if (global.workspace_manager.get_active_workspace() === this._closing.target)
            return;
        // Another switch (a shortcut, a gesture, the overview) cuts the slide
        // short: GNOME stops it and starts a new one right after this signal,
        // so hand the windows over now and the new slide draws them right.
        this._settleClosedDesktop();
    }

    // -- Shared ---------------------------------------------------------------

    _activate(workspace) {
        this._bounce.cancel();
        workspace.activate(global.get_current_time());
    }

    /** Show which desktop you're on, the way the settings ask for. */
    _indicate(index) {
        // Like Task View on Windows and GNOME's own indicator: the overview
        // already shows the desktops.
        if (Main.overview.visible)
            return;

        switch (this._settings.get_string('switch-indicator')) {
        case 'name':
            this._flyout.show({
                title: this._names.displayName(index),
                index,
                count: global.workspace_manager.get_n_workspaces(),
            });
            break;
        case 'gnome':
            this._showGnomeIndicator(index);
            break;
        }
    }

    _showGnomeIndicator(index) {
        if (!this._gnomePopup) {
            this._gnomePopup = new WorkspaceSwitcherPopup();
            this._gnomePopup.connect('destroy', () => {
                this._gnomePopup = null;
            });
        }
        this._gnomePopup.display(index);
    }
}
