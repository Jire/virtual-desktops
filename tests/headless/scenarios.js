// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// Scenario tests, evaluated *inside* a headless test GNOME Shell by run.sh
// (over org.gnome.Shell.Eval, where `Main`, `Meta`, `Shell`, `GLib` and `Gio`
// are in scope). Presses real keys with a virtual keyboard, opens real GTK
// windows, and checks what happens. Writes a JSON report to CONFIG.report.
//
// run.sh replaces __CONFIG__ with {report, shots, windowScript, filter}.

/* global Main, Meta, Shell, GLib, Gio, __CONFIG__ */

(async () => {
    const CONFIG = __CONFIG__;
    const {Clutter} = imports.gi;
    const UUID = 'virtual-desktops@jire.github.io';
    const results = [];
    let current = '';

    // -- Helpers ------------------------------------------------------------

    const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
    const check = (name, ok, detail = '') =>
        results.push({scenario: current, name, ok: !!ok, detail: String(detail)});
    const waitFor = async (cond, ms = 5000) => {
        const end = GLib.get_monotonic_time() + ms * 1000;
        while (GLib.get_monotonic_time() < end) {
            if (cond())
                return true;
            await sleep(25);
        }
        return !!cond();
    };

    const wm = global.workspace_manager;
    const count = () => wm.get_n_workspaces();
    const active = () => wm.get_active_workspace_index();
    const ws = i => wm.get_workspace_by_index(i);
    const ext = () => Main.extensionManager.lookup(UUID)?.stateObj ?? null;
    const settings = () => ext().settings;
    const mutter = new Gio.Settings({schema_id: 'org.gnome.mutter'});
    const wmPrefs = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
    const windowsByTitle = title => global.get_window_actors().map(a => a.meta_window)
        .filter(w => w.get_title() === title);
    const indexOf = win => (win.is_on_all_workspaces() ? -1 : win.get_workspace().index());

    const backend = global.stage.context?.get_backend?.() ?? Clutter.get_default_backend();
    const keyboard = backend.get_default_seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    const K = {
        super: Clutter.KEY_Super_L, ctrl: Clutter.KEY_Control_L, shift: Clutter.KEY_Shift_L,
        left: Clutter.KEY_Left, right: Clutter.KEY_Right, d: Clutter.KEY_d, f4: Clutter.KEY_F4,
        pageUp: Clutter.KEY_Page_Up, pageDown: Clutter.KEY_Page_Down,
    };
    const press = async (...keys) => {
        for (const key of keys) {
            keyboard.notify_keyval(GLib.get_monotonic_time(), key, Clutter.KeyState.PRESSED);
            await sleep(12);
        }
        for (const key of [...keys].reverse()) {
            keyboard.notify_keyval(GLib.get_monotonic_time(), key, Clutter.KeyState.RELEASED);
            await sleep(12);
        }
    };
    const shortcut = name => press(K.super, K.ctrl, {left: K.left, right: K.right, new: K.d, close: K.f4}[name]);
    const settle = (ms = 650) => sleep(ms);

    const shot = name => new Promise(resolve => {
        if (!CONFIG.shots) {
            resolve();
            return;
        }
        try {
            const file = Gio.File.new_for_path(`${CONFIG.shots}/${name}.png`);
            const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
            new Shell.Screenshot().screenshot(false, stream, (shooter, res) => {
                try {
                    shooter.screenshot_finish(res);
                } catch (e) {
                    log(`screenshot ${name}: ${e}`);
                }
                stream.close(null);
                resolve();
            });
        } catch (e) {
            log(`screenshot ${name}: ${e}`);
            resolve();
        }
    });

    const openWindow = async (title, color = '#3584e4', width = 640, height = 420) => {
        GLib.spawn_async(null, ['gjs', '-m', CONFIG.windowScript, title, color, `${width}`, `${height}`],
            null, GLib.SpawnFlags.SEARCH_PATH, null);
        const ok = await waitFor(() => windowsByTitle(title).some(w => w.get_compositor_private()?.visible), 15000);
        if (!ok)
            throw new Error(`window ${title} didn't appear`);
        await sleep(150);
        return windowsByTitle(title)[0];
    };
    const closeAllWindows = async () => {
        for (const actor of global.get_window_actors())
            actor.meta_window.delete(global.get_current_time());
        await waitFor(() => global.get_window_actors().length === 0, 8000);
    };
    const setDesktops = async n => {
        // Fixed workspaces: Mutter follows num-workspaces.
        wmPrefs.set_int('num-workspaces', n);
        await waitFor(() => count() === n, 3000);
        ws(0).activate(global.get_current_time());
        await settle();
    };
    const reset = async () => {
        Main.overview.hide();
        await closeAllWindows();
        settings().reset('wrap-around');
        settings().reset('bounce');
        settings().reset('switch-indicator');
        settings().reset('indicator-dots');
        settings().reset('persistent-desktops');
        settings().reset('span-all-displays');
        wmPrefs.reset('workspace-names');
        await waitFor(() => !mutter.get_boolean('dynamic-workspaces'), 3000);
        await setDesktops(1);
        ext().flyout.hide(false);
        await settle(300);
    };

    // Every disable_unredirect() needs its enable_unredirect(), or fullscreen
    // apps stay composited (slower) for the rest of the session. Count them.
    // GNOME's own calls are counted too (they have to balance as well), per
    // caller, so an imbalance says where it comes from.
    const unredirect = new Map(); // caller → {off, on}
    const caller = () => {
        const frames = new Error().stack.split('\n').slice(2)
            .filter(f => !f.includes('/compat.js') && f.trim() !== '');
        return (frames[0] ?? '?').replace(/^.*\/(?=[^/]+:\d+:\d+$)/, '').replace(/^([^@]*)@.*\/([^/]+:\d+):\d+$/, '$1@$2');
    };
    const tally = (key, field) => {
        const entry = unredirect.get(key) ?? {off: 0, on: 0};
        entry[field]++;
        unredirect.set(key, entry);
    };
    const compositor = global.compositor;
    const realOff = compositor.disable_unredirect?.bind(compositor);
    const realOn = compositor.enable_unredirect?.bind(compositor);
    if (realOff && realOn) {
        compositor.disable_unredirect = () => {
            tally(caller(), 'off');
            realOff();
        };
        compositor.enable_unredirect = () => {
            tally(caller(), 'on');
            realOn();
        };
    }

    const scenarios = [];
    const scenario = (name, fn) => scenarios.push({name, fn});

    // -- Scenarios ------------------------------------------------------------

    scenario('enabled and takes over dynamic workspaces', async () => {
        check('extension is active', Main.extensionManager.lookup(UUID)?.state === 1,
            Main.extensionManager.lookup(UUID)?.error ?? '');
        check('dynamic workspaces off', !mutter.get_boolean('dynamic-workspaces'));
        check('original value saved for later', settings().get_string('saved-dynamic-workspaces') === 'true');
        check('original workspace count saved', settings().get_int('saved-num-workspaces') === 4,
            settings().get_int('saved-num-workspaces'));
        check('spare empty workspace dropped', count() === 1, count());
        check('every display switches together', !mutter.get_boolean('workspaces-only-on-primary'));
        check('GNOME’s primary-only setting saved for later',
            settings().get_string('saved-workspaces-only-on-primary') === 'true');
    });

    scenario('Super+Ctrl+D creates a desktop at the end and switches to it', async () => {
        await reset();
        const a = await openWindow('A', '#1c71d8');
        await shortcut('new');
        await sleep(90);
        await shot('new-desktop-mid-slide');
        check('flyout shows the new name', ext().flyout.visible && ext().flyout.text === 'Desktop 2',
            ext().flyout.text);
        await settle();
        await shot('new-desktop-flyout');
        check('two desktops', count() === 2, count());
        check('on the new one', active() === 1, active());
        check('window stayed on desktop 1', indexOf(a) === 0);
        check('num-workspaces follows', wmPrefs.get_int('num-workspaces') === 2, wmPrefs.get_int('num-workspaces'));

        await openWindow('B', '#c01c28');
        await shortcut('new');
        await settle();
        check('a third desktop, at the end', count() === 3 && active() === 2, `${count()} ${active()}`);
        await shortcut('left');
        await shortcut('left');
        await settle();
        await shortcut('new');
        await settle();
        check('created from desktop 1, it still goes at the end', count() === 4 && active() === 3,
            `${count()} ${active()}`);
    });

    scenario('Super+Ctrl+arrows switch, and bounce at the ends', async () => {
        await reset();
        await setDesktops(3);
        await openWindow('A', '#1c71d8');
        await shortcut('right');
        await settle();
        check('right → desktop 2', active() === 1, active());
        await shortcut('right');
        await settle(200);
        check('flyout says Desktop 3', ext().flyout.text === 'Desktop 3', ext().flyout.text);
        await settle();
        check('right → desktop 3', active() === 2, active());

        await shortcut('right');
        await sleep(70);
        check('bounce plays at the last desktop', ext().bounce.playing);
        await shot('bounce-right');
        check('still on desktop 3', active() === 2, active());
        await settle();
        check('bounce cleans up', !ext().bounce.playing &&
            !Main.uiGroup.get_children().some(c => c.has_style_class_name?.('vdesk-bounce')));

        await shortcut('left');
        await shortcut('left');
        await settle();
        check('left, left → desktop 1', active() === 0, active());
        await shortcut('left');
        await sleep(60);
        check('bounce plays at the first desktop', ext().bounce.playing);
        await settle();
        check('still on desktop 1', active() === 0);
        check('empty desktops are kept', count() === 3, count());

        settings().set_boolean('bounce', false);
        await shortcut('left');
        await sleep(60);
        check('no bounce when turned off', !ext().bounce.playing);
        await settle();
    });

    scenario('wrap around (optional)', async () => {
        await reset();
        await setDesktops(3);
        settings().set_boolean('wrap-around', true);
        await shortcut('left');
        await settle();
        check('left from the first → the last', active() === 2, active());
        await shortcut('right');
        await settle();
        check('right from the last → the first', active() === 0, active());
    });

    scenario('Super+Ctrl+F4 closes the desktop; its windows join the one on the left', async () => {
        await reset();
        const a = await openWindow('A', '#1c71d8', 900, 600);
        await shortcut('new');
        await settle();
        const b = await openWindow('B', '#c01c28', 700, 460);
        const c = await openWindow('C', '#26a269', 600, 380);
        c.minimize();
        await settle(300);
        b.activate(global.get_current_time());
        await settle(200);
        await shortcut('new');
        await settle();
        await shortcut('left');
        await settle();
        check('on desktop 2 of 3', active() === 1 && count() === 3, `${active()} ${count()}`);

        const before = b.get_frame_rect();
        await shortcut('close');
        await sleep(80);
        check('B is pinned in place during the slide', b.is_on_all_workspaces());
        await shot('close-mid-slide');
        await settle();
        await shot('close-done');
        check('two desktops left', count() === 2, count());
        check('now on desktop 1', active() === 0, active());
        check('B moved to desktop 1', indexOf(b) === 0, indexOf(b));
        check('B no longer pinned', !b.is_on_all_workspaces());
        const after = b.get_frame_rect();
        check('B kept its position', before.x === after.x && before.y === after.y,
            `${before.x},${before.y} → ${after.x},${after.y}`);
        check('minimized C moved too', indexOf(c) === 0 && c.minimized, indexOf(c));
        check('A stayed', indexOf(a) === 0);
        check('B still has focus', global.display.focus_window === b, global.display.focus_window?.get_title());
        const stack = global.display.sort_windows_by_stacking([a, b]);
        check('B is above the windows already there', stack[stack.length - 1] === b);
        check('the empty desktop on the right is now desktop 2', count() === 2 && windowsByTitle('B').length === 1);
        check('num-workspaces follows', wmPrefs.get_int('num-workspaces') === 2);
    });

    scenario('closing the first desktop moves its windows to the right', async () => {
        await reset();
        const a = await openWindow('A', '#1c71d8');
        await shortcut('new');
        await settle();
        const b = await openWindow('B', '#c01c28');
        await shortcut('left');
        await settle();
        await shortcut('close');
        await settle();
        check('one desktop left', count() === 1, count());
        check('A joined B', indexOf(a) === 0 && indexOf(b) === 0);
        check('A not pinned', !a.is_on_all_workspaces());
        await shortcut('close');
        await settle();
        check('the only desktop can’t be closed', count() === 1 && indexOf(a) === 0);
    });

    scenario('desktop names: custom names stay with their desktop, defaults renumber', async () => {
        await reset();
        await setDesktops(4);
        wmPrefs.set_strv('workspace-names', ['Work', 'Games', '', 'Music']);
        await shortcut('right');
        await settle(150);
        check('flyout shows the custom name', ext().flyout.text === 'Games', ext().flyout.text);
        await settle();
        await shortcut('close');
        await settle(120);
        check('closing Games shows Work', ext().flyout.text === 'Work', ext().flyout.text);
        await settle();
        check('names shifted', JSON.stringify(wmPrefs.get_strv('workspace-names')) === '["Work","","Music"]',
            JSON.stringify(wmPrefs.get_strv('workspace-names')));
        await shortcut('right');
        await settle(150);
        check('unnamed desktop renumbered', ext().flyout.text === 'Desktop 2', ext().flyout.text);
        await settle();
        await shortcut('right');
        await settle(150);
        check('Music moved down with its desktop', ext().flyout.text === 'Music', ext().flyout.text);
        await settle();

        wmPrefs.set_strv('workspace-names', ['Work', '', 'Music', 'Stale']);
        await shortcut('new');
        await settle(150);
        check('a new desktop gets the default name', ext().flyout.text === 'Desktop 4', ext().flyout.text);
        check('stale name cleared', (wmPrefs.get_strv('workspace-names')[3] ?? '') === '',
            JSON.stringify(wmPrefs.get_strv('workspace-names')));
        await settle();
    });

    scenario('flyout options', async () => {
        await reset();
        await setDesktops(3);
        settings().set_boolean('indicator-dots', true);
        await shortcut('right');
        await sleep(250);
        check('flyout with dots', ext().flyout.visible && ext().flyout._dots.visible &&
            ext().flyout._dots.get_n_children() === 3);
        await shot('flyout-dots');
        await settle(1500);
        check('flyout fades away', !ext().flyout.visible);

        settings().set_string('switch-indicator', 'gnome');
        await shortcut('right');
        await sleep(150);
        check('GNOME indicator instead', !!ext().desktops._gnomePopup && !ext().flyout.visible);
        await shot('indicator-gnome');
        await settle(1000);

        settings().set_string('switch-indicator', 'none');
        await shortcut('left');
        await sleep(150);
        check('nothing shown', !ext().flyout.visible && !ext().desktops._gnomePopup);
        await settle();
    });

    scenario('limit of 36 desktops', async () => {
        await reset();
        await setDesktops(36);
        ws(35).activate(global.get_current_time());
        await settle();
        await shortcut('new');
        await sleep(150);
        check('no 37th desktop', count() === 36, count());
        check('says so', ext().flyout.text === 'No more desktops', ext().flyout.text);
        await shot('limit');
        await settle();
    });

    scenario('quick close then switch', async () => {
        await reset();
        await openWindow('A', '#1c71d8');
        await shortcut('new');
        await settle();
        const b = await openWindow('B', '#c01c28');
        await shortcut('new');
        await settle();
        await shortcut('left');
        await settle();
        await shortcut('close');
        await sleep(40);
        await shortcut('right');
        await settle();
        check('B settled on desktop 1', indexOf(b) === 0 && !b.is_on_all_workspaces(), indexOf(b));
        check('moved on to desktop 2', active() === 1 && count() === 2, `${active()} ${count()}`);
        await shortcut('left');
        await settle();
        check('B is on desktop 1 when going back', active() === 0 && indexOf(b) === 0);
    });

    scenario('GNOME’s own workspace keys during a close', async () => {
        await reset();
        await setDesktops(3);
        ws(1).activate(global.get_current_time());
        await settle();
        const b = await openWindow('B', '#c01c28');
        await shortcut('close');
        await sleep(40);
        await press(K.super, K.pageDown);
        await settle();
        check('B settled on desktop 1', indexOf(b) === 0 && !b.is_on_all_workspaces(), indexOf(b));
        check('GNOME switched to desktop 2', active() === 1, active());
    });

    scenario('windows on a second monitor move too', async () => {
        if (Main.layoutManager.monitors.length < 2) {
            check('skipped: one monitor', true);
            return;
        }
        await reset();
        await shortcut('new');
        await settle();
        const b = await openWindow('B', '#c01c28');
        b.move_to_monitor(1);
        await settle(300);
        const monitor = b.get_monitor();
        await shortcut('right');
        await sleep(60);
        await shot('bounce-two-monitors');
        await settle();
        await shortcut('close');
        await settle();
        check('B moved to desktop 1', indexOf(b) === 0, indexOf(b));
        check('B is still on the second monitor', b.get_monitor() === monitor && monitor === 1, b.get_monitor());
    });

    scenario('only the primary display switches (option off)', async () => {
        if (Main.layoutManager.monitors.length < 2) {
            check('skipped: one monitor', true);
            return;
        }
        await reset();
        await setDesktops(2);
        const b = await openWindow('B', '#c01c28');
        b.move_to_monitor(1);
        await settle(300);
        settings().set_boolean('span-all-displays', false);
        await waitFor(() => mutter.get_boolean('workspaces-only-on-primary'), 3000);
        await settle(300);
        check('GNOME’s setting given back', mutter.get_boolean('workspaces-only-on-primary') &&
            settings().get_string('saved-workspaces-only-on-primary') === '');
        check('B is on every desktop now', b.is_on_all_workspaces());
        await shortcut('left');
        await sleep(60);
        check('the bounce only moves the primary display', ext().bounce._groups.length === 1,
            ext().bounce._groups.length);
        await settle();
        await shortcut('close');
        await settle();
        check('closing leaves B alone', b.is_on_all_workspaces() && count() === 1);
        mutter.set_boolean('workspaces-only-on-primary', false);
        await settle(200);
        check('turned off in GNOME Settings: the option stays off', !settings().get_boolean('span-all-displays'));
        mutter.set_boolean('workspaces-only-on-primary', true);
        settings().set_boolean('span-all-displays', true);
        await waitFor(() => !mutter.get_boolean('workspaces-only-on-primary'), 3000);
        check('back on', !mutter.get_boolean('workspaces-only-on-primary') &&
            settings().get_string('saved-workspaces-only-on-primary') === 'true');
        mutter.set_boolean('workspaces-only-on-primary', true);
        await waitFor(() => !settings().get_boolean('span-all-displays'), 3000);
        check('turned back on in GNOME Settings: the option follows', !settings().get_boolean('span-all-displays') &&
            settings().get_string('saved-workspaces-only-on-primary') === '');
    });

    scenario('vertical desktop layout (some extensions use one)', async () => {
        await reset();
        await setDesktops(2);
        wm.override_workspace_layout(Meta.DisplayCorner.TOPLEFT, false, -1, 1);
        await settle(200);
        await shortcut('right');
        await settle();
        check('→ goes to the next desktop', active() === 1, active());
        await shortcut('right');
        await sleep(60);
        const content = ext().bounce._groups[0]?.group.get_first_child();
        check('the bounce goes down/up', !!content && content.translation_y !== 0 && content.translation_x === 0,
            `${content?.translation_x}, ${content?.translation_y}`);
        await settle();
        await shortcut('left');
        await settle();
        check('← goes to the previous desktop', active() === 0, active());
        // GNOME's own layout: one row.
        wm.override_workspace_layout(Meta.DisplayCorner.TOPLEFT, false, 1, -1);
        await settle(200);
    });

    scenario('in the overview', async () => {
        await reset();
        await setDesktops(2);
        Main.overview.show();
        await waitFor(() => Main.overview.visible && !Main.overview.animationInProgress, 3000);
        await shortcut('right');
        await settle();
        check('switches in the overview', active() === 1, active());
        check('no flyout over the overview', !ext().flyout.visible);
        const b = await openWindow('B', '#c01c28');
        if (!Main.overview.visible) {
            Main.overview.show();
            await waitFor(() => Main.overview.visible && !Main.overview.animationInProgress, 3000);
        }
        await shortcut('close');
        await settle();
        check('closes in the overview', count() === 1 && indexOf(b) === 0 && !b.is_on_all_workspaces(),
            `${count()} ${indexOf(b)}`);
        Main.overview.hide();
        await settle();
    });

    scenario('shortcuts pause while the settings window records one', async () => {
        await reset();
        await setDesktops(2);
        settings().set_boolean('suspend-shortcuts', true);
        await settle(100);
        await shortcut('right');
        await settle();
        check('paused', active() === 0, active());
        settings().set_boolean('suspend-shortcuts', false);
        await settle(100);
        await shortcut('right');
        await settle();
        check('back on', active() === 1, active());
    });

    scenario('changed shortcut', async () => {
        await reset();
        await setDesktops(2);
        settings().set_strv('virtual-desktop-right', ['<Super><Alt>bracketright']);
        await settle(100);
        await shortcut('right');
        await settle();
        check('old keys do nothing', active() === 0, active());
        await press(K.super, Clutter.KEY_Alt_L, Clutter.KEY_bracketright);
        await settle();
        check('new keys work', active() === 1, active());
        settings().reset('virtual-desktop-right');
        await settle(100);
    });

    scenario('locking the screen keeps the desktops', async () => {
        await reset();
        await setDesktops(3);
        Main.sessionMode.pushMode('unlock-dialog');
        await settle(300);
        check('still enabled while locked', !!ext());
        check('dynamic workspaces still off', !mutter.get_boolean('dynamic-workspaces'));
        await shortcut('right');
        await settle();
        check('shortcuts do nothing while locked', active() === 0, active());
        Main.sessionMode.popMode('unlock-dialog');
        await settle(300);
        check('desktops kept', count() === 3, count());
        await shortcut('right');
        await settle();
        check('shortcuts back after unlocking', active() === 1, active());
    });

    scenario('GNOME’s dynamic workspaces (option off)', async () => {
        await reset();
        await openWindow('A', '#1c71d8');
        await shortcut('new');
        await settle();
        settings().set_boolean('persistent-desktops', false);
        await waitFor(() => mutter.get_boolean('dynamic-workspaces'), 3000);
        await settle();
        check('dynamic workspaces back on', mutter.get_boolean('dynamic-workspaces'));
        check('saved value cleared', settings().get_string('saved-dynamic-workspaces') === '');
        check('num-workspaces put back', wmPrefs.get_int('num-workspaces') === 4, wmPrefs.get_int('num-workspaces'));
        await shortcut('left');
        await settle(900);
        check('GNOME keeps one spare empty desktop at the end', count() === 2, count());
        await shortcut('new');
        await settle();
        check('new desktop = GNOME’s spare one', active() === 1 && count() === 2, `${active()} ${count()}`);
        await shortcut('close');
        await settle(900);
        check('closing the spare just leaves it', active() === 0 && count() === 2, `${active()} ${count()}`);
        await shortcut('new');
        await settle();
        const b = await openWindow('B', '#c01c28');
        await settle(500);
        await shortcut('close');
        await settle(900);
        check('closing a desktop with windows works', indexOf(b) === 0 && active() === 0, `${indexOf(b)} ${active()}`);

        settings().set_boolean('persistent-desktops', true);
        await waitFor(() => !mutter.get_boolean('dynamic-workspaces'), 3000);
        await settle();
        check('turned back on', !mutter.get_boolean('dynamic-workspaces') &&
            settings().get_string('saved-dynamic-workspaces') === 'true');
    });

    scenario('dynamic workspaces turned on in GNOME Settings', async () => {
        await reset();
        mutter.set_boolean('dynamic-workspaces', true);
        await waitFor(() => !settings().get_boolean('persistent-desktops'), 3000);
        check('the option follows', !settings().get_boolean('persistent-desktops'));
        check('nothing left to restore', settings().get_string('saved-dynamic-workspaces') === '');
        settings().set_boolean('persistent-desktops', true);
        await waitFor(() => !mutter.get_boolean('dynamic-workspaces'), 3000);
        check('and back', !mutter.get_boolean('dynamic-workspaces'));
    });

    scenario('disable gives GNOME its settings back; enable takes over again', async () => {
        await reset();
        await setDesktops(3);
        const savedNumber = settings().get_int('saved-num-workspaces');
        await Main.extensionManager.disableExtension(UUID);
        await settle(300);
        check('dynamic workspaces back on', mutter.get_boolean('dynamic-workspaces'));
        check('num-workspaces put back', savedNumber > 0 && wmPrefs.get_int('num-workspaces') === savedNumber,
            `${wmPrefs.get_int('num-workspaces')} vs ${savedNumber}`);
        check('primary-display-only back on', mutter.get_boolean('workspaces-only-on-primary'));
        check('no leftover actors', !Main.uiGroup.get_children().some(c =>
            c.has_style_class_name?.('vdesk-bounce')));
        await shortcut('right');
        await settle(900);
        check('shortcuts gone', true);
        await Main.extensionManager.enableExtension(UUID);
        await settle(500);
        check('enabled again', Main.extensionManager.lookup(UUID)?.state === 1);
        check('dynamic workspaces off again', !mutter.get_boolean('dynamic-workspaces') &&
            !mutter.get_boolean('workspaces-only-on-primary'));
    });

    scenario('reloading with the Looking Glass line keeps the desktops', async () => {
        await reset();
        await setDesktops(3);
        const before = Main.extensionManager.lookup(UUID).path;
        const [, bytes] = GLib.file_get_contents(CONFIG.hotLoad);
        // What the README's Looking Glass line does.
        eval(new TextDecoder().decode(bytes));
        await waitFor(() => Main.extensionManager.lookup(UUID)?.path !== before &&
            Main.extensionManager.lookup(UUID)?.state === 1, 8000);
        await settle(500);
        check('loaded from a fresh copy', Main.extensionManager.lookup(UUID)?.path !== before &&
            Main.extensionManager.lookup(UUID)?.state === 1, Main.extensionManager.lookup(UUID)?.path);
        check('the empty desktops are still there', count() === 3, count());
        check('dynamic workspaces off again', !mutter.get_boolean('dynamic-workspaces'));
        await shortcut('right');
        await settle();
        check('the shortcuts work', active() === 1, active());
    });

    // -- Run ----------------------------------------------------------------------

    for (const {name, fn} of scenarios) {
        if (CONFIG.filter && !name.includes(CONFIG.filter))
            continue;
        current = name;
        const started = GLib.get_monotonic_time();
        try {
            await fn();
        } catch (e) {
            check('no exception', false, `${e}\n${e.stack ?? ''}`);
        }
        results.push({scenario: name, name: '(time)', ok: true,
            detail: `${Math.round((GLib.get_monotonic_time() - started) / 1000)} ms`, timing: true});
    }

    current = 'after all scenarios';
    await settle(1600);
    if (realOff && realOn) {
        const ours = [...unredirect].filter(([key]) => /flyout|bounce/.test(key));
        const off = ours.reduce((n, [, e]) => n + e.off, 0);
        const on = ours.reduce((n, [, e]) => n + e.on, 0);
        check('our unredirect calls are balanced', off === on && off > 0,
            `${off} off, ${on} on: ${JSON.stringify(ours)}`);
        const others = [...unredirect].filter(([, e]) => e.off !== e.on);
        if (others.length)
            log(`[vdesk-test] unbalanced unredirect calls elsewhere: ${JSON.stringify(others)}`);
        delete compositor.disable_unredirect;
        delete compositor.enable_unredirect;
    }

    const {PACKAGE_VERSION} = await import('resource:///org/gnome/shell/misc/config.js');
    const json = JSON.stringify({shell: PACKAGE_VERSION, results}, null, 2);
    GLib.file_set_contents(CONFIG.report, json);
    return 'done';
})();
