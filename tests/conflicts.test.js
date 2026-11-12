// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// Tests the settings window's shortcut conflict finder against a throwaway
// settings store (never yours): a GNOME shortcut, a custom shortcut and
// another extension's shortcut all on our keys, then taking the keys off each.
//
//   gjs -m tests/conflicts.test.js

import 'gi://Gtk?version=4.0';
import 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import System from 'system';

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);

// Run again in an isolated environment: settings in a keyfile in a temporary
// folder. GLib reads these once, so they have to be set before it starts.
if (GLib.getenv('VDESK_ISOLATED') !== '1') {
    const tmp = GLib.dir_make_tmp('vdesk-conflicts-XXXXXX');
    const env = GLib.get_environ().filter(e => !/^(XDG_CONFIG_HOME|XDG_DATA_HOME|GSETTINGS_BACKEND|DBUS_SESSION_BUS_ADDRESS)=/.test(e));
    env.push(`XDG_CONFIG_HOME=${tmp}/config`, `XDG_DATA_HOME=${tmp}/data`, 'GSETTINGS_BACKEND=keyfile', 'VDESK_ISOLATED=1');
    const [, stdout, stderr, status] = GLib.spawn_sync(null, ['gjs', '-m', `${here}/conflicts.test.js`], env,
        GLib.SpawnFlags.SEARCH_PATH, null);
    const decoder = new TextDecoder();
    print(decoder.decode(stdout).trimEnd());
    if (stderr.length)
        printerr(decoder.decode(stderr).trimEnd());
    GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(tmp)}`);
    System.exit(GLib.spawn_check_wait_status(status) ? 0 : 1);
}

const {default: Gio} = await import('gi://Gio');
const {findConflicts} = await import('../extension/conflicts.js');

let failures = 0, count = 0;
function eq(actual, expected, what) {
    count++;
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) {
        print(`  ✔ ${what}`);
    } else {
        failures++;
        print(`  ✘ ${what}\n      expected ${e}\n      got      ${a}`);
    }
}

const source = Gio.SettingsSchemaSource.get_default();
const has = id => !!source.lookup(id, true);

// Another extension, with its schema in its own folder like user-installed ones.
const extDir = `${GLib.get_user_data_dir()}/gnome-shell/extensions/other@test`;
GLib.mkdir_with_parents(`${extDir}/schemas`, 0o755);
GLib.file_set_contents(`${extDir}/metadata.json`, JSON.stringify({
    uuid: 'other@test', name: 'Other Extension', 'settings-schema': 'org.gnome.shell.extensions.other-test',
}));
GLib.file_set_contents(`${extDir}/schemas/org.gnome.shell.extensions.other-test.gschema.xml`, `<schemalist>
  <schema id="org.gnome.shell.extensions.other-test" path="/org/gnome/shell/extensions/other-test/">
    <key name="new-thing" type="as"><default><![CDATA[['<Control><Super>d', '<Alt>n']]]></default>
      <summary>Make a new thing</summary></key>
    <key name="apps" type="as"><default>['firefox.desktop']</default></key>
  </schema>
</schemalist>`);
const [compiled] = GLib.spawn_command_line_sync(`glib-compile-schemas ${GLib.shell_quote(`${extDir}/schemas`)}`);
eq(compiled, true, 'test schema compiles');
const shell = has('org.gnome.shell') ? new Gio.Settings({schema_id: 'org.gnome.shell'}) : null;
shell?.set_strv('enabled-extensions', ['virtual-desktops@jire.github.io', 'other@test']);

let expected = 0;
if (has('org.gnome.desktop.wm.keybindings')) {
    const wm = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.keybindings'});
    wm.set_strv('switch-to-workspace-left', ['<Super>Page_Up', '<Super><Control>Left']);
    expected++;
}
const customSchema = 'org.gnome.settings-daemon.plugins.media-keys.custom-keybinding';
if (has('org.gnome.settings-daemon.plugins.media-keys') && has(customSchema)) {
    const path = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0/';
    new Gio.Settings({schema_id: 'org.gnome.settings-daemon.plugins.media-keys'})
        .set_strv('custom-keybindings', [path]);
    const custom = new Gio.Settings({schema_id: customSchema, path});
    custom.set_string('name', 'Open a terminal');
    custom.set_string('binding', '<Primary><Super>Right');
    expected++;
}
if (shell)
    expected++;

const ours = new Map([
    ['<Super><Control>Left', 'Switch to the desktop on the left'],
    ['<Super><Control>Right', 'Switch to the desktop on the right'],
    ['<Super><Control>d', 'Create a new desktop'],
    ['<Super><Control>F4', 'Close the current desktop'],
]);

print('Shortcut conflicts');
const found = findConflicts(ours, 'virtual-desktops@jire.github.io');
eq(found.length, expected, `finds all ${expected} conflicts`);
for (const {accelerator, binding} of found)
    print(`      ${accelerator} — ${binding.owner}: ${binding.action}`);

const byOwner = owner => found.find(c => c.binding.owner === owner);
if (byOwner('GNOME'))
    eq(byOwner('GNOME').binding.action, 'Switch to workspace left', 'names the GNOME action');
if (byOwner('Custom shortcut'))
    eq(byOwner('Custom shortcut').binding.action, 'Open a terminal', 'names the custom shortcut');
if (shell)
    eq(byOwner('Other Extension')?.binding.action, 'Make a new thing', 'names the other extension and its action');

for (const {accelerator, binding} of found)
    binding.remove(accelerator);
eq(findConflicts(ours, 'virtual-desktops@jire.github.io').length, 0, 'none left after unassigning');
if (has('org.gnome.desktop.wm.keybindings')) {
    eq(new Gio.Settings({schema_id: 'org.gnome.desktop.wm.keybindings'}).get_strv('switch-to-workspace-left'),
        ['<Super>Page_Up'], 'the other GNOME keys are kept');
}
if (shell) {
    const source2 = Gio.SettingsSchemaSource.new_from_directory(`${extDir}/schemas`, source, false);
    const other = new Gio.Settings({settings_schema: source2.lookup('org.gnome.shell.extensions.other-test', false)});
    eq(other.get_strv('new-thing'), ['<Alt>n'], 'the other extension keeps its other keys');
}

print(`\n${count - failures}/${count} passed`);
System.exit(failures ? 1 : 0);
