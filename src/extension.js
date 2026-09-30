import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import St from 'gi://St';
import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {parseGdkColor, pickOpacity, relativeLuminance} from './luminance.js';
import {measurePanelBackdrop} from './wallpaper.js';

/** Coalesces bursts of wallpaper/monitor changes into one measurement. */
const AUTO_DEBOUNCE_MS = 300;
/**
 * Opacity change below which a *decrease* is ignored.
 *
 * Asymmetric on purpose: an increase is needed for readability and applies immediately, while a
 * decrease is purely cosmetic, so damping it avoids a 500ms cross-fade every time the wallpaper
 * rotates to something a percent darker. Never delays the contrast guarantee.
 */
const OPACITY_DEADBAND = 2;

/**
 * A nested GNOME Shell started for development gets its own D-Bus session and Wayland display, but
 * GNOME Shell 50 resolves the user extension directory AND dconf from the passwd home dir, ignoring
 * HOME and XDG_*_HOME. So a nested Shell loads THIS extension and its writes land in the live
 * desktop's settings.
 *
 * `_measureAndApply()` runs from `enable()` and ends in `set_int('auto-last-opacity', …)`. The two
 * Shells do not agree on that value: `_autoTransparency` starts null in a freshly-launched nested
 * Shell, so its first measurement writes the raw target while the live session may be holding a
 * damped one, and the wallpaper it measures is whatever `picture-uri` says at that instant, which a
 * test can have just changed. The live session would then seed its next login from that number.
 *
 * A development harness that starts a nested Shell exports GNOME_SHELL_DEV_HARNESS=1; stay inert.
 */
function inDevHarness() {
    return GLib.getenv('GNOME_SHELL_DEV_HARNESS') === '1';
}

