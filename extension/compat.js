// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// The few Mutter/Shell APIs that differ between the supported GNOME versions,
// wrapped so the rest of the extension doesn't have to care.
//
//   GNOME 46–47: Meta.disable_unredirect_for_display(display)
//   GNOME 48+:   global.compositor.disable_unredirect()
//   GNOME 46–47: St.BoxLayout "vertical"; 48+ "orientation" (and later
//                versions drop "vertical")
//   GNOME 46+:   Shell.BlurEffect "radius" (it used to be "sigma")
//   GNOME 48+:   St.Settings "reduced-motion"
//   GNOME 46–49: workspace switch animation snapshots the window list when it
//                starts and throws if a window's stickiness changes before it
//                ends (see desktops.js); 50+ re-sorts its own records instead.

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as WorkspaceAnimation from 'resource:///org/gnome/shell/ui/workspaceAnimation.js';

/** Stop fullscreen apps from bypassing the compositor while we draw over them. */
export function disableUnredirect() {
    if (global.compositor?.disable_unredirect)
        global.compositor.disable_unredirect();
    else
        Meta.disable_unredirect_for_display(global.display);
}

/** Undo one disableUnredirect(). */
export function enableUnredirect() {
    if (global.compositor?.enable_unredirect)
        global.compositor.enable_unredirect();
    else
        Meta.enable_unredirect_for_display(global.display);
}

/** Whether GNOME wants animations right now (system setting + reduced motion). */
export function animationsEnabled() {
    const settings = St.Settings.get();
    if (!settings.enable_animations)
        return false;
    // St.ReducedMotion exists from GNOME 48.
    if (St.ReducedMotion && settings.reduced_motion === St.ReducedMotion.REDUCE)
        return false;
    return true;
}

/** 'light' or 'dark': which variant the Shell's own UI is using. */
export function styleVariant(Main) {
    try {
        return Main.getStyleVariant?.() === 'light' ? 'light' : 'dark';
    } catch {
        return 'dark';
    }
}

/** The UI scale factor (2 on a 200% display). */
export function scaleFactor() {
    return St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

// St.BoxLayout: GNOME 48 added "orientation" and later versions dropped
// "vertical".
const BOX_HAS_ORIENTATION = (() => {
    try {
        return !!St.BoxLayout.find_property('orientation');
    } catch {
        return 'orientation' in St.BoxLayout.prototype;
    }
})();

/** A vertical St.BoxLayout on every GNOME version. */
export function vbox(params = {}) {
    return new St.BoxLayout(BOX_HAS_ORIENTATION
        ? {...params, orientation: Clutter.Orientation.VERTICAL}
        : {...params, vertical: true});
}

/** A background blur ("acrylic") effect, or null if this Shell has none. */
export function createBlurEffect(radius = 36) {
    if (!Shell.BlurEffect)
        return null;
    const effect = new Shell.BlurEffect({mode: Shell.BlurMode.BACKGROUND});
    if ('radius' in effect)
        effect.radius = radius;
    else
        effect.sigma = radius / 2;
    effect.brightness = 0.95;
    return effect;
}

/**
 * True for the actors GNOME Shell draws its workspace switch animation with
 * (one per monitor, right above the window group, destroyed when it ends).
 */
export function isSwitchAnimationActor(actor) {
    if (WorkspaceAnimation.MonitorGroup && actor instanceof WorkspaceAnimation.MonitorGroup)
        return true;
    return actor instanceof St.Widget &&
        actor.has_style_class_name('workspace-animation') &&
        !actor.has_style_class_name('vdesk-bounce');
}

// GNOME's accent palette (st-theme-context.c). St only exposes the accent as
// an enum, so map it here. GNOME 46 has no accent setting: always blue.
const ACCENTS = {
    blue: [0x35, 0x84, 0xe4],
    teal: [0x21, 0x90, 0xa4],
    green: [0x3a, 0x94, 0x4a],
    yellow: [0xc8, 0x88, 0x00],
    orange: [0xed, 0x5b, 0x00],
    red: [0xe6, 0x2d, 0x42],
    pink: [0xd5, 0x61, 0x99],
    purple: [0x91, 0x41, 0xac],
    slate: [0x6f, 0x83, 0x96],
};

/** The system accent colour as [r, g, b] (0–255). */
export function accentRgb() {
    const value = St.Settings.get().accent_color;
    if (value === undefined || !St.SystemAccentColor)
        return ACCENTS.blue;
    for (const [name, rgb] of Object.entries(ACCENTS)) {
        if (St.SystemAccentColor[name.toUpperCase()] === value)
            return rgb;
    }
    return ACCENTS.blue;
}
