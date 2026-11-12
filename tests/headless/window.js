// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// A plain GTK 4 window for the headless tests: gjs -m window.js TITLE COLOR W H
// Shows TITLE in big letters on COLOR, so screenshots are easy to read.

import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

const [title = 'Window', color = '#3584e4', width = '640', height = '420'] = System.programArgs;

Gtk.init();
const loop = GLib.MainLoop.new(null, false);

const css = new Gtk.CssProvider();
const rules = `window.vdesk-test { background: ${color}; }
    label.vdesk-test { color: white; font-size: 44px; font-weight: 800; }`;
if (css.load_from_string)
    css.load_from_string(rules);
else
    css.load_from_data(rules, -1);
Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css,
    Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

const win = new Gtk.Window({
    title,
    default_width: Number(width),
    default_height: Number(height),
    css_classes: ['vdesk-test'],
});
win.set_child(new Gtk.Label({label: title, css_classes: ['vdesk-test']}));
win.connect('close-request', () => {
    loop.quit();
    return false;
});
win.present();
loop.run();
