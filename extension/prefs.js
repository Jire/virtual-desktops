// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as Accel from './accelerators.js';
import {extensionSettings, findConflicts} from './conflicts.js';
import {DesktopNames, defaultName} from './names.js';
import {isDefaultShortcut, keycapBox, ShortcutRow} from './shortcutEditor.js';

const SHORTCUTS = [
    {
        key: 'virtual-desktop-left',
        title: 'Switch to the desktop on the left',
        subtitle: 'Bounces at the first desktop',
    },
    {
        key: 'virtual-desktop-right',
        title: 'Switch to the desktop on the right',
        subtitle: 'Bounces at the last desktop',
    },
    {
        key: 'virtual-desktop-new',
        title: 'Create a new desktop',
        subtitle: 'Adds it at the end and switches to it',
    },
    {
        key: 'virtual-desktop-close',
        title: 'Close the current desktop',
        subtitle: 'Its windows move to the desktop on the left',
    },
];

// Taskbars and docks that can show only the current desktop's apps, like
// Windows 11's taskbar does by default.
const TASKBARS = [
    {uuid: 'dash-to-panel@jderose9.github.com', schema: 'org.gnome.shell.extensions.dash-to-panel', name: 'Dash to Panel'},
    {uuid: 'ubuntu-dock@ubuntu.com', schema: 'org.gnome.shell.extensions.dash-to-dock', name: 'Ubuntu Dock'},
    {uuid: 'dash-to-dock@micxgx.gmail.com', schema: 'org.gnome.shell.extensions.dash-to-dock', name: 'Dash to Dock'},
];

/** Windows 11's Task View strip, in the system accent colour. */
function illustration() {
    const style = Adw.StyleManager.get_default();
    const area = new Gtk.DrawingArea({
        content_width: 420,
        content_height: 128,
        halign: Gtk.Align.CENTER,
        margin_top: 4,
        margin_bottom: 8,
    });

    const round = (cr, x, y, w, h, r) => {
        cr.newSubPath();
        cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
        cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
        cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
        cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
        cr.closePath();
    };

    area.set_draw_func((a, cr, width, height) => {
        const dark = style.dark;
        const accent = style.get_accent_color_rgba?.() ?? null;
        const [ar, ag, ab] = accent ? [accent.red, accent.green, accent.blue] : [0.21, 0.52, 0.89];
        const ink = dark ? [1, 1, 1] : [0, 0, 0];

        const W = 86, H = 54, GAP = 16, N = 4;
        const ox = (width - (N * W + (N - 1) * GAP)) / 2, oy = 18;

        const label = (text, cx, y, bold, alpha) => {
            const layout = a.create_pango_layout(text);
            const font = a.get_pango_context().get_font_description().copy();
            font.set_size(Math.round(8.5 * Pango.SCALE));
            font.set_weight(bold ? Pango.Weight.BOLD : Pango.Weight.NORMAL);
            layout.set_font_description(font);
            const [, logical] = layout.get_pixel_extents();
            cr.moveTo(cx - logical.width / 2, y);
            cr.setSourceRGBA(...ink, alpha);
            PangoCairo.show_layout(cr, layout);
        };

        const window = (x, y, w, h) => {
            round(cr, x + 0.5, y + 1.5, w, h, 3);
            cr.setSourceRGBA(0, 0, 0, dark ? 0.35 : 0.12);
            cr.fill();
            round(cr, x, y, w, h, 3);
            cr.setSourceRGB(...(dark ? [0.27, 0.27, 0.30] : [0.99, 0.99, 1]));
            cr.fill();
            cr.rectangle(x, y + 6, w, 0.7);
            cr.setSourceRGBA(...ink, 0.10);
            cr.fill();
        };

        const desktops = [
            {name: 'Desktop 1', windows: [[0.10, 0.16, 0.56, 0.66], [0.38, 0.28, 0.52, 0.56]]},
            {name: 'Desktop 2', windows: [[0.07, 0.14, 0.42, 0.72], [0.52, 0.14, 0.41, 0.72]], current: true},
            {name: 'Desktop 3', windows: []},
        ];

        desktops.forEach((d, i) => {
            const x = ox + i * (W + GAP);
            // Wallpaper, tinted with the accent colour.
            round(cr, x, oy, W, H, 6);
            cr.setSourceRGB(...(dark ? [0.17, 0.17, 0.20] : [0.85, 0.87, 0.91]));
            cr.fillPreserve();
            cr.setSourceRGBA(ar, ag, ab, dark ? 0.22 : 0.20);
            cr.fill();
            for (const [wx, wy, ww, wh] of d.windows)
                window(x + wx * W, oy + wy * H, ww * W, wh * H);
            if (d.current) {
                round(cr, x - 3, oy - 3, W + 6, H + 6, 8);
                cr.setSourceRGB(ar, ag, ab);
                cr.setLineWidth(2.2);
                cr.stroke();
            }
            label(d.name, x + W / 2, oy + H + 9, d.current, d.current ? 0.95 : 0.7);
        });

        // "New desktop": a dashed tile with a plus, like Task View's.
        const x = ox + 3 * (W + GAP);
        round(cr, x + 0.5, oy + 0.5, W - 1, H - 1, 6);
        cr.setSourceRGBA(...ink, 0.04);
        cr.fillPreserve();
        cr.setDash([4, 3], 0);
        cr.setSourceRGBA(...ink, 0.28);
        cr.setLineWidth(1);
        cr.stroke();
        cr.setDash([], 0);
        cr.setSourceRGBA(...ink, 0.55);
        cr.setLineWidth(2);
        cr.moveTo(x + W / 2 - 7, oy + H / 2);
        cr.lineTo(x + W / 2 + 7, oy + H / 2);
        cr.moveTo(x + W / 2, oy + H / 2 - 7);
        cr.lineTo(x + W / 2, oy + H / 2 + 7);
        cr.stroke();
        label('New desktop', x + W / 2, oy + H + 9, false, 0.7);

        cr.$dispose();
    });
    const ids = [
        style.connect('notify::dark', () => area.queue_draw()),
        style.connect('notify::accent-color-rgba', () => area.queue_draw()),
    ];
    area.connect('destroy', () => ids.forEach(id => style.disconnect(id)));
    return area;
}

