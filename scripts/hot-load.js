// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire

// Loads (or reloads) the installed Virtual Desktops extension into the running
// GNOME Shell without logging out. Not part of the extension itself; it is
// only run by hand. install.sh puts it in ~/.local/share/virtual-desktops/.
// Run it from Looking Glass (Alt+F2, type "lg", Enter) with:
//
//   eval(new TextDecoder().decode(imports.gi.GLib.file_get_contents(imports.gi.GLib.get_user_data_dir() + '/virtual-desktops/hot-load.js')[1]))
//
// GJS caches ES modules by URL, so reloading in place would keep running the
// old code. Instead this copies the installed extension to a fresh folder
// under $XDG_RUNTIME_DIR (cleared at logout) and loads it from there. The
// next real login loads the normal installed copy as usual.
(() => {
    const {Gio, GLib} = imports.gi;
    const uuid = 'virtual-desktops@jire.github.io';
    const PER_USER = 2;
    const mgr = Main.extensionManager;

    const src = Gio.File.new_for_path(GLib.build_filenamev(
        [GLib.get_user_data_dir(), 'gnome-shell', 'extensions', uuid]));
    const dest = Gio.File.new_for_path(GLib.build_filenamev(
        [GLib.get_user_runtime_dir(), 'vdesk-hot', String(GLib.get_real_time()), uuid]));

    const copyDir = (from, to) => {
        to.make_directory_with_parents(null);
        const children = from.enumerate_children('standard::name,standard::type', 0, null);
        let info;
        while ((info = children.next_file(null))) {
            const name = info.get_name();
            if (info.get_file_type() === Gio.FileType.DIRECTORY)
                copyDir(from.get_child(name), to.get_child(name));
            else if (info.get_file_type() === Gio.FileType.REGULAR)
                from.get_child(name).copy(to.get_child(name), Gio.FileCopyFlags.OVERWRITE, null, null);
        }
    };
    copyDir(src, dest);

    // Unloading gives GNOME its dynamic workspaces back until the new copy
    // takes over again, and GNOME would delete every empty desktop in that
    // moment. Hold its workspace bookkeeping still while reloading.
    const holdWorkspaces = () => (Main.wm.blockWorkspaceUpdates
        ? Main.wm.blockWorkspaceUpdates() : Main.wm._workspaceTracker?.blockUpdates());
    const releaseWorkspaces = () => (Main.wm.unblockWorkspaceUpdates
        ? Main.wm.unblockWorkspaceUpdates() : Main.wm._workspaceTracker?.unblockUpdates());

    // Taking over, the new copy keeps the desktops in use (like at login),
    // which would drop empty ones at the end. Mutter applies that a moment
    // later, so overrule it with the count from before the reload.
    const desktops = global.workspace_manager.get_n_workspaces();
    const keepDesktops = () => {
        if (new Gio.Settings({schema_id: 'org.gnome.mutter'}).get_boolean('dynamic-workspaces'))
            return; // GNOME's dynamic workspaces: GNOME decides.
        new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'}).set_int('num-workspaces', desktops);
    };

    (async () => {
        holdWorkspaces();
        try {
            if (mgr.lookup(uuid))
                await mgr.unloadExtension(mgr.lookup(uuid));
            // Shell refuses to load a code change after an unload; we sidestep
            // the module cache with the fresh folder, so lift that guard.
            mgr._unloadedExtensions?.delete(uuid);
            const ext = mgr.createExtensionObject(uuid, dest, PER_USER);
            await mgr.loadExtension(ext);
            if (mgr.lookup(uuid)?.state === 1)
                keepDesktops();
            const err = mgr.lookup(uuid)?.error;
            Main.notify('Virtual Desktops',
                err ? `Failed to load: ${err}` : `Loaded (state ${mgr.lookup(uuid)?.state}).`);
        } catch (e) {
            logError(e, `[${uuid}] hot-load`);
            Main.notify('Virtual Desktops', `Failed to load: ${e.message}`);
        } finally {
            releaseWorkspaces();
        }
    })();

    return `loading ${uuid} from ${dest.get_path()}`;
})();
