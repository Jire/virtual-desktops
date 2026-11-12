// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// The desktop's name popping up in the middle of the screen while you switch,
// like on Windows 11: a small frosted panel that appears for a moment and
// fades away. Switching again while it's up just changes the name.
//
// Optionally shows dots under the name for where the desktop is in the row.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    accentRgb, createBlurEffect, disableUnredirect, enableUnredirect, scaleFactor, styleVariant, vbox,
} from './compat.js';

const SHOW_MS = 160;
const HIDE_MS = 260;
const HOLD_MS = 900;
const RADIUS = 14;
// The blurred layer is square, so it sits this far inside the rounded outline
// (radius × (1 − 1/√2), rounded up) and the panel's edge covers the rest.
const FROST_INSET = Math.ceil(RADIUS * (1 - Math.SQRT1_2)) + 1;

// GObject type names must be unique in the process, and reloading without
// logging out (scripts/hot-load.js) loads a second copy from another folder.
const TYPE_SUFFIX = import.meta.url.replace(/[^A-Za-z0-9]+/g, '_');

/** Frosted glass (background blur + tint) sized to its content. */
const FlyoutPanel = GObject.registerClass({
    GTypeName: `VirtualDesktopsFlyoutPanel_${TYPE_SUFFIX}`,
}, class FlyoutPanel extends St.Widget {
    _init() {
        super._init({
            reactive: false,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        // The blur reads what's already on screen; fading this actor through
        // an offscreen buffer would leave it nothing to blur.
        this.offscreen_redirect = Clutter.OffscreenRedirect.NEVER;
        this.set_pivot_point(0.5, 0.5);

        this._frost = null;
        const blur = createBlurEffect();
        if (blur) {
            this._frost = new St.Widget();
            this._frost.add_effect_with_name('vdesk-blur', blur);
            this.add_child(this._frost);
        }
        this._glass = new St.Widget({style_class: 'vdesk-flyout'});
        this.add_child(this._glass);
        // Not "content": that's a ClutterActor property.
        this.box = vbox({style_class: 'vdesk-flyout-content'});
        this.add_child(this.box);
    }

    vfunc_get_preferred_width(forHeight) {
        return this.box.get_preferred_width(forHeight);
    }

    vfunc_get_preferred_height(forWidth) {
        return this.box.get_preferred_height(forWidth);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const width = box.get_width(), height = box.get_height();
        const full = new Clutter.ActorBox();
        full.set_origin(0, 0);
        full.set_size(width, height);
        this._glass.allocate(full);
        this.box.allocate(full);
        if (this._frost) {
            const inset = FROST_INSET * scaleFactor();
            const frost = new Clutter.ActorBox();
            frost.set_origin(inset, inset);
            frost.set_size(Math.max(0, width - 2 * inset), Math.max(0, height - 2 * inset));
            this._frost.allocate(frost);
        }
    }
});

export class DesktopFlyout {
    constructor(ext) {
        this._settings = ext.settings;
        this._actor = null;
        this._hideTimeoutId = 0;
        this._shown = false;
        this._unredirectOff = false;

        Main.overview.connectObject('showing', () => this.hide(false), this);
        Main.sessionMode.connectObject('updated', () => {
            if (Main.sessionMode.isLocked)
                this.hide(false);
        }, this);
    }

    destroy() {
        Main.overview.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        this.hide(false);
        this._actor?.destroy();
        this._actor = null;
    }

    /**
     * Show `title` (and a smaller `caption`). With the desktop's `index` and
     * the `count` of desktops, dots can show where it is.
     */
    show({title, caption = '', index = -1, count = 0}) {
        if (!Main.layoutManager.primaryMonitor)
            return;
        this._build();

        this._title.text = title;
        this._caption.text = caption;
        this._caption.visible = caption !== '';
        this._updateDots(index, count);
        this._updateStyle();

        // Above everything, including anything added since last time.
        Main.uiGroup.set_child_above_sibling(this._actor, null);

        if (this._hideTimeoutId)
            GLib.source_remove(this._hideTimeoutId);
        // Stays up as long, relative to its animations, when GNOME's animations
        // are slowed down (Settings › Accessibility, or the debug setting).
        const hold = Math.round(HOLD_MS * (St.Settings.get().slow_down_factor || 1));
        this._hideTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, hold, () => {
            this._hideTimeoutId = 0;
            this.hide(true);
            return GLib.SOURCE_REMOVE;
        });

        if (this._shown)
            return; // Already up (or on its way): just the new name.
        this._shown = true;

        if (!this._unredirectOff) {
            // Visible over fullscreen apps and games too.
            disableUnredirect();
            this._unredirectOff = true;
        }
        const panel = this._panel;
        if (!this._actor.visible) {
            panel.opacity = 0;
            panel.scale_x = panel.scale_y = 0.92;
            this._actor.show();
        }
        panel.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration: SHOW_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    /** Fade out (or vanish at once with `animate` false). */
    hide(animate = true) {
        if (this._hideTimeoutId) {
            GLib.source_remove(this._hideTimeoutId);
            this._hideTimeoutId = 0;
        }
        if (!this._panel)
            return;
        this._shown = false;

        const done = () => {
            if (this._shown || !this._actor)
                return;
            this._actor.hide();
            if (this._unredirectOff) {
                this._unredirectOff = false;
                enableUnredirect();
            }
        };

        if (!animate) {
            this._panel.remove_all_transitions();
            done();
            return;
        }
        this._panel.ease({
            opacity: 0,
            scale_x: 0.96,
            scale_y: 0.96,
            duration: HIDE_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: done,
        });
    }

    get visible() {
        return !!this._actor?.visible;
    }

    get text() {
        return this._title?.text ?? '';
    }

    _build() {
        if (this._actor)
            return;

        // Covers the primary monitor; the panel sits in its middle.
        const actor = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            reactive: false,
            visible: false,
        });
        actor.add_constraint(new Layout.MonitorConstraint({primary: true}));

        const panel = new FlyoutPanel();
        actor.add_child(panel);

        const title = new St.Label({style_class: 'vdesk-flyout-title', x_align: Clutter.ActorAlign.CENTER});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        panel.box.add_child(title);

        const caption = new St.Label({style_class: 'vdesk-flyout-caption', x_align: Clutter.ActorAlign.CENTER});
        panel.box.add_child(caption);

        const dots = new St.BoxLayout({style_class: 'vdesk-flyout-dots', x_align: Clutter.ActorAlign.CENTER});
        panel.box.add_child(dots);

        Main.uiGroup.add_child(actor);
        // Only once it's all there.
        Object.assign(this, {_actor: actor, _panel: panel, _title: title, _caption: caption, _dots: dots});
    }

    _updateDots(index, count) {
        const show = this._settings.get_boolean('indicator-dots') && index >= 0 && count > 1;
        this._dots.visible = show;
        if (!show)
            return;

        const dots = this._dots.get_children();
        for (let i = dots.length; i < count; i++)
            this._dots.add_child(new St.Widget({style_class: 'vdesk-dot', y_align: Clutter.ActorAlign.CENTER}));
        for (let i = dots.length - 1; i >= count; i--)
            dots[i].destroy();

        const [r, g, b] = accentRgb();
        this._dots.get_children().forEach((dot, i) => {
            if (i === index) {
                dot.add_style_pseudo_class('active');
                dot.set_style(`background-color: rgb(${r}, ${g}, ${b});`);
            } else {
                dot.remove_style_pseudo_class('active');
                dot.set_style(null);
            }
        });
    }

    _updateStyle() {
        if (styleVariant(Main) === 'light')
            this._actor.add_style_class_name('vdesk-light');
        else
            this._actor.remove_style_class_name('vdesk-light');
    }
}