export default class VirtualDesktopsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        window.set_default_size(680, 880);
        window.set_search_enabled?.(true);

        // Signal handlers on settings outlive widgets unless disconnected.
        this._handlers = [];
        window.connect('close-request', () => {
            for (const [object, id] of this._handlers)
                object.disconnect(id);
            this._handlers = [];
            return false;
        });

        const page = new Adw.PreferencesPage({
            title: 'Virtual Desktops',
            icon_name: 'preferences-desktop-multitasking-symbolic',
        });
        window.add(page);

        const hero = new Adw.PreferencesGroup();
        hero.add(illustration());
        page.add(hero);

        this._conflictGroup = new Adw.PreferencesGroup({
            title: 'Shortcut conflicts',
            description: 'These keys also do something else. GNOME runs only one of the two, and which one ' +
                'is down to chance, so take the keys off the other one.',
            visible: false,
        });
        this._conflictRows = [];
        page.add(this._conflictGroup);
        this._settings = settings;
        this._window = window;

        this._addShortcuts(page, settings);
        this._addBehaviour(page, settings);
        this._addNames(page);
        this._addMoreLikeWindows(page);
        this._addTroubleshooting(page, settings);
        this._addAbout(page);

        // Conflicts go right under the picture, and are looked for again
        // whenever the shortcuts change or you come back to the window
        // (they may have been fixed in GNOME Settings in the meantime).
        this._updateConflicts();
        for (const {key} of SHORTCUTS)
            this._on(settings, `changed::${key}`, () => this._updateConflicts());
        this._on(window, 'notify::is-active', () => {
            if (window.is_active)
                this._updateConflicts();
        });
    }

    _on(object, signal, handler) {
        this._handlers.push([object, object.connect(signal, handler)]);
    }

    // -- Keyboard shortcuts ---------------------------------------------------

    _addShortcuts(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Keyboard shortcuts',
            description: 'The same keys as on Windows 11. Select a shortcut to change it.',
        });
        page.add(group);

        const labelFor = (accelerator, exceptKey) => {
            const other = SHORTCUTS.find(s => s.key !== exceptKey &&
                settings.get_strv(s.key).some(a => Accel.same(a, accelerator)));
            return other?.title ?? null;
        };

        for (const shortcut of SHORTCUTS)
            group.add(new ShortcutRow({settings, labelFor, ...shortcut}));

        const resetAll = new Gtk.Button({
            label: 'Use Windows Shortcuts',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: 'Put every shortcut back to the one Windows 11 uses',
        });
        resetAll.connect('clicked', () => SHORTCUTS.forEach(s => settings.reset(s.key)));
        group.set_header_suffix(resetAll);
        const syncReset = () => {
            resetAll.visible = SHORTCUTS.some(s => !isDefaultShortcut(settings, s.key));
        };
        for (const {key} of SHORTCUTS)
            this._on(settings, `changed::${key}`, syncReset);
        syncReset();
    }

    _updateConflicts() {
        const group = this._conflictGroup;
        for (const row of this._conflictRows)
            group.remove(row);
        this._conflictRows = [];

        const ours = new Map();
        for (const {key, title} of SHORTCUTS) {
            for (const accelerator of this._settings.get_strv(key))
                ours.set(accelerator, title);
        }
        const conflicts = findConflicts(ours, this.metadata.uuid);
        group.visible = conflicts.length > 0;

        for (const {accelerator, binding} of conflicts) {
            const keys = Accel.keycaps(accelerator).join(' + ');
            const row = new Adw.ActionRow({
                title: `${keys} also does “${binding.action}”`,
                subtitle: binding.owner === 'GNOME'
                    ? 'A GNOME shortcut (Settings › Keyboard › Keyboard Shortcuts)'
                    : binding.owner === 'Custom shortcut'
                        ? 'One of your custom shortcuts in GNOME Settings'
                        : `From the ${binding.owner} extension`,
            });
            row.add_prefix(new Gtk.Image({icon_name: 'dialog-warning-symbolic', css_classes: ['warning']}));
            const button = new Gtk.Button({
                label: 'Unassign',
                valign: Gtk.Align.CENTER,
                tooltip_text: `Take ${keys} off “${binding.action}”`,
                css_classes: ['suggested-action'],
            });
            button.connect('clicked', () => {
                binding.remove(accelerator);
                this._updateConflicts();
            });
            row.add_suffix(button);
            group.add(row);
            this._conflictRows.push(row);
        }
    }

    // -- Behaviour --------------------------------------------------------------

    _addBehaviour(page, settings) {
        const group = new Adw.PreferencesGroup({title: 'Desktops'});
        page.add(group);

        const bindSwitch = (key, title, subtitle) => {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
            return row;
        };

        bindSwitch('persistent-desktops', 'Keep desktops until I close them',
            'Like Windows: empty desktops stay, and they’re still there after you log out. ' +
            'GNOME’s dynamic workspaces are off while this is on.');
        bindSwitch('span-all-displays', 'Switch all displays together',
            'Like Windows: every display changes desktop at once. GNOME on its own only switches ' +
            'the primary display.');
        bindSwitch('bounce', 'Bounce at the first and last desktop',
            'A little nudge when there’s no desktop in that direction');
        bindSwitch('wrap-around', 'Wrap around',
            'Go from the last desktop to the first, and back. Windows doesn’t do this.');

        const choices = ['name', 'gnome', 'none'];
        const indicator = new Adw.ComboRow({
            title: 'When I switch desktops, show',
            subtitle: 'Windows 11 shows the desktop’s name in the middle of the screen',
            model: Gtk.StringList.new(['Its name', 'GNOME’s workspace dots', 'Nothing']),
        });
        const syncIndicator = () => {
            indicator.selected = Math.max(0, choices.indexOf(settings.get_string('switch-indicator')));
        };
        syncIndicator();
        indicator.connect('notify::selected', () => {
            settings.set_string('switch-indicator', choices[indicator.selected] ?? 'name');
        });
        this._on(settings, 'changed::switch-indicator', syncIndicator);
        group.add(indicator);

        const dots = bindSwitch('indicator-dots', 'Show where the desktop is in the row',
            'Dots under the name, the current one in your accent colour');
        const syncDots = () => {
            dots.sensitive = settings.get_string('switch-indicator') === 'name';
        };
        this._on(settings, 'changed::switch-indicator', syncDots);
        syncDots();
    }

    // -- Desktop names ------------------------------------------------------------

    _addNames(page) {
        const group = new Adw.PreferencesGroup({
            title: 'Desktop names',
            description: 'Shown when you switch to a desktop. Leave a name empty to use the default.',
        });
        page.add(group);

        const names = new DesktopNames();
        const mutter = new Gio.Settings({schema_id: 'org.gnome.mutter'});
        let rows = [];
        let saving = false;

        const rebuild = () => {
            for (const row of rows)
                group.remove(row);
            rows = [];

            if (mutter.get_boolean('dynamic-workspaces')) {
                const row = new Adw.ActionRow({
                    title: 'Available while desktops are kept until you close them',
                    subtitle: 'With GNOME’s dynamic workspaces, workspaces come and go, so names wouldn’t stay with them',
                });
                row.add_prefix(new Gtk.Image({icon_name: 'dialog-information-symbolic'}));
                group.add(row);
                rows.push(row);
                return;
            }

            const count = names.settings.get_int('num-workspaces');
            for (let i = 0; i < count; i++) {
                const row = new Adw.EntryRow({title: defaultName(i), text: names.custom(i)});
                let timeoutId = 0;
                const save = () => {
                    if (timeoutId) {
                        GLib.source_remove(timeoutId);
                        timeoutId = 0;
                    }
                    saving = true;
                    names.rename(i, row.text);
                    saving = false;
                };
                // Save as you type (after a pause), and on Enter.
                row.connect('changed', () => {
                    if (timeoutId)
                        GLib.source_remove(timeoutId);
                    timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                        timeoutId = 0;
                        save();
                        return GLib.SOURCE_REMOVE;
                    });
                });
                row.connect('entry-activated', save);
                row.connect('unrealize', () => {
                    if (timeoutId)
                        save();
                });
                group.add(row);
                rows.push(row);
            }
        };

        const refreshTexts = () => {
            if (saving)
                return;
            rows.forEach((row, i) => {
                if (row instanceof Adw.EntryRow && !row.get_focus_child() && row.text !== names.custom(i))
                    row.text = names.custom(i);
            });
        };

        rebuild();
        this._on(mutter, 'changed::dynamic-workspaces', rebuild);
        this._on(names.settings, 'changed::num-workspaces', () => {
            if (rows.length !== names.settings.get_int('num-workspaces'))
                rebuild();
        });
        this._on(names.settings, 'changed::workspace-names', refreshTexts);
    }

    // -- Elsewhere in GNOME --------------------------------------------------------

    _addMoreLikeWindows(page) {
        const group = new Adw.PreferencesGroup({
            title: 'More like Windows',
            description: 'These are GNOME’s own settings (and your taskbar’s), so they stay the way you set them ' +
                'even if this extension is turned off.',
        });
        page.add(group);

        const apps = new Gio.Settings({schema_id: 'org.gnome.shell.app-switcher'});
        const windows = new Gio.Settings({schema_id: 'org.gnome.shell.window-switcher'});
        const altTab = new Adw.SwitchRow({
            title: 'Alt + Tab shows only the windows on the current desktop',
            subtitle: 'Windows 11 does this by default. Also in GNOME Settings › Multitasking',
            active: apps.get_boolean('current-workspace-only'),
        });
        altTab.connect('notify::active', () => {
            for (const switcher of [apps, windows]) {
                if (switcher.get_boolean('current-workspace-only') !== altTab.active)
                    switcher.set_boolean('current-workspace-only', altTab.active);
            }
        });
        this._on(apps, 'changed::current-workspace-only', () => {
            const value = apps.get_boolean('current-workspace-only');
            if (altTab.active !== value)
                altTab.active = value;
        });
        group.add(altTab);

        const enabled = new Gio.Settings({schema_id: 'org.gnome.shell'}).get_strv('enabled-extensions');
        for (const taskbar of TASKBARS) {
            if (!enabled.includes(taskbar.uuid))
                continue;
            const settings = extensionSettings(taskbar.uuid, taskbar.schema);
            if (!settings?.settings_schema.has_key('isolate-workspaces'))
                continue;
            const row = new Adw.SwitchRow({
                title: 'The taskbar shows only the apps on the current desktop',
                subtitle: `${taskbar.name} setting. Windows 11 does this by default.`,
            });
            settings.bind('isolate-workspaces', row, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
        }
    }

    // -- Troubleshooting and about ----------------------------------------------------

    _addTroubleshooting(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Troubleshooting',
            description: 'With debug logging on, follow along with: journalctl --user -f -g virtual-desktops',
        });
        page.add(group);
        const row = new Adw.SwitchRow({title: 'Debug logging', subtitle: 'Log every switch, new desktop and close'});
        settings.bind('debug', row, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(row);
    }

    _addAbout(page) {
        const group = new Adw.PreferencesGroup();
        page.add(group);

        const cheat = new Adw.ExpanderRow({
            title: 'All shortcuts',
            subtitle: 'GNOME’s own workspace shortcuts keep working too',
        });
        const shortcutsRows = [
            [['Super', 'Ctrl', '←'], 'Desktop on the left'],
            [['Super', 'Ctrl', '→'], 'Desktop on the right'],
            [['Super', 'Ctrl', 'D'], 'New desktop'],
            [['Super', 'Ctrl', 'F4'], 'Close desktop'],
            [['Super', 'Page Up'], 'Desktop on the left (GNOME)'],
            [['Super', 'Shift', 'Page Up'], 'Move a window to the desktop on the left (GNOME)'],
            [['Super'], 'All desktops and windows, like Task View (GNOME)'],
        ];
        for (const [keys, text] of shortcutsRows) {
            const row = new Adw.ActionRow({title: text});
            row.add_suffix(keycapBox(keys));
            cheat.add_row(row);
        }
        group.add(cheat);

        const repo = this.metadata.url ?? 'https://github.com/Jire/virtual-desktops';
        const link = (title, uri) => {
            const row = new Adw.ActionRow({title, subtitle: uri, activatable: true});
            row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
            row.connect('activated', () => {
                if (Gtk.UriLauncher)
                    new Gtk.UriLauncher({uri}).launch(this._window, null, null);
                else
                    Gtk.show_uri(this._window, uri, 0);
            });
            group.add(row);
        };
        link('Report a problem or suggest a feature', `${repo}/issues`);
        link('Source code', repo);
    }
}
