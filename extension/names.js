// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// Desktop names. They live in GNOME's own `workspace-names` setting, so other
// tools (workspace indicators, pagers) show the same names. Shared by the
// extension and the settings window, so only Gio is imported here.
//
// Like Windows, a desktop without a custom name is called "Desktop N" after
// its position, so the default names renumber when a desktop is closed, while
// custom names stay with their desktop.

import Gio from 'gi://Gio';

export const WM_PREFERENCES_SCHEMA = 'org.gnome.desktop.wm.preferences';

/** The name Windows gives the desktop at `index` (0-based). */
export function defaultName(index) {
    return `Desktop ${index + 1}`;
}

/** Drop trailing empty entries so the setting stays tidy. */
export function trimNames(names) {
    const out = names.map(n => (n ?? '').trim());
    while (out.length && out[out.length - 1] === '')
        out.pop();
    return out;
}

/** `names` with the desktop at `index` removed: later names move down one. */
export function namesWithout(names, index) {
    if (index < 0 || index >= names.length)
        return trimNames(names);
    return trimNames([...names.slice(0, index), ...names.slice(index + 1)]);
}

/** `names` with the desktop at `index` called `name` ('' = default name). */
export function namesWith(names, index, name) {
    const out = [...names];
    while (out.length <= index)
        out.push('');
    out[index] = (name ?? '').trim();
    return trimNames(out);
}

function sameNames(a, b) {
    return a.length === b.length && a.every((n, i) => n === b[i]);
}

export class DesktopNames {
    constructor() {
        this.settings = new Gio.Settings({schema_id: WM_PREFERENCES_SCHEMA});
    }

    /** All custom names, index = desktop position. Empty = default name. */
    get all() {
        return this.settings.get_strv('workspace-names');
    }

    /** The desktop's custom name, or '' if it has the default one. */
    custom(index) {
        return (this.all[index] ?? '').trim();
    }

    /** What to show for the desktop at `index`. */
    displayName(index) {
        return this.custom(index) || defaultName(index);
    }

    rename(index, name) {
        this._write(namesWith(this.all, index, name));
    }

    /** Give the desktop at `index` its default name back. */
    reset(index) {
        if (this.custom(index))
            this.rename(index, '');
    }

    /** The desktop at `index` was closed: later desktops keep their names. */
    remove(index) {
        this._write(namesWithout(this.all, index));
    }

    _write(names) {
        const current = this.all;
        if (sameNames(trimNames(current), names) && current.length === names.length)
            return;
        this.settings.set_strv('workspace-names', names);
    }
}
