# AGENTS.md

Guidance for AI coding assistants (Claude Code, Codex, Copilot, Cursor and others) working in this repository or helping someone install or use it.

## What this is

Virtual Desktops is a GNOME Shell extension (GJS, ES modules) that brings Windows 11's virtual desktops to GNOME with the same shortcuts: Super+Ctrl+←/→ switch desktops (with a bounce at the first and last one), Super+Ctrl+D creates a desktop at the end and switches to it, Super+Ctrl+F4 closes the current one (its windows move to the desktop on the left and stay where they are on screen). The desktop's name pops up while switching, desktops persist until closed, and every display switches together.

- UUID: `virtual-desktops@jire.github.io`
- Supported GNOME Shell: 46–51. Developed on 51; the scenario tests below pass on 46, 48, 49, 50 and 51 (47 sits between 46 and 48 and uses the same code paths as 46).
- License: GPL-2.0-or-later

## Helping someone install it

Point them to the one-line installer in [README.md](README.md#install). It installs per user (never with `sudo`). On Wayland the extension loads at the next login; to load it without logging out, use the Looking Glass line in the README. Settings: `gnome-extensions prefs virtual-desktops@jire.github.io`.

If a shortcut does nothing, the settings window lists other shortcuts on the same keys and can unassign them. For anything else, have them turn on **Debug logging** in the settings and run `journalctl --user -f -g virtual-desktops` while they reproduce it.

## Layout

| Path | Purpose |
| --- | --- |
| `extension/` | Everything that ships in the extension zip |
| `extension/extension.js` | Entry point: creates the parts below, and undoes everything in `disable()` (also after a failed `enable()`) |
| `extension/desktops.js` | What the shortcuts do: switch, bounce at the ends, create, close (with the closed desktop's windows pinned during the slide) |
| `extension/keybindings.js` | Registers the four shortcuts with GNOME Shell; drops them while locked or while the settings window records a shortcut |
| `extension/workspaceMode.js` | Turns off GNOME's dynamic workspaces and "workspaces on primary display only" while enabled, backed up in our settings, restored on disable |
| `extension/flyout.js` | The Windows 11-style desktop name flyout (frosted panel, light/dark, optional position dots) |
| `extension/bounce.js` | The bounce at the first/last desktop: a clone of the desktop nudged and sprung back |
| `extension/workspaces.js` | Small helpers: a workspace's own windows, emptiness, the 36-workspace limit |
| `extension/names.js` | Desktop names in GNOME's `workspace-names` (shifted when a desktop closes). Gio only; shared with the settings window |
| `extension/compat.js` | Every Shell API that differs between GNOME 46 and 51, in one place |
| `extension/prefs.js` | Settings window (libadwaita) |
| `extension/shortcutEditor.js` | Settings: shortcut rows (keycaps in Windows order) and the "press the new shortcut" dialog |
| `extension/accelerators.js` | Settings: parsing, comparing and writing accelerators the way Mutter reads them |
| `extension/conflicts.js` | Settings: finds GNOME, custom and other extensions' shortcuts on the same keys |
| `extension/stylesheet.css` | Flyout styles; the active dot's accent colour is set from JavaScript |
| `extension/schemas/` | GSettings schema XML only. GNOME 44+ and `install.sh` compile it at install time; don't commit or ship `gschemas.compiled` |
| `tests/unit.test.js` | Unit tests (names, accelerators): `gjs -m tests/unit.test.js` |
| `tests/conflicts.test.js` | The conflict finder against a throwaway settings store: `gjs -m tests/conflicts.test.js` |
| `tests/headless/` | Scenario tests in a real, separate, headless GNOME Shell; see below |
| `scripts/hot-load.js` | Looking Glass loader for reloading without logging out (holds GNOME's workspace tracker still meanwhile, so empty desktops survive the moment dynamic workspaces are back on). Not shipped in the extension zip; `install.sh` puts it in `~/.local/share/virtual-desktops/` |
| `install.sh` | User-facing installer (curl/wget pipe), also `--uninstall`, `--version`, `--zip` |
| `scripts/build.sh` | Builds `dist/<uuid>.shell-extension.zip` |
| `.github/workflows/ci.yml` | Syntax check, ESLint, unit tests, schema check, ShellCheck, build; publishes a release on `v*` tags |

## How it works, briefly

- **Switching** calls `Meta.Workspace.activate()`, so GNOME draws its own slide and Mutter focuses that desktop's last used window. ← / → map to the previous / next index, flipped for right-to-left languages; vertical layouts use ← for previous. At the ends, `bounce.js` lays a snapshot of the desktop (wallpaper + `Clutter.Clone`s of its windows, windows on every desktop held still) over the real one, above `global.window_group` like GNOME's own animation, with GNOME's `workspace-animation` style for the gap colour, and eases it out and back.
- **Closing** moves minimized windows straight to the target desktop and *pins* the visible ones (`stick()`, what "Always on Visible Workspace" does), so GNOME's slide draws them still while the other desktop slides in underneath. The workspace is removed right after activating the target (Mutter allows windows on all workspaces in a removed workspace's list). The windows are unpinned and moved once GNOME destroys its animation actors (`MonitorGroup`, one per monitor), or as soon as another switch starts (`active-workspace-changed` fires before Mutter replaces the animation). On GNOME 46–49 a window must never stop being pinned while that animation runs: its `restacked` handler throws for windows it has no clone of.
- **Creating** appends a workspace and activates it, clearing any stale name at that position. With GNOME's dynamic workspaces on, the spare empty workspace at the end *is* the new desktop.
- **Names** live in `org.gnome.desktop.wm.preferences workspace-names`. GNOME doesn't shift them when a workspace goes away; `names.js` does, so custom names stay with their desktop and unnamed ones renumber ("Desktop N"), like Windows.
- **GNOME settings** (`workspaceMode.js`): dynamic workspaces and workspaces-only-on-primary are turned off while the matching option is on. The original value goes into `saved-*` keys in our schema first, so a crash or logout can't lose it, and comes back on disable. If either is turned back on elsewhere (GNOME Settings), the matching option turns off instead of fighting over it. `num-workspaces` is set to the desktops in use before dynamic workspaces go off, so nothing is lost or added.
- **Keys**: `Main.wm.addKeybinding()` with our own schema keys (`virtual-desktop-*`; Mutter's keybinding names are global). New and close ignore key repeat. The settings window sets `suspend-shortcuts` while recording, so the current keys reach it; the extension clears that after 60 s in case the settings window died.
- **Session modes**: `unlock-dialog` is included so locking the screen doesn't disable the extension: that would give GNOME back its dynamic workspaces, which deletes every empty desktop. The shortcuts are removed while locked and nothing is shown on the lock screen. For the same reason `install.sh --uninstall` puts GNOME's settings back itself if the extension couldn't (it reads the `saved-*` keys with `gsettings --schemadir`).

## Conventions

- Every `connect` needs a matching `disconnect` (use `connectObject` / `disconnectObject` in the Shell; the settings window keeps a list), and `disable()` must undo everything `enable()` did: actors, timers, keybindings, GNOME settings, pinned windows.
- Every `disableUnredirect()` needs exactly one `enableUnredirect()` (the headless tests count them), or fullscreen apps stay composited.
- APIs that differ between versions go through `compat.js`. Use `compat.vbox()` for vertical `St.BoxLayout`s.
- Don't name a property `content` on a Clutter actor subclass: it's a ClutterActor property.
- Start new source files with the SPDX header used in the existing files. Logging during normal operation goes through `ext.log()`, which only logs when the `debug` setting is on.

## Checking changes

```bash
npx --yes eslint@9 .
gjs -m tests/unit.test.js && gjs -m tests/conflicts.test.js
shellcheck -x install.sh scripts/*.sh tests/headless/*.sh
tests/headless/run.sh            # all scenarios in a headless GNOME Shell (a few minutes)
scripts/build.sh && ./install.sh --zip dist/*.shell-extension.zip
```

Then reload with the Looking Glass line from the README. Reloading the user's live session is their call, so ask before suggesting it.

### Testing in a headless GNOME Shell (never the live session)

`tests/headless/run.sh [name filter]` builds the extension, starts a separate headless GNOME Shell with two virtual monitors, runs every scenario in `tests/headless/scenarios.js` (real key presses through a virtual keyboard, real GTK windows from `window.js`) and prints the results; `VDESK_SHOTS=1` keeps screenshots of the interesting moments. `tests/headless/session.sh start|eval|eval-file|shot|run|stop DIR` gives you such a shell to poke at by hand, e.g. to open the settings window inside it with `Main.extensionManager.openExtensionPrefs(...)`.

How `lib.sh` keeps it apart from the real session: the isolated environment (own `HOME`, `XDG_*` folders, `XDG_RUNTIME_DIR`, `GSETTINGS_BACKEND=keyfile`) is exported *before* `dbus-run-session`, because D-Bus activated helpers inherit the bus daemon's environment, not the shell's; everything runs in a transient `systemd-run --user --scope` that is stopped as a whole. Keep the runtime folder's path short (`VDESK_RUNTIME_PARENT`): Unix socket paths are limited to 108 bytes. A test-only helper extension turns on unsafe mode so `org.gnome.Shell.Eval` works; `gdbus call` reads its arguments as GVariant text, so `vdesk_eval` passes scripts as an escaped string literal.

`tests/headless/demo.sh` records `docs/demo.gif` the same way, with real apps; animations are slowed down while frames are taken and the frames are played back at their real speed.

### Older GNOME versions

`tests/headless/sandbox.sh VERSION DIR` installs GNOME 46, 47, 48, 49 or 50 from an Arch Linux Archive snapshot into a folder without root (`unshare -r pacman --root …`) and prints a bubblewrap command (own `/usr` and `/etc`, software rendering) to pass as `VDESK_SHELL`:

```bash
VDESK_SHELL="$(tests/headless/sandbox.sh 46 ~/gnome-sandboxes)" tests/headless/run.sh
```

Snapshots used: 46 = 2024/06/15, 47 = 2024/11/20, 48 = 2025/06/15, 49 = 2025/11/20, 50 = 2026/05/20. Test windows are started from inside the shell, so they use that version's GTK.

## Releasing

Tag and push (`git tag -a vN -m vN && git push origin vN`). CI builds the zip and attaches it to the GitHub release, and the installer always fetches `releases/latest`. Upload that same zip at [extensions.gnome.org/upload](https://extensions.gnome.org/upload/), which reviews each version before publishing it. Don't add a `version` key to `metadata.json`: extensions.gnome.org sets it. When a new GNOME version comes out, check the APIs listed at the top of `compat.js` and the workspace animation internals described above, run the scenarios, then add it to `shell-version`.

Everything shipped in `extension/` must pass the [extensions.gnome.org review guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html). Keep it free of build or dev files. Notes for the review: the `unlock-dialog` session mode is deliberate (disabling on lock would give GNOME back its dynamic workspaces, which deletes the user's empty desktops; there's no UI or input handling on the lock screen), and the extension changes `org.gnome.mutter dynamic-workspaces`, `workspaces-only-on-primary` and `org.gnome.desktop.wm.preferences num-workspaces` only while enabled, restoring them on disable.
