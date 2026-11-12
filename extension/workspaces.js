// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// Small helpers around Mutter's workspaces ("desktops" everywhere else).

import Gio from 'gi://Gio';
import Meta from 'gi://Meta';

import {WM_PREFERENCES_SCHEMA} from './names.js';

/**
 * The windows that belong to `workspace` alone: not windows shown on every
 * desktop (pinned with "Always on Visible Workspace", docks, or windows on
 * other monitors when only the primary one has desktops).
 */
export function windowsOn(workspace) {
    return workspace.list_windows().filter(w =>
        !w.is_on_all_workspaces() &&
        !w.is_override_redirect() &&
        w.get_window_type() !== Meta.WindowType.DESKTOP);
}

export function isWorkspaceEmpty(workspace) {
    return windowsOn(workspace).length === 0;
}

/** All workspaces, left to right. */
export function allWorkspaces() {
    const wm = global.workspace_manager;
    const list = [];
    for (let i = 0; i < wm.get_n_workspaces(); i++)
        list.push(wm.get_workspace_by_index(i));
    return list;
}

/** False once Mutter has removed the workspace (its index() would complain). */
export function workspaceExists(workspace) {
    return !!workspace && allWorkspaces().includes(workspace);
}

let maxCache = 0;

/**
 * The most desktops GNOME can keep with a fixed number of workspaces: the
 * upper end of org.gnome.desktop.wm.preferences num-workspaces (36).
 */
export function maxWorkspaces() {
    if (maxCache)
        return maxCache;
    maxCache = 36;
    try {
        const schema = Gio.SettingsSchemaSource.get_default().lookup(WM_PREFERENCES_SCHEMA, true);
        const [type, range] = schema.get_key('num-workspaces').get_range().recursiveUnpack();
        if (type === 'range' && Number.isInteger(range?.[1]))
            maxCache = range[1];
    } catch {
        // Keep the default.
    }
    return maxCache;
}

/**
 * How many workspaces to keep when switching GNOME from dynamic to fixed
 * workspaces: everything up to the last one with windows on it (or the one
 * you're on), dropping the empty spare GNOME keeps at the end.
 */
export function desktopsToKeep() {
    const wm = global.workspace_manager;
    let last = wm.get_active_workspace_index();
    for (let i = wm.get_n_workspaces() - 1; i > last; i--) {
        if (!isWorkspaceEmpty(wm.get_workspace_by_index(i))) {
            last = i;
            break;
        }
    }
    return Math.max(1, Math.min(last + 1, maxWorkspaces()));
}
