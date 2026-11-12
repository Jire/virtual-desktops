// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// The bounce at the first and last desktop: like on Windows, the desktop gets
// a little nudge toward where you tried to go and springs back, so you can
// tell the shortcut worked but there's no desktop there.
//
// Drawn the way GNOME draws its own switch animation: per monitor, a snapshot
// of the current desktop (wallpaper + live clones of its windows) laid over
// the real one and moved, with windows shown on every desktop held still.

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {animationsEnabled, disableUnredirect, enableUnredirect, scaleFactor} from './compat.js';

const OUT_MS = 110;
const BACK_MS = 320;
// How far the desktop is nudged: this much of the screen, at most MAX_PX.
const DISTANCE = 0.045;
const MAX_PX = 96;

export class EdgeBounce {
    constructor() {
        this._groups = [];
        this._unredirectOff = false;

        // Anything that changes what's on screen cuts the bounce short.
        global.workspace_manager.connectObject('active-workspace-changed', () => this.cancel(), this);
        Main.overview.connectObject('showing', () => this.cancel(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this.cancel(), this);
        Main.sessionMode.connectObject('updated', () => this.cancel(), this);
    }

    destroy() {
        global.workspace_manager.disconnectObject(this);
        Main.overview.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        this.cancel();
    }

    get playing() {
        return this._groups.length > 0;
    }

    /** `key`: -1 tried to go left (or up), +1 right (or down). */
    play(key) {
        // Keys held down repeat: let the bounce that's running finish.
        if (this.playing || !animationsEnabled() || Main.overview.visible)
            return;

        const wm = global.workspace_manager;
        const vertical = wm.layout_rows === -1;
        const workspace = wm.get_active_workspace();
        const monitors = Meta.prefs_get_workspaces_only_on_primary()
            ? [Main.layoutManager.primaryMonitor].filter(Boolean)
            : Main.layoutManager.monitors;
        if (!monitors.length)
            return;

        disableUnredirect();
        this._unredirectOff = true;

        const property = vertical ? 'translation_y' : 'translation_x';
        let running = 0;
        for (const monitor of monitors) {
            const {group, content, background} = this._snapshot(monitor, workspace);
            Main.uiGroup.insert_child_above(group, global.window_group);
            this._groups.push({group, background});
            this._ensureOpaque(group);

            const size = vertical ? monitor.height : monitor.width;
            const distance = Math.round(Math.min(size * DISTANCE, MAX_PX * scaleFactor()));
            running++;
            content.ease({
                [property]: -key * distance,
                duration: OUT_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    content.ease({
                        [property]: 0,
                        duration: BACK_MS,
                        mode: Clutter.AnimationMode.EASE_OUT_BACK,
                        onStopped: () => {
                            if (--running === 0)
                                this.cancel();
                        },
                    });
                },
                onStopped: finished => {
                    if (!finished && --running === 0)
                        this.cancel();
                },
            });
        }
    }

    /** Stop and remove the bounce (no-op when none is playing). */
    cancel() {
        const groups = this._groups;
        this._groups = [];
        for (const {group, background} of groups) {
            background.destroy();
            group.destroy();
        }
        if (this._unredirectOff) {
            this._unredirectOff = false;
            enableUnredirect();
        }
    }

    /** The desktop as it is on `monitor`, ready to be moved. */
    _snapshot(monitor, workspace) {
        // 'workspace-animation' gives the gap behind the moving desktop the
        // same colour GNOME's own workspace switch shows there.
        const group = new St.Widget({
            style_class: 'workspace-animation vdesk-bounce',
            clip_to_allocation: true,
            reactive: false,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
        });

        const content = new Clutter.Actor();
        group.add_child(content);
        const sticky = new Clutter.Actor();
        group.add_child(sticky);

        const wallpaper = new Meta.BackgroundGroup();
        content.add_child(wallpaper);
        const background = new Background.BackgroundManager({
            container: wallpaper,
            monitorIndex: monitor.index,
            controlPosition: false,
        });

        const geometry = global.display.get_monitor_geometry(monitor.index);
        let lastDesktopClone = wallpaper;
        for (const actor of global.get_window_actors()) {
            const win = actor.meta_window;
            if (!win || win.is_override_redirect() || !win.showing_on_its_workspace())
                continue;
            const [onMonitor] = win.get_frame_rect().intersect(geometry);
            if (!onMonitor)
                continue;

            const clone = new Clutter.Clone({
                source: actor,
                x: actor.x - monitor.x,
                y: actor.y - monitor.y,
            });
            if (win.get_window_type() === Meta.WindowType.DESKTOP) {
                // Desktop icons belong to the wallpaper.
                content.insert_child_above(clone, lastDesktopClone);
                lastDesktopClone = clone;
            } else if (win.is_on_all_workspaces()) {
                sticky.add_child(clone);
            } else if (win.located_on_workspace(workspace)) {
                content.add_child(clone);
            } else {
                clone.destroy();
            }
        }
        return {group, content, background};
    }

    /** The real windows are underneath: the gap must not be see-through. */
    _ensureOpaque(group) {
        try {
            if (group.get_theme_node().get_background_color().alpha === 0)
                group.set_style('background-color: #222226;');
        } catch {
            group.set_style('background-color: #222226;');
        }
    }
}