export default class TransparentTopBarWithCustomTransparencyExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._actorSignalIds = null;
        this._windowSignalIds = null;
        this._updateLaterId = null;
        this._updateLaterRemove = null;
        this.transparencyChangeDebounce = null;
        this._autoDebounceId = null;
        this._autoCancellable = null;
        this._settingsSignalId = null;
        this._autoTransparency = null;
        this._appliedOpacity = null;
        this._backgroundSignalIds = [];
        this.darkFullScreenChangeDebounce = null;
        this.textShadowChangeDebounce = null;
    }

    enable() {
        // Must be first: the measurement below ends in a write to shared dconf.
        if (inDevHarness()) {
            console.log('transparent-top-bar: inert, GNOME_SHELL_DEV_HARNESS=1 ' +
                '(a nested Shell shares the live desktop\'s dconf)');
            return;
        }

        this._settings = this.getSettings();
        this._backgroundSettings = new Gio.Settings({schema: 'org.gnome.desktop.background'});
        this._interfaceSettings = new Gio.Settings({schema: 'org.gnome.desktop.interface'});
        this._appliedOpacity = null;
        // Seed from the last measurement so the first paint is already about right. Without this
        // the panel shows the manual value at login and then visibly cross-fades to the measured
        // one ~100ms later, once the async wallpaper decode lands.
        const remembered = this._settings.get_int('auto-last-opacity');
        this._autoTransparency = remembered >= 0 ? remembered : null;
        this._currentTransparency = this._settings.get_int('transparency');
        this._darkFullScreen = this._settings.get_boolean('dark-full-screen');
        this._disableTextShadow = this._settings.get_boolean('disable-text-shadow');

        this._actorSignalIds = new Map();
        this._windowSignalIds = new Map();
        this._settingsSignalId = this._settings.connect('changed', (settings, key) => this.transparencyChanged(settings, key));
        this._actorSignalIds.set(Main.overview, [
            Main.overview.connect('showing', this._updateTransparent.bind(this)),
            Main.overview.connect('hiding', this._updateTransparent.bind(this))
        ]);

        this._actorSignalIds.set(Main.sessionMode, [
            Main.sessionMode.connect('updated', this._updateTransparent.bind(this))
        ]);

        for (const metaWindowActor of global.get_window_actors()) {
            this._onWindowActorAdded(metaWindowActor.get_parent(), metaWindowActor);
        }

        this._actorSignalIds.set(global.window_group, [
            global.window_group.connect('child-added', this._onWindowActorAdded.bind(this)),
            global.window_group.connect('child-removed', this._onWindowActorRemoved.bind(this))
        ]);

        // Defer geometry reads until Shell has applied the workspace switch for this frame.
        this._actorSignalIds.set(global.window_manager, [
            global.window_manager.connect('switch-workspace', this._scheduleTransparencyUpdate.bind(this))
        ]);

        // Anything that changes what is behind the panel, or where the panel is.
        for (const key of ['picture-uri', 'picture-uri-dark', 'picture-options',
                           'primary-color', 'secondary-color', 'color-shading-type']) {
            this._backgroundSignalIds.push([
                this._backgroundSettings,
                this._backgroundSettings.connect(`changed::${key}`, () => this._scheduleAutoUpdate()),
            ]);
        }
        this._backgroundSignalIds.push([
            this._interfaceSettings,
            this._interfaceSettings.connect('changed::color-scheme', () => this._scheduleAutoUpdate()),
        ]);
        this._backgroundSignalIds.push([
            Main.layoutManager,
            Main.layoutManager.connect('monitors-changed', () => this._scheduleAutoUpdate()),
        ]);
        // An accessibility preference has to take effect when it is toggled, not at the next
        // unrelated event that happens to re-run _updateTransparent().
        this._backgroundSignalIds.push([
            St.Settings.get(),
            St.Settings.get().connect('notify::high-contrast', () => this._updateTransparent()),
        ]);
        this._backgroundSignalIds.push([
            St.Settings.get(),
            St.Settings.get().connect('notify::enable-animations', () => this._updateMotion()),
        ]);

        this._updateMotion();
        this._updateTransparent();
        this._measureAndApply();
    }

    transparencyChanged(settings, key) {
        // disable() nulls _settings but the handler can still be in flight.
        if (this._settings === null) {
            return;
        }

        if (key === 'transparency') {
            // No manual remove_style_class_name here any more: _setTransparent tracks exactly
            // which class is applied, and removing one behind its back desyncs that tracking.
            this._debounce('transparencyChangeDebounce', () => {
                this._currentTransparency = this._settings.get_int('transparency');
                this._updateTransparent();
            });
            return;
        }

        if (key === 'dark-full-screen') {
            this._darkFullScreen = this._settings.get_boolean('dark-full-screen');
            this._debounce('darkFullScreenChangeDebounce', () => this._updateTransparent());
            return;
        }

        if (key === 'auto-transparency' || key === 'auto-min-transparency' ||
            key === 'auto-max-transparency') {
            this._scheduleAutoUpdate();
            return;
        }

        if (key === 'disable-text-shadow') {
            this._disableTextShadow = this._settings.get_boolean('disable-text-shadow');
            this._debounce('textShadowChangeDebounce', () => this._updateTextShadow());
            return;
        }
    }

    /**
     * Replaces a pending debounce timeout with a new one, returning the new id.
     *
     * Upstream called GLib.source_remove() on ids that were null (warns) or already-fired
     * (GLib recycles source ids, so that can cancel an unrelated source), and its callbacks
     * never returned SOURCE_REMOVE or cleared the stored id.
     */
    _debounce(field, callback) {
        if (this[field]) {
            GLib.Source.remove(this[field]);
            this[field] = null;
        }
        this[field] = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            // Clear BEFORE the callback: the field must not keep a dead id (GLib recycles them,
            // so removing one later can cancel an unrelated source), and clearing first also lets
            // the callback re-arm the debounce re-entrantly.
            this[field] = null;
            callback();
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        // No dev-harness guard here on purpose, unlike enable(). After a short-circuited enable()
        // every field below is still at its constructor value, the loops are empty, and the only
        // calls that land are Main.panel style-class removals — the nested Shell's own panel, not
        // shared state. A guard would be untestable code protecting nothing.
        this._autoCancellable?.cancel();
        this._autoCancellable = null;
        if (this._autoDebounceId) {
            GLib.Source.remove(this._autoDebounceId);
            this._autoDebounceId = null;
        }
        for (const [object, signalId] of this._backgroundSignalIds) {
            object.disconnect(signalId);
        }
        this._backgroundSignalIds = [];
        if (this._settingsSignalId) {
            this._settings.disconnect(this._settingsSignalId);
            this._settingsSignalId = null;
        }

        for (const id of [this.transparencyChangeDebounce, this.darkFullScreenChangeDebounce,
                          this.textShadowChangeDebounce]) {
            if (id) {
                GLib.Source.remove(id);
            }
        }
        this.transparencyChangeDebounce = null;
        this.darkFullScreenChangeDebounce = null;
        this.textShadowChangeDebounce = null;

        for (const actorSignalIds of [this._actorSignalIds, this._windowSignalIds]) {
            if (!actorSignalIds) {
                continue;
            }
            for (const [actor, signalIds] of actorSignalIds) {
                for (const signalId of signalIds) {
                    actor.disconnect(signalId);
                }
            }
        }
        this._actorSignalIds = null;
        this._windowSignalIds = null;

        this._cancelTransparencyUpdate();

        this._setTransparent(false);
        Main.panel.remove_style_class_name('no-text-shadow');
        Main.panel.remove_style_class_name('transparent-top-bar-no-motion');
        this._appliedOpacity = null;
        this._autoTransparency = null;
        this._backgroundSettings = null;
        this._interfaceSettings = null;
        this._settings = null;
    }

    _onWindowActorAdded(container, metaWindowActor) {
        if (!this._windowSignalIds || this._windowSignalIds.has(metaWindowActor)) {
            return;
        }
        const scheduleIfRelevant = () => {
            // When dark-full-screen is disabled, windows cannot affect the result. Keep the signal
            // connections stable across preference changes, but do no scheduling or workspace scan.
            if (this._darkFullScreen) {
                this._scheduleTransparencyUpdate();
            }
        };
        this._windowSignalIds.set(metaWindowActor, [
            metaWindowActor.connect('notify::allocation', scheduleIfRelevant),
            metaWindowActor.connect('notify::visible', scheduleIfRelevant)
        ]);
        scheduleIfRelevant();
    }

    _onWindowActorRemoved(container, metaWindowActor) {
        const signalIds = this._windowSignalIds?.get(metaWindowActor);
        if (signalIds) {
            for (const signalId of signalIds) {
                metaWindowActor.disconnect(signalId);
            }
            this._windowSignalIds.delete(metaWindowActor);
        }
        if (this._darkFullScreen) {
            this._scheduleTransparencyUpdate();
        }
    }

    /**
     * Runs at most one window/workspace geometry scan per frame.
     *
     * Window allocation changes can arrive many times while a window is moved or resized. Scanning
     * every active-workspace window for each signal adds work to the hottest part of that gesture.
     * BEFORE_REDRAW keeps the result visually current while collapsing the burst into one owned
     * callback. It also replaces the old workspace timeout, which overwrote its only stored source
     * id and could therefore survive disable().
     */
    _scheduleTransparencyUpdate() {
        if (!this._settings || !this._darkFullScreen || this._updateLaterId !== null) {
            return;
        }
        const callback = () => {
            this._updateLaterId = null;
            this._updateLaterRemove = null;
            if (this._settings && this._darkFullScreen) {
                this._updateTransparent();
            }
            return GLib.SOURCE_REMOVE;
        };
        const laters = global.compositor?.get_laters?.();
        if (laters) {
            this._updateLaterId = laters.add(Meta.LaterType.BEFORE_REDRAW, callback);
            this._updateLaterRemove = id => laters.remove(id);
        } else if (typeof Meta.later_add === 'function') {
            this._updateLaterId = Meta.later_add(Meta.LaterType.BEFORE_REDRAW, callback);
            this._updateLaterRemove = id => Meta.later_remove(id);
        } else {
            // Defensive fallback for an unexpected compositor API change: keep the panel correct
            // even though this one update cannot be frame-coalesced.
            callback();
        }
    }

    _cancelTransparencyUpdate() {
        if (this._updateLaterId === null) {
            return;
        }
        const id = this._updateLaterId;
        const remove = this._updateLaterRemove;
        this._updateLaterId = null;
        this._updateLaterRemove = null;
        remove?.(id);
    }

    _updateMotion() {
        if (St.Settings.get().enable_animations) {
            Main.panel.remove_style_class_name('transparent-top-bar-no-motion');
        } else {
            Main.panel.add_style_class_name('transparent-top-bar-no-motion');
        }
    }

    _updateTextShadow() {
        if (this._disableTextShadow) {
            Main.panel.add_style_class_name('no-text-shadow');
        } else {
            Main.panel.remove_style_class_name('no-text-shadow');
        }
    }

    _updateTransparent() {
        if (this._highContrast()) {
            this._setTransparent(false);
            return;
        }

        if (!this._darkFullScreen) {
            this._setTransparent(true);
            return
        }

        if (Main.panel.has_style_pseudo_class('overview') || !Main.sessionMode.hasWindows) {
            this._setTransparent(true);
            return;
        }

        if (!Main.layoutManager.primaryMonitor) {
            return;
        }

        // Get all the windows in the active workspace that are in the primary monitor and visible.
        const workspaceManager = global.workspace_manager;
        const activeWorkspace = workspaceManager.get_active_workspace();
        const windows = activeWorkspace.list_windows().filter(metaWindow => {
            return metaWindow.is_on_primary_monitor()
                && metaWindow.showing_on_its_workspace()
                && !metaWindow.is_hidden()
                && metaWindow.get_window_type() !== Meta.WindowType.DESKTOP
                && !metaWindow.skip_taskbar;
        });

        // Check if at least one window is near enough to the panel.
        const panelTop = Main.panel.get_transformed_position()[1];
        const panelBottom = panelTop + Main.panel.get_height();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const isNearEnough = windows.some(metaWindow => {
            const verticalPosition = metaWindow.get_frame_rect().y;
            return verticalPosition < panelBottom + 5 * scale;
        });

        this._setTransparent(!isNearEnough);
    }

    /** Opacity to actually use: the measured one in auto mode, else the manual slider. */
    /** The a11y high-contrast preference outranks any transparency setting. */
    _highContrast() {
        return St.Settings.get().high_contrast;
    }

    _effectiveTransparency() {
        if (this._settings.get_boolean('auto-transparency') && this._autoTransparency !== null) {
            return this._autoTransparency;
        }
        return this._settings.get_int('transparency');
    }

    _setTransparent(transparent) {
        // Upstream removed 'transparent-top-bar-<n>' using the CURRENT setting value, so a class
        // applied under an older value was never removed. Harmless when the value only changes on
        // a slider drag; a steady leak of stale classes once auto mode retunes it per wallpaper.
        const target = transparent ? this._effectiveTransparency() : null;
        if (this._appliedOpacity !== null && this._appliedOpacity !== target) {
            Main.panel.remove_style_class_name('transparent-top-bar-' + this._appliedOpacity);
            this._appliedOpacity = null;
        }
        if (target === null) {
            Main.panel.remove_style_class_name('transparent-top-bar');
        } else {
            Main.panel.add_style_class_name('transparent-top-bar');
            if (this._appliedOpacity !== target) {
                Main.panel.add_style_class_name('transparent-top-bar-' + target);
                this._appliedOpacity = target;
            }
        }

        this._updateTextShadow();
    }

    /** Luminance of the plain desktop colour, for `picture-options: none` or no wallpaper set. */
    _solidColourLuminance() {
        const primary = parseGdkColor(this._backgroundSettings.get_string('primary-color'));
        if (primary === null) {
            return null;
        }
        const primaryLuminance = relativeLuminance(primary[0], primary[1], primary[2]);
        if (this._backgroundSettings.get_string('color-shading-type') === 'solid') {
            return primaryLuminance;
        }
        const secondary = parseGdkColor(this._backgroundSettings.get_string('secondary-color'));
        if (secondary === null) {
            return primaryLuminance;
        }
        // Gradient: plan against the brighter end, so the panel is never under-darkened.
        return Math.max(
            primaryLuminance,
            relativeLuminance(secondary[0], secondary[1], secondary[2]),
        );
    }

    _wallpaperUri() {
        if (this._backgroundSettings.get_string('picture-options') === 'none') {
            return null;   // solid colour desktop; _solidColourLuminance handles it
        }
        const preferDark = this._interfaceSettings.get_string('color-scheme') === 'prefer-dark';
        const uri = preferDark
            ? this._backgroundSettings.get_string('picture-uri-dark') ||
              this._backgroundSettings.get_string('picture-uri')
            : this._backgroundSettings.get_string('picture-uri');
        return uri || null;
    }

    _scheduleAutoUpdate() {
        if (this._autoDebounceId) {
            GLib.Source.remove(this._autoDebounceId);
        }
        this._autoDebounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, AUTO_DEBOUNCE_MS, () => {
            this._autoDebounceId = null;
            this._measureAndApply();
            return GLib.SOURCE_REMOVE;
        });
    }

    _measureAndApply() {
        if (this._settings === null) {
            return;
        }
        if (!this._settings.get_boolean('auto-transparency')) {
            this._autoTransparency = null;
            // Let the real window/overview state decide, rather than inferring it from whether we
            // happen to have an opacity class applied.
            this._updateTransparent();
            return;
        }
        // Cancel any measurement still in flight; wallpaper rotation can outpace decoding.
        this._autoCancellable?.cancel();
        this._autoCancellable = new Gio.Cancellable();
        const cancellable = this._autoCancellable;

        measurePanelBackdrop(
            this._wallpaperUri(),
            this._backgroundSettings.get_string('picture-options'),
            cancellable,
            (luminance) => {
                if (cancellable.is_cancelled() || this._settings === null) {
                    return;
                }
                // A solid-colour desktop has no image to decode but is trivially measurable.
                const backdrop = luminance ?? this._solidColourLuminance();
                if (backdrop === null) {
                    // Genuinely unreadable: fall back to the manual value rather than guessing.
                    this._autoTransparency = null;
                    this._updateTransparent();
                    return;
                }
                const target = pickOpacity(backdrop, {
                    min: this._settings.get_int('auto-min-transparency'),
                    max: this._settings.get_int('auto-max-transparency'),
                });
                const current = this._autoTransparency;
                const damped =
                    current !== null && target < current && current - target < OPACITY_DEADBAND
                        ? current
                        : target;
                this._autoTransparency = damped;
                this._settings.set_int('auto-last-opacity', damped);
                this._updateTransparent();
            },
        );
    }

};
