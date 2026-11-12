// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// Finds other shortcuts on the same keys as ours: GNOME's own, the custom
// shortcuts from GNOME Settings, and those of other enabled extensions.
// Mutter runs only one action per key combination and which one wins is
// arbitrary, so the settings window offers to take the keys off the other one.
// Settings window only.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Accel from './accelerators.js';

const GNOME_SCHEMAS = [
    'org.gnome.desktop.wm.keybindings',
    'org.gnome.mutter.keybindings',
    'org.gnome.mutter.wayland.keybindings',
    'org.gnome.shell.keybindings',
    'org.gnome.settings-daemon.plugins.media-keys',
];
const MEDIA_KEYS_SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys';
const CUSTOM_SHORTCUT_SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys.custom-keybinding';

/**
 * A shortcut setting somewhere else that holds a list of accelerators ('as')
 * or a single one ('s').
 */
class Binding {
    constructor({settings, key, owner, action}) {
        this.settings = settings;
        this.key = key;
        this.owner = owner;
        this.action = action;
        this.single = settings.settings_schema.get_key(key).get_value_type().dup_string() === 's';
    }

    get accelerators() {
        return this.single ? [this.settings.get_string(this.key)] : this.settings.get_strv(this.key);
    }

    /** Take `accelerator` off this binding, keeping any others it has. */
    remove(accelerator) {
        if (this.single)
            this.settings.set_string(this.key, '');
        else
            this.settings.set_strv(this.key, this.accelerators.filter(a => !Accel.same(a, accelerator)));
    }
}

function lookupSchema(id) {
    return Gio.SettingsSchemaSource.get_default()?.lookup(id, true) ?? null;
}

function* gnomeBindings() {
    for (const id of GNOME_SCHEMAS) {
        const schema = lookupSchema(id);
        if (!schema)
            continue;
        const settings = new Gio.Settings({settings_schema: schema});
        for (const key of schema.list_keys()) {
            const type = schema.get_key(key).get_value_type().dup_string();
            if (type !== 'as' && type !== 's')
                continue;
            if (id === MEDIA_KEYS_SCHEMA && key === 'custom-keybindings')
                continue;
            const action = schema.get_key(key).get_summary() || key;
            yield new Binding({settings, key, owner: 'GNOME', action});
        }
    }
}

function* customBindings() {
    if (!lookupSchema(MEDIA_KEYS_SCHEMA) || !lookupSchema(CUSTOM_SHORTCUT_SCHEMA))
        return;
    const mediaKeys = new Gio.Settings({schema_id: MEDIA_KEYS_SCHEMA});
    for (const path of mediaKeys.get_strv('custom-keybindings')) {
        const settings = new Gio.Settings({schema_id: CUSTOM_SHORTCUT_SCHEMA, path});
        const label = settings.get_string('name') || settings.get_string('command') || 'Custom shortcut';
        yield new Binding({settings, key: 'binding', owner: 'Custom shortcut', action: label});
    }
}

/**
 * Settings of another installed extension (its schema ships in its own
 * folder), or null if it isn't installed.
 */
export function extensionSettings(uuid, schemaId) {
    const system = lookupSchema(schemaId);
    if (system)
        return new Gio.Settings({settings_schema: system});
    const schemaDir = extensionDir(uuid)?.get_child('schemas');
    if (!schemaDir?.get_child('gschemas.compiled').query_exists(null))
        return null;
    try {
        const source = Gio.SettingsSchemaSource.new_from_directory(schemaDir.get_path(),
            Gio.SettingsSchemaSource.get_default(), false);
        const schema = source.lookup(schemaId, false);
        return schema ? new Gio.Settings({settings_schema: schema}) : null;
    } catch {
        return null;
    }
}

function extensionDir(uuid) {
    const dirs = [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()];
    for (const base of dirs) {
        const dir = Gio.File.new_for_path(GLib.build_filenamev([base, 'gnome-shell', 'extensions', uuid]));
        if (dir.get_child('metadata.json').query_exists(null))
            return dir;
    }
    return null;
}

function readMetadata(dir) {
    try {
        const [, bytes] = dir.get_child('metadata.json').load_contents(null);
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return {};
    }
}

/** An extension's settings schemas: from its own folder, or installed system-wide. */
function extensionSchemas(dir, metadata) {
    const schemaDir = dir.get_child('schemas');
    if (schemaDir.get_child('gschemas.compiled').query_exists(null)) {
        try {
            const source = Gio.SettingsSchemaSource.new_from_directory(schemaDir.get_path(),
                Gio.SettingsSchemaSource.get_default(), false);
            const [ids] = source.list_schemas(false);
            return ids.map(id => source.lookup(id, false)).filter(Boolean);
        } catch {
            return [];
        }
    }
    // Distro packages (Ubuntu's dock and tiling) install theirs with GNOME's.
    const schema = metadata['settings-schema'] ? lookupSchema(metadata['settings-schema']) : null;
    return schema ? [schema] : [];
}

function* extensionBindings(ownUuid) {
    const shell = new Gio.Settings({schema_id: 'org.gnome.shell'});
    for (const uuid of shell.get_strv('enabled-extensions')) {
        if (uuid === ownUuid)
            continue;
        const dir = extensionDir(uuid);
        if (!dir)
            continue;
        const metadata = readMetadata(dir);
        const owner = metadata.name || uuid;
        for (const schema of extensionSchemas(dir, metadata)) {
            if (!schema.get_path())
                continue;
            const settings = new Gio.Settings({settings_schema: schema});
            for (const key of schema.list_keys()) {
                if (schema.get_key(key).get_value_type().dup_string() !== 'as')
                    continue;
                const action = schema.get_key(key).get_summary() || key;
                yield new Binding({settings, key, owner, action});
            }
        }
    }
}

/**
 * Every other binding that uses one of our accelerators.
 *
 * @param {Map<string, string>} ours - our accelerator → what it does
 * @param {string} ownUuid - our extension, left out of the search
 * @returns {Array<{accelerator: string, ours: string, binding: Binding}>}
 */
export function findConflicts(ours, ownUuid) {
    const found = [];
    const sources = [gnomeBindings(), customBindings(), extensionBindings(ownUuid)];
    for (const source of sources) {
        try {
            for (const binding of source) {
                for (const accelerator of binding.accelerators) {
                    for (const [mine, what] of ours) {
                        if (Accel.same(accelerator, mine))
                            found.push({accelerator: mine, ours: what, binding});
                    }
                }
            }
        } catch (e) {
            console.warn(`[virtual-desktops] Looking for shortcut conflicts: ${e.message}`);
        }
    }
    return found;
}
