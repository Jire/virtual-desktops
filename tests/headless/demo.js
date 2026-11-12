// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// Records the frames of docs/demo.gif inside a headless test shell (run by
// demo.sh over org.gnome.Shell.Eval). Animations are slowed down by
// CONFIG.factor while screenshots are taken back to back; demo.sh plays the
// frames back at the real speed using the timestamps written to frames.txt.

/* global Main, Meta, Shell, GLib, Gio, __CONFIG__ */

(async () => {
    const CONFIG = __CONFIG__;
    const {Clutter, St} = imports.gi;
    const F = CONFIG.factor;
    const wm = global.workspace_manager;

    const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
    const waitFor = async (cond, ms) => {
        const end = GLib.get_monotonic_time() + ms * 1000;
        while (GLib.get_monotonic_time() < end && !cond())
            await sleep(50);
        return cond();
    };
    const windows = () => global.get_window_actors().map(a => a.meta_window);

    // -- Apps ---------------------------------------------------------------

    /** Start an app and place its (first new) window at [x, y, width, height]. */
    const launch = async (argv, [x, y, w, h]) => {
        const before = new Set(windows());
        const env = GLib.get_environ().filter(e => !e.startsWith('SHELL='));
        GLib.spawn_async(CONFIG.home, argv, [...env, 'SHELL=/bin/bash'], GLib.SpawnFlags.SEARCH_PATH, null);
        const fresh = () => windows().find(win => !before.has(win) &&
            win.get_window_type() === Meta.WindowType.NORMAL && win.get_compositor_private()?.visible);
        if (!await waitFor(fresh, 30000))
            throw new Error(`${argv[0]} didn't open`);
        await sleep(1500);
        const win = fresh();
        win.move_resize_frame(true, x, y, w, h);
        await sleep(500);
        return win;
    };

    const backend = global.stage.context?.get_backend?.() ?? Clutter.get_default_backend();
    const keyboard = backend.get_default_seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    const press = async keyvals => {
        for (const k of keyvals) {
            keyboard.notify_keyval(GLib.get_monotonic_time(), k, Clutter.KeyState.PRESSED);
            await sleep(15);
        }
        for (const k of [...keyvals].reverse()) {
            keyboard.notify_keyval(GLib.get_monotonic_time(), k, Clutter.KeyState.RELEASED);
            await sleep(15);
        }
    };

    Main.overview.hide();
    await waitFor(() => !Main.overview.visible, 5000);
    wm.get_workspace_by_index(0).activate(global.get_current_time());
    await sleep(500);
    await launch(['nautilus', '--new-window', CONFIG.home], [150, 120, 1040, 680]);
    const editor = await launch(['gnome-text-editor', '--standalone', `${CONFIG.home}/Documents/Plans.md`],
        [880, 330, 900, 600]);

    const ext = Main.extensionManager.lookup('virtual-desktops@jire.github.io').stateObj;
    ext.desktops.newDesktop();
    await sleep(1500);
    const terminal = await launch(['kgx', `--working-directory=${CONFIG.home}/Projects/website`], [440, 190, 1040, 640]);
    terminal.activate(global.get_current_time());
    await sleep(800);
    for (const key of ['g', 'i', 't', 'space', 'l', 'o', 'g', 'space', 'minus', 'minus', 'o', 'n', 'e', 'l', 'i', 'n', 'e', 'Return'])
        await press([Clutter[`KEY_${key}`]]);
    await sleep(1000);
    wm.get_workspace_by_index(0).activate(global.get_current_time());
    await sleep(1500);
    ext.flyout.hide(false);
    editor.activate(global.get_current_time());
    await sleep(800);

    // -- Keys overlay -----------------------------------------------------------

    const monitor = Main.layoutManager.primaryMonitor;
    const overlay = new St.BoxLayout({
        style: 'background-color: rgba(20, 20, 24, 0.72); border-radius: 18px; padding: 12px 18px; ' +
            'spacing: 10px; border: 1px solid rgba(255, 255, 255, 0.10);',
        opacity: 0,
    });
    Main.uiGroup.add_child(overlay);
    const showKeys = keys => {
        overlay.destroy_all_children();
        keys.forEach((key, i) => {
            if (i > 0) {
                overlay.add_child(new St.Label({
                    text: '+',
                    y_align: Clutter.ActorAlign.CENTER,
                    style: 'color: rgba(255,255,255,0.75); font-size: 16pt; font-weight: 600;',
                }));
            }
            overlay.add_child(new St.Label({
                text: key,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'background-color: #f6f6f8; color: #1d1d20; border-radius: 8px; padding: 5px 14px 7px; ' +
                    'font-size: 16pt; font-weight: 700; box-shadow: inset 0 -3px rgba(0, 0, 0, 0.22);',
            }));
        });
        const [, width] = overlay.get_preferred_width(-1);
        overlay.set_position(Math.round(monitor.x + (monitor.width - width) / 2), monitor.y + monitor.height - 150);
        Main.uiGroup.set_child_above_sibling(overlay, null);
        overlay.ease({opacity: 255, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    };
    const hideKeys = () => overlay.ease({opacity: 0, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});

    // -- Recording ----------------------------------------------------------------

    const frames = [];
    let recording = true;
    const capture = async () => {
        let n = 0;
        while (recording) {
            const file = `${CONFIG.out}/f${String(n++).padStart(4, '0')}.png`;
            const time = GLib.get_monotonic_time();
            await new Promise(resolve => {
                const stream = Gio.File.new_for_path(file).replace(null, false, Gio.FileCreateFlags.NONE, null);
                new Shell.Screenshot().screenshot(false, stream, (shooter, res) => {
                    try {
                        shooter.screenshot_finish(res);
                    } catch (e) {
                        log(e);
                    }
                    stream.close(null);
                    resolve();
                });
            });
            frames.push(`${file} ${time}`);
        }
    };

    const realSleep = ms => sleep(ms * F);
    const step = async (labels, keyvals, holdMs) => {
        showKeys(labels);
        await realSleep(320);
        await press(keyvals);
        await realSleep(700);
        hideKeys();
        await realSleep(holdMs);
    };

    Main.overview.hide();
    await waitFor(() => !Main.overview.visible, 5000);
    await sleep(500);
    St.Settings.get().slow_down_factor = F;
    const capturing = capture();
    await realSleep(1100);

    const SUPER = Clutter.KEY_Super_L, CTRL = Clutter.KEY_Control_L;
    await step(['Super', 'Ctrl', '→'], [SUPER, CTRL, Clutter.KEY_Right], 450);
    await step(['Super', 'Ctrl', '→'], [SUPER, CTRL, Clutter.KEY_Right], 450);
    await step(['Super', 'Ctrl', 'D'], [SUPER, CTRL, Clutter.KEY_d], 450);
    await step(['Super', 'Ctrl', '←'], [SUPER, CTRL, Clutter.KEY_Left], 450);
    await step(['Super', 'Ctrl', 'F4'], [SUPER, CTRL, Clutter.KEY_F4], 1500);

    recording = false;
    await capturing;
    St.Settings.get().slow_down_factor = 1;
    overlay.destroy();

    GLib.file_set_contents(`${CONFIG.out}/frames.txt`, `${frames.join('\n')}\n`);
    return `${frames.length} frames`;
})();
