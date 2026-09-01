import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AppDockItem, FolderDockItem} from './dockItem.js';
import {StackPopup} from './stackFan.js';
import {NativeBlurSurface} from './nativeBlur.js';

const INTERACTION_GRACE = 800;
const LAUNCH_PIN_MS = 4000;
const FALLBACK_BORDER_RADIUS = 20;
const EDGE_REVEAL_GRACE = 650;
const DOCK_BOTTOM_GAP = 4;

const REBUILD_KEYS = new Set([
    'icon-size',
    'magnification',
    'magnification-radius',
    'show-running-apps',
    'folder-paths',
    'folder-icon-style',
    'folder-card-spread',
    'folder-card-count',
    'indicator-max-dots',
]);

const VISIBILITY_KEYS = new Set([
    'visibility-mode',
    'hide-delay',
    'show-delay',
    'hide-animation-duration',
]);

// Blur My Shell discovers Dash to Dock through this exact public shape.
// Keeping it small lets its existing Dash filter/pipeline work unmodified.
export const DashToDock = GObject.registerClass(
class DashToDock extends St.Bin {
    _init(dash) {
        super._init({
            name: 'dashtodockContainer',
            style_class: 'bottom maclike-dock-container',
            reactive: false,
        });
        this._slider = new St.Bin({
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._box = new St.Widget({
            name: 'dashtodockBox',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });
        this.set_child(this._slider);
        this._slider.set_child(this._box);
        dash.x_align = Clutter.ActorAlign.CENTER;
        dash.y_align = Clutter.ActorAlign.END;
        this._box.add_child(dash);
    }
});

export class MaclikeDock {
    constructor(settings, logger, extensionPath) {
        this._settings = settings;
        this._logger = logger;
        this._extensionPath = extensionPath;
        this._signals = [];
        this._items = [];
        this._stack = null;
        this._pointerInside = false;
        this._pointerX = 0;
        this._pointerY = 0;
        this._menuOpen = false;
        this._hidden = false;
        this._inOverview = false;
        this._graceUntil = 0;
        this._edgeRevealUntil = 0;
        this._edgeRevealLatched = false;
        this._edgeRevealEnteredDock = false;
        this._edgeRevealArmed = true;
        this._bmsSignals = [];
        this._bmsDashSignals = [];
        this._bmsDashManager = null;
        this._bmsDashInfo = null;
        this._dockBlurEffect = null;
        this._dockCornerEffect = null;
        this._dockBlurEffectsManager = null;
        this._bmsBlurSurface = null;
        this._usesManagedBmsBlur = false;
        this._dockBlurStatus = 'not-attached';
        this._nativeBlurSurface = null;
        this._strut = null;
        this._launchPinned = false;
        this._launchPinTimeout = 0;
        this._launchAppSignals = [];
        this._lastSignature = null;
        this._visibilityTimeout = 0;
        this._windowWatchId = 0;
        this._startupRelayoutIds = [];
        this._interfaceSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.interface',
        });

        this._dash = new St.Widget({
            name: 'dash',
            style_class: 'maclike-dock-panel',
            reactive: true,
            track_hover: true,
            layout_manager: new Clutter.BinLayout(),
            // GNOME's global #dash rule adds 6 px per side. Blur My Shell
            // measures the dash itself, so that padding displaced its surface.
            style: 'padding: 0px; margin: 0px;',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
        });
        this._dash._background = new St.Widget({
            style_class: 'dash-background',
            x_expand: true,
            y_expand: true,
        });
        this._nativeBlurLayer = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._border = new St.Widget({
            style_class: 'maclike-dock-border-overlay',
            reactive: false,
            x_expand: true,
            y_expand: true,
        });
        this._itemsBox = new St.BoxLayout({
            style_class: 'maclike-dock-items',
            orientation: Clutter.Orientation.HORIZONTAL,
            reactive: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
        });
        this._dash.add_child(this._nativeBlurLayer);
        this._dash.add_child(this._dash._background);
        // The border is deliberately independent from dash-background.
        // Blur My Shell replaces the dash style class and owns the background,
        // but both actors still receive the exact same BinLayout allocation.
        // It must be painted before the items so its top edge never crosses a
        // magnified icon and creates the illusion of icon transparency.
        this._dash.add_child(this._border);
        this._dash.add_child(this._itemsBox);

        this._outer = new DashToDock(this._dash);
        this._syncColorScheme();
        this._syncIndicatorAccent();
        Main.layoutManager.addChrome(this._outer, {
            affectsStruts: false,
            trackFullscreen: true,
        });

        this._edgeTrigger = new St.Widget({
            name: 'maclike-dock-edge-trigger',
            reactive: true,
            track_hover: true,
            style: 'background-color: rgba(0, 0, 0, 0.001);',
        });
        Main.layoutManager.addTopChrome(this._edgeTrigger, {
            affectsStruts: false,
            trackFullscreen: true,
        });
        this._connect(this._edgeTrigger, 'notify::hover', () => {
            const now = GLib.get_monotonic_time() / 1000;
            if (this._edgeTrigger.hover) {
                this._edgeRevealLatched = true;
                this._edgeRevealEnteredDock = false;
                this._edgeRevealArmed = false;
                this._edgeRevealUntil = now + EDGE_REVEAL_GRACE;
                this._scheduleHidden(false, 0);
            } else if (!this._pointerInside) {
                this._edgeRevealUntil = now + EDGE_REVEAL_GRACE;
                this._evaluateVisibility();
            }
        });

        this._tooltip = new St.Label({
            style_class: 'maclike-dock-tooltip',
            visible: false,
        });
        Main.layoutManager.addTopChrome(this._tooltip);

        this._timeline = new Clutter.Timeline({
            actor: this._outer,
            duration: 1000,
            repeat_count: -1,
        });
        this._timeline.connect('new-frame', () => this._tick());

        this._connect(global.stage, 'captured-event', (_stage, event) =>
            this._onStageEvent(event));
        this._connect(this._dash, 'notify::hover', () => {
            if (!this._dash.hover)
                this._releaseMagnification();
        });
        this._connect(this._dash, 'notify::width', () =>
            this._syncEdgeTrigger());
        this._connect(this._dash, 'notify::height', () =>
            this._syncDashBottomAnchor());
        this._connect(this._dash, 'notify::y', () =>
            this._syncDashBottomAnchor());
        this._connect(this._dash, 'notify::allocation', () =>
            this._syncDashBottomAnchor());
        this._connect(this._dash._background, 'notify::allocation', () =>
            this._syncManagedBmsBlurGeometry());
        this._connect(this._outer, 'notify::height', () =>
            this._syncDashBottomAnchor());
        this._connect(Main.layoutManager, 'monitors-changed', () => this._relayout());
        this._connect(this._interfaceSettings, 'changed::color-scheme', () => {
            this._syncColorScheme();
            this._syncBorder();
        });
        this._connect(this._interfaceSettings, 'changed::accent-color', () =>
            this._syncIndicatorAccent());
        if (Main.extensionManager) {
            this._connect(Main.extensionManager, 'extension-state-changed',
                (_manager, extension) => {
                    if (extension?.uuid !== 'blur-my-shell@aunetx')
                        return;
                    GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, 0, () => {
                        if (!this._dash)
                            return;
                        this._trackBmsSettings();
                        this._refreshDynamicDockBlur();
                        this._syncBorder();
                    });
                });
        }

        const favorites = AppFavorites.getAppFavorites();
        this._connect(favorites, 'changed', () => this._rebuildOnChange());
        this._appSystem = Shell.AppSystem.get_default();
        this._connect(this._appSystem, 'app-state-changed', () => this._rebuildOnChange());
        this._connect(this._settings, 'changed', (_settings, key) => {
            if (REBUILD_KEYS.has(key))
                this._rebuild();
            if (key === 'hide-in-overview')
                this._evaluateVisibility();
            if (key === 'hide-overview-dash')
                this._syncOverviewDash();
            if (key === 'border-enabled')
                this._syncBorder();
            if (key === 'tint-mode') {
                this._syncColorScheme();
                this._syncBorder();
            }
            if (key === 'use-accent-color-indicators')
                this._syncIndicatorAccent();
            if (['blur-engine', 'blur-sigma', 'blur-brightness'].includes(key))
                this._refreshDynamicDockBlur();
            if (key === 'reserve-space-for-maximized') {
                this._syncStrut();
                this._updateVisibilityWatcher();
                this._evaluateVisibility();
            }
            if (VISIBILITY_KEYS.has(key)) {
                this._updateVisibilityWatcher();
                this._evaluateVisibility();
            }
        });

        if (!Main.overview.isDummy) {
            this._connect(Main.overview, 'showing', () => {
                this._inOverview = true;
                this._releaseMagnification();
                this._syncOverviewDash();
                this._evaluateVisibility();
            });
            this._connect(Main.overview, 'hidden', () => {
                this._inOverview = false;
                this._evaluateVisibility();
            });
            this._rememberOverviewDash();
        }

        this._rebuild();
        this._relayout();
        this._scheduleStartupRelayouts();
        this._updateVisibilityWatcher();
        this._evaluateVisibility();
        this._syncOverviewDash();
        try {
            this._syncBorder();
            this._trackBmsSettings();
            this._refreshDynamicDockBlur();
            GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, 1000, () => {
                try {
                    this._trackBmsSettings();
                    this._refreshDynamicDockBlur();
                    this._syncBorder();
                } catch (error) {
                    // A disabled dependency can disappear during late sync.
                }
            });
        } catch (error) {
            this._logger.warn(
                `${_('Border settings are unavailable')}: ${error}`);
        }
    }

    _connect(object, signal, callback) {
        const id = object.connect(signal, callback);
        this._signals.push([object, id]);
    }

    _syncBorder() {
        if (!this._dash || !this._border)
            return;
        let enabled = true;
        try {
            enabled = this._settings.get_boolean('border-enabled');
        } catch (error) {
            // Keep the default while upgrading from an older schema.
        }
        this._border.visible = enabled;

        const radius = this._getBmsDockRadius();
        this._applyDockBackgroundStyle(radius);
        this._border.set_style(`border-radius: ${radius}px;`);
    }

    _syncColorScheme() {
        if (!this._outer || !this._interfaceSettings)
            return;
        let tintMode = 'auto';
        try {
            tintMode = this._settings.get_string('tint-mode');
        } catch (error) {
            // Older installed schemas fall back to the synchronized mode.
        }
        const dark = tintMode === 'dark' || (tintMode === 'auto' &&
            this._interfaceSettings.get_string('color-scheme') ===
            'prefer-dark');
        this._darkTheme = dark;
        this._outer.remove_style_class_name('maclike-dark');
        this._outer.remove_style_class_name('maclike-light');
        this._outer.add_style_class_name(dark
            ? 'maclike-dark' : 'maclike-light');
    }

    _syncIndicatorAccent() {
        if (!this._outer)
            return;
        let enabled = false;
        try {
            enabled = this._settings.get_boolean(
                'use-accent-color-indicators');
        } catch (error) {
            // Keep the neutral indicator while upgrading an older schema.
        }
        // Re-adding the class also invalidates the style after GNOME changes
        // -st-accent-color at runtime.
        this._outer.remove_style_class_name('maclike-accent-indicators');
        if (enabled)
            this._outer.add_style_class_name('maclike-accent-indicators');
    }

    _getBmsDockRadius() {
        let radius = FALLBACK_BORDER_RADIUS;
        try {
            const d2d = global.blur_my_shell?._settings?.dash_to_dock;
            if (d2d?.BLUR) {
                if (d2d.STATIC_BLUR) {
                    const pipelines =
                        global.blur_my_shell._pipelines_manager?.pipelines ?? {};
                    const pipeline = pipelines[d2d.PIPELINE];
                    for (const effect of pipeline?.effects ?? []) {
                        if (effect.type === 'corner' && effect.params?.radius)
                            radius = effect.params.radius;
                    }
                } else {
                    radius = d2d.CORNER_RADIUS;
                }
            }
        } catch (error) {
            // Keep the built-in radius when Blur My Shell is unavailable.
        }
        return radius;
    }

    _applyDockBackgroundStyle(radius) {
        if (!this._dash?._background)
            return;
        const usesBms = this._settings?.get_string('blur-engine') === 'bms';
        if (usesBms) {
            const tint = this._darkTheme
                ? 'rgba(18, 22, 29, 0.24)'
                : 'rgba(210, 222, 239, 0.15)';
            this._dash._background.set_style(
                `border-radius: ${radius}px; ` +
                `background-color: ${tint}; box-shadow: none;`);
        } else if (this._dockBlurEffect || this._nativeBlurSurface) {
            const tint = this._darkTheme
                ? 'rgba(18, 22, 29, 0.32)'
                : 'rgba(210, 222, 239, 0.18)';
            this._dash._background.set_style(
                `border-radius: ${radius}px; ` +
                `background-color: ${tint}; box-shadow: none;`);
        } else {
            this._dash._background.set_style(`border-radius: ${radius}px;`);
        }
    }

    _rememberOverviewDash() {
        this._overviewDash = Main.overview.dash;
        if (!this._overviewDash)
            return;
        this._overviewDashState = {
            visible: this._overviewDash.visible,
            opacity: this._overviewDash.opacity,
            reactive: this._overviewDash.reactive,
        };
    }

    _syncOverviewDash() {
        if (!this._overviewDash)
            return;
        if (this._settings.get_boolean('hide-overview-dash')) {
            this._overviewDash.opacity = 0;
            this._overviewDash.reactive = false;
            this._overviewDash.hide();
        } else if (this._overviewDashState) {
            this._overviewDash.opacity = this._overviewDashState.opacity;
            this._overviewDash.reactive = this._overviewDashState.reactive;
            if (this._overviewDashState.visible)
                this._overviewDash.show();
        }
    }

    _trackBmsSettings() {
        if (!this._dash)
            return;
        try {
            const main = global.blur_my_shell?._settings?.settings;
            const d2d = global.blur_my_shell?._settings?.dash_to_dock?.settings;
            if (main === this._bmsMainSettings &&
                d2d === this._bmsD2dSettings)
                return;
            this._disconnectBmsSettings();
            this._bmsMainSettings = main;
            this._bmsD2dSettings = d2d;
            const sync = () => {
                this._syncBorder();
                this._syncDynamicDockBlur();
            };
            if (main)
                this._bmsSignals.push([main, main.connect('changed', sync)]);
            if (d2d)
                this._bmsSignals.push([d2d, d2d.connect('changed', sync)]);
        } catch (error) {
            // Blur My Shell is optional.
        }
    }

    _disconnectBmsSettings() {
        for (const [object, id] of this._bmsSignals) {
            try {
                object.disconnect(id);
            } catch {
                // Blur My Shell may have been disabled first.
            }
        }
        this._bmsSignals = [];
        this._bmsMainSettings = null;
        this._bmsD2dSettings = null;
    }

    _refreshDynamicDockBlur() {
        const engine = this._settings.get_string('blur-engine');
        if (engine === 'native') {
            this._detachDynamicDockBlur();
            this._hideManagedBmsDashSurface();
            this._attachNativeBlur();
            return;
        }
        this._detachNativeBlur();
        if (engine === 'off') {
            this._detachDynamicDockBlur();
            this._hideManagedBmsDashSurface();
            this._dockBlurStatus = 'disabled';
            return;
        }
        const bms = global.blur_my_shell;
        const effectsManager = bms?._effects_manager;
        const dashSettings = bms?._settings?.dash_to_dock;
        if (!effectsManager || !dashSettings || !this._dash?._background) {
            this._detachDynamicDockBlur();
            this._hideManagedBmsDashSurface();
            this._dockBlurStatus = 'blur-my-shell-unavailable';
            return;
        }

        const managedInfo = bms?._dash_to_dock_blur?.dashes
            ?.find(candidate => candidate.dash === this._dash);
        if (!managedInfo?.background_group || !managedInfo.background) {
            this._detachDynamicDockBlur();
            this._dockBlurStatus = 'waiting-for-blur-my-shell-dash-surface';
            return;
        }

        this._attachManagedBmsBlur(managedInfo, effectsManager);
        this._trackBmsDashManager();
        this._syncDynamicDockBlur();
        this._syncBorder();
    }

    _attachManagedBmsBlur(managedInfo, effectsManager) {
        if (!this._usesManagedBmsBlur || this._bmsDashInfo !== managedInfo ||
                this._bmsBlurSurface !== managedInfo.background) {
            this._detachDynamicDockBlur();
            this._bmsDashInfo = managedInfo;
            this._bmsBlurSurface = managedInfo.background;
            this._dockBlurEffectsManager = effectsManager;
            this._dockBlurEffect = managedInfo.bg_manager?._bms_pipeline
                ?.effect ?? this._bmsBlurSurface.get_effects().find(effect =>
                'unscaled_radius' in effect || 'radius' in effect) ?? null;
            this._dockCornerEffect = null;
            this._usesManagedBmsBlur = true;
        }
        managedInfo.background_group.show();
        this._syncManagedBmsBlurGeometry();
        this._dockBlurStatus = global.blur_my_shell?._settings?.dash_to_dock
            ?.STATIC_BLUR
            ? 'attached-managed-bms-static-surface'
            : 'attached-managed-bms-dynamic-surface';
    }

    _syncManagedBmsBlurGeometry() {
        if (!this._usesManagedBmsBlur || !this._bmsDashInfo ||
                !this._bmsBlurSurface || !this._dash?._background)
            return;
        const dashSettings = global.blur_my_shell?._settings?.dash_to_dock;
        if (!dashSettings || dashSettings.STATIC_BLUR) {
            this._dockBlurEffect?.queue_repaint?.();
            return;
        }

        const backgroundBox = this._dash._background.get_allocation_box();
        const width = backgroundBox.x2 - backgroundBox.x1;
        const height = backgroundBox.y2 - backgroundBox.y1;
        if (width <= 0 || height <= 0)
            return;
        const [targetX, targetY] =
            this._dash._background.get_transformed_position();
        const [groupX, groupY] =
            this._bmsDashInfo.background_group.get_transformed_position();
        // BMS keeps a zero-sized BackgroundGroup centred in the monitor and
        // positions its blur child in that local coordinate space. Convert
        // the exact visible glass position back into the same space.
        this._bmsBlurSurface.set_position(
            Math.round(targetX - groupX),
            Math.round(targetY - groupY));
        this._bmsBlurSurface.set_size(
            Math.round(width), Math.round(height));
        this._dockBlurEffect?.queue_repaint?.();
    }

    _attachNativeBlur() {
        if (!this._nativeBlurLayer)
            return;
        const params = {
            sigma: this._settings.get_int('blur-sigma'),
            brightness: this._settings.get_double('blur-brightness'),
            radius: FALLBACK_BORDER_RADIUS,
        };
        if (!this._nativeBlurSurface) {
            this._nativeBlurSurface = new NativeBlurSurface(params);
            this._nativeBlurLayer.add_child(this._nativeBlurSurface);
            this._nativeBlurSurface.initialize();
        } else {
            this._nativeBlurSurface.update(params);
        }
        this._dockBlurStatus = 'attached-native-dynamic-surface';
        this._applyDockBackgroundStyle(FALLBACK_BORDER_RADIUS);
    }

    _scheduleStartupRelayouts() {
        for (const delay of [0, 250, 900, 1800]) {
            const id = GLib.timeout_add_once(
                GLib.PRIORITY_DEFAULT, delay, () => {
                    const index = this._startupRelayoutIds.indexOf(id);
                    if (index >= 0)
                        this._startupRelayoutIds.splice(index, 1);
                    if (!this._outer)
                        return;
                    this._relayout();
                });
            this._startupRelayoutIds.push(id);
            GLib.Source.set_name_by_id(id,
                '[maclike-dock] stabilize startup geometry');
        }
    }

    _detachNativeBlur() {
        this._nativeBlurSurface?.destroy();
        this._nativeBlurSurface = null;
    }

    _syncDynamicDockBlur() {
        if (this._usesManagedBmsBlur) {
            const radius = this._getBmsDockRadius();
            this._syncManagedBmsBlurGeometry();
            this._applyDockBackgroundStyle(radius);
            this._border?.set_style(`border-radius: ${radius}px;`);
            return;
        }
        if (!this._dockBlurEffect)
            return;
        const dashSettings = global.blur_my_shell?._settings?.dash_to_dock;
        if (!dashSettings)
            return;
        const radius = this._getBmsDockRadius();
        this._dockBlurEffect.unscaled_radius = 2 * dashSettings.SIGMA;
        this._dockBlurEffect.brightness = dashSettings.BRIGHTNESS;
        // Blur My Shell expects a logical radius and scales it for the monitor.
        // Assigning corner_radius directly breaks the HiDPI mask.
        this._dockBlurEffect.unscaled_corner_radius = radius;
        if (this._dockCornerEffect)
            this._dockCornerEffect.radius = radius;
        this._applyDockBackgroundStyle(radius);
        this._border?.set_style(`border-radius: ${radius}px;`);
    }

    _trackBmsDashManager() {
        const manager = global.blur_my_shell?._dash_to_dock_blur;
        if (manager === this._bmsDashManager)
            return;
        this._disconnectBmsDashManager();
        this._bmsDashManager = manager;
        if (!manager)
            return;
        const reassert = () => {
            if (this._settings.get_string('blur-engine') === 'bms') {
                this._refreshDynamicDockBlur();
            } else {
                this._hideManagedBmsDashSurface();
                this._syncDynamicDockBlur();
            }
        };
        for (const signal of [
            'show', 'change-blur-type', 'update-pipeline', 'update-size',
        ]) {
            try {
                this._bmsDashSignals.push([
                    manager, manager.connect(signal, reassert),
                ]);
            } catch {
                // Not every Blur My Shell release exposes every signal.
            }
        }
    }

    _disconnectBmsDashManager() {
        for (const [object, id] of this._bmsDashSignals) {
            try {
                object.disconnect(id);
            } catch {
                // The component may have been destroyed before this Dock.
            }
        }
        this._bmsDashSignals = [];
        this._bmsDashManager = null;
    }

    _hideManagedBmsDashSurface() {
        const info = global.blur_my_shell?._dash_to_dock_blur?.dashes
            ?.find(candidate => candidate.dash === this._dash);
        if (!info?.background_group)
            return;
        this._bmsDashInfo = info;
        info.background_group.hide();
    }

    _detachDynamicDockBlur() {
        if (this._usesManagedBmsBlur) {
            try {
                this._bmsDashInfo?.background_group?.hide();
            } catch {
                // BMS may already have replaced or destroyed this surface.
            }
            this._dockCornerEffect = null;
            this._dockBlurEffect = null;
            this._dockBlurEffectsManager = null;
            this._bmsBlurSurface = null;
            this._bmsDashInfo = null;
            this._usesManagedBmsBlur = false;
            this._applyDockBackgroundStyle(this._getBmsDockRadius());
            return;
        }
        this._bmsDashInfo = null;
        if (this._dockCornerEffect) {
            try {
                this._dockBlurEffectsManager?.remove(this._dockCornerEffect);
            } catch {
                try {
                    this._bmsBlurSurface?.remove_effect(
                        this._dockCornerEffect);
                } catch {
                    // Blur My Shell already removed the mask.
                }
            }
        }
        if (this._dockBlurEffect) {
            try {
                this._dockBlurEffectsManager?.remove(this._dockBlurEffect);
            } catch {
                try {
                    this._bmsBlurSurface?.remove_effect(this._dockBlurEffect);
                } catch {
                    // Blur My Shell already removed the effect.
                }
            }
        }
        this._dockCornerEffect = null;
        this._dockBlurEffect = null;
        this._dockBlurEffectsManager = null;
        this._bmsBlurSurface?.destroy();
        this._bmsBlurSurface = null;
        this._usesManagedBmsBlur = false;
        this._applyDockBackgroundStyle(this._getBmsDockRadius());
    }

    _noteInteraction() {
        this._graceUntil = GLib.get_monotonic_time() / 1000 + INTERACTION_GRACE;
    }

    _onItemActivated(app) {
        this._noteInteraction();
        if (app?.get_state() === Shell.AppState.STOPPED)
            this._pinLaunch(app);
    }

    _disconnectLaunchAppSignals() {
        for (const [object, id] of this._launchAppSignals) {
            try {
                object.disconnect(id);
            } catch {
                // The application may have disappeared while launching.
            }
        }
        this._launchAppSignals = [];
    }

    _finishLaunchPin(delay = 0) {
        if (this._launchPinTimeout) {
            GLib.source_remove(this._launchPinTimeout);
            this._launchPinTimeout = 0;
        }
        this._disconnectLaunchAppSignals();
        const finish = () => {
            this._launchPinTimeout = 0;
            this._launchPinned = false;
            this._evaluateVisibility();
        };
        if (delay <= 0) {
            finish();
            return;
        }
        this._launchPinTimeout = GLib.timeout_add_once(
            GLib.PRIORITY_DEFAULT, delay, finish);
        GLib.Source.set_name_by_id(this._launchPinTimeout,
            '[maclike-dock] launch settle');
    }

    _pinLaunch(app) {
        if (this._launchPinTimeout) {
            GLib.source_remove(this._launchPinTimeout);
            this._launchPinTimeout = 0;
        }
        this._disconnectLaunchAppSignals();
        this._launchPinned = true;
        const settleWhenMapped = () => {
            if (!this._launchPinned ||
                app.get_state() !== Shell.AppState.RUNNING ||
                app.get_windows().length === 0)
                return;
            // Let Mutter finish the first window allocation before dodge is
            // allowed to evaluate overlap. This prevents hide/show oscillation
            // while an application is mapping.
            this._finishLaunchPin(320);
        };
        this._launchAppSignals.push(
            [app, app.connect('notify::state', settleWhenMapped)],
            [app, app.connect('windows-changed', settleWhenMapped)]);
        this._launchPinTimeout = GLib.timeout_add_once(
            GLib.PRIORITY_DEFAULT, LAUNCH_PIN_MS, () => {
                this._launchPinTimeout = 0;
                this._disconnectLaunchAppSignals();
                this._launchPinned = false;
                this._evaluateVisibility();
            });
        GLib.Source.set_name_by_id(this._launchPinTimeout,
            '[maclike-dock] launch pin');
    }

    _relayout() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const iconSize = this._settings.get_int('icon-size');
        const maxScale = this._settings.get_double('magnification');
        const maxHeight = Math.ceil(iconSize * maxScale + 34);
        const outerHeight = maxHeight + 4;
        this._outer.set_position(monitor.x,
            monitor.y + monitor.height - outerHeight - DOCK_BOTTOM_GAP);
        this._outer.set_size(monitor.width, outerHeight);
        this._syncDashBottomAnchor();
        this._syncEdgeTrigger();
        if (this._hidden)
            this._outer.translation_y = this._outer.height - 2;
        this._syncStrut();
    }

    _syncDashBottomAnchor() {
        if (!this._outer || !this._dash)
            return;
        // The intermediate BinLayout can briefly report the child's natural
        // height while it is processing a descendant relayout. The outer
        // actor has an explicit, monitor-derived height and is therefore the
        // only stable reference for the visible bottom edge.
        const containerHeight = this._outer.height;
        const allocation = this._dash.get_allocation_box();
        const dashY = allocation.y1;
        const dashHeight = allocation.y2 - allocation.y1;
        if (containerHeight <= 0 || dashHeight <= 0 ||
            !Number.isFinite(dashY) || !Number.isFinite(dashHeight))
            return;
        // Some Shell themes centre #dash inside a Dash-to-Dock container,
        // then switch it to bottom alignment after the first hover. The
        // allocation box excludes our previous transform, so recomputing from
        // it cannot apply the startup correction twice.
        const maxCorrection = Math.max(0, containerHeight - dashHeight);
        const correction = Math.round(Math.clamp(
            containerHeight - dashY - dashHeight, 0, maxCorrection));
        if (this._dash.translation_y !== correction)
            this._dash.translation_y = correction;
        this._syncManagedBmsBlurGeometry();
    }

    _syncEdgeTrigger() {
        if (!this._edgeTrigger || !this._dash)
            return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const [, preferredWidth] = this._dash.get_preferred_width(-1);
        const width = Math.max(1, Math.ceil(
            this._dash.width > 0 ? this._dash.width : preferredWidth));
        const triggerWidth = Math.min(monitor.width, width + 24);
        this._edgeTrigger.set_position(
            Math.round(monitor.x + (monitor.width - triggerWidth) / 2),
            monitor.y + monitor.height - 2);
        this._edgeTrigger.set_size(triggerWidth, 2);
    }

    _syncStrut() {
        if (!this._outer ||
            !this._settings.get_boolean('reserve-space-for-maximized')) {
            this._destroyStrut();
            return;
        }
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        if (!this._strut) {
            this._strut = new St.Widget({
                name: 'maclike-dock-maximize-strut',
                reactive: false,
                opacity: 0,
            });
            Main.layoutManager.addChrome(this._strut, {
                affectsStruts: true,
                trackFullscreen: true,
            });
        }
        const [, preferredHeight] = this._dash.get_preferred_height(-1);
        const dashHeight = Math.max(1, Math.ceil(
            this._dash.height > 0 ? this._dash.height : preferredHeight));
        const reservedHeight = dashHeight + DOCK_BOTTOM_GAP;
        this._strut.set_position(
            monitor.x, monitor.y + monitor.height - reservedHeight);
        this._strut.set_size(monitor.width, reservedHeight);
    }

    _destroyStrut() {
        if (!this._strut)
            return;
        try {
            Main.layoutManager.removeChrome(this._strut);
        } catch {
            // Shell may have removed this chrome actor during shutdown.
        }
        this._strut.destroy();
        this._strut = null;
    }

    _rebuild() {
        this._stack?.destroy();
        this._stack = null;
        this._menuOpen = false;
        for (const item of this._items)
            item.cleanup();
        this._items = [];
        this._itemsBox.destroy_all_children();

        const iconSize = this._settings.get_int('icon-size');
        const maxScale = this._settings.get_double('magnification');
        const renderSize = Math.ceil(iconSize * maxScale);
        const slotSize = iconSize + 12;
        const maxDots = this._settings.get_int('indicator-max-dots');
        // Fix the glass height before Clutter's first allocation. The outer
        // actor remains taller to reserve headroom for magnified icons.
        this._dash.set_height(iconSize + 25);

        const favorites = AppFavorites.getAppFavorites().getFavorites();
        const favoriteIds = new Set(favorites.map(app => app.get_id()));
        const apps = [...favorites];

        if (this._settings.get_boolean('show-running-apps')) {
            const running = this._appSystem.get_running()
                .filter(app => !favoriteIds.has(app.get_id()))
                .sort((a, b) => a.get_name().localeCompare(b.get_name()));
            apps.push(...running);
        }

        for (const app of apps) {
            this._addItem(new AppDockItem(
                app, iconSize, renderSize, slotSize,
                (open, item) => this._onMenuChanged(open, item), maxDots,
                activatedApp => this._onItemActivated(activatedApp)));
        }

        const folders = this._resolveFolderPaths();
        if (folders.length > 0 && apps.length > 0)
            this._itemsBox.add_child(new St.Widget({style_class: 'maclike-dock-separator'}));

        for (const path of folders) {
            const file = Gio.File.new_for_path(path);
            try {
                const type = file.query_file_type(Gio.FileQueryInfoFlags.NONE, null);
                if (type !== Gio.FileType.DIRECTORY)
                    continue;
                const label = GLib.basename(path);
                let item = null;
                item = new FolderDockItem({
                    file,
                    label,
                    iconSize,
                    renderSize,
                    slotSize,
                    activate: () => this._toggleStack(file, item),
                    iconStyle: this._settings.get_string('folder-icon-style'),
                    cardSpread: this._settings.get_int(
                        'folder-card-spread'),
                    cardCount: this._settings.get_int('folder-card-count'),
                });
                this._addItem(item);
            } catch (error) {
                this._logger.warn(
                    `${_('Unable to add folder')} ${path}: ${error}`);
            }
        }

        this._lastSignature = this._itemsSignature();
        this._relayout();
        this._evaluateVisibility();
    }

    _itemsSignature() {
        const favorites = AppFavorites.getAppFavorites().getFavorites();
        const favoriteIds = favorites.map(app => app.get_id());
        const runningIds = this._settings.get_boolean('show-running-apps')
            ? this._appSystem.get_running()
                .filter(app => !favoriteIds.includes(app.get_id()))
                .map(app => app.get_id())
            : [];
        return JSON.stringify({
            favorites: favoriteIds,
            running: runningIds.sort(),
            folders: this._settings.get_strv('folder-paths'),
            folderIconStyle: this._settings.get_string('folder-icon-style'),
        });
    }

    _rebuildOnChange() {
        const signature = this._itemsSignature();
        if (signature === this._lastSignature)
            return;
        this._rebuild();
    }

    _resolveFolderPaths() {
        const home = GLib.get_home_dir();
        const downloads = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) ??
            GLib.build_filenamev([home, 'Downloads']);
        const paths = [];
        for (const entry of this._settings.get_strv('folder-paths')) {
            let path = entry;
            if (entry === 'special://downloads')
                path = downloads;
            else if (entry.startsWith('~/'))
                path = GLib.build_filenamev([home, entry.slice(2)]);
            if (path && !paths.includes(path))
                paths.push(path);
        }
        return paths;
    }

    _addItem(item) {
        this._items.push(item);
        this._itemsBox.add_child(item);
    }

    _onMenuChanged(open) {
        this._menuOpen = open;
        if (open)
            this._releaseMagnification();
        this._evaluateVisibility();
    }

    _toggleStack(file, item) {
        if (this._stack) {
            this._stack.close();
            return;
        }
        this._noteInteraction();
        this._releaseMagnification();
        const openIcon = new Gio.FileIcon({
            file: Gio.File.new_for_path(GLib.build_filenamev([
                this._extensionPath, 'icons', 'open-in-files-glass.svg',
            ])),
        });
        this._stack = new StackPopup({
            file,
            anchorActor: item,
            maxItems: this._settings.get_int('stack-max-items'),
            sortMode: this._settings.get_string('stack-sort'),
            viewMode: this._settings.get_string('stack-view'),
            gridColumns: this._settings.get_int('grid-columns'),
            openIcon,
            logger: this._logger,
            onDestroy: () => {
                this._stack = null;
                this._evaluateVisibility();
            },
        });
        this._stack.open();
    }

    _onStageEvent(event) {
        if (event.type() === Clutter.EventType.LEAVE) {
            let pointerX = this._pointerX;
            let pointerY = this._pointerY;
            try {
                [pointerX, pointerY] = global.get_pointer();
            } catch {
                // The cached coordinates remain valid during Shell shutdown.
            }
            this._handleStageLeave(pointerX, pointerY);
            return Clutter.EVENT_PROPAGATE;
        }
        if (event.type() !== Clutter.EventType.MOTION)
            return Clutter.EVENT_PROPAGATE;

        const [x, y] = event.get_coords();
        const inside = this._isInsideDock(x, y);

        this._pointerX = x;
        this._pointerY = y;
        if (inside !== this._pointerInside) {
            if (!inside) {
                const endedEdgeSession = this._edgeRevealEnteredDock;
                this._releaseMagnification();
                if (endedEdgeSession)
                    this._finishEdgeReveal();
            } else {
                this._pointerInside = true;
                if (this._edgeRevealLatched)
                    this._edgeRevealEnteredDock = true;
            }
        }
        if (inside || this._timeline.is_playing())
            this._startTimeline();
        this._evaluateVisibility();

        return Clutter.EVENT_PROPAGATE;
    }

    _handleStageLeave(pointerX, pointerY) {
        this._pointerX = pointerX;
        this._pointerY = pointerY;
        if (this._launchPinned && this._isInsideDock(pointerX, pointerY)) {
            // Mapping a new client briefly transfers pointer focus away from
            // Shell even though the pointer is still over the Dock. Retaining
            // this state avoids a one-frame magnification collapse/rebound.
            this._pointerInside = true;
            this._evaluateVisibility();
            return;
        }

        const endedEdgeSession = this._edgeRevealEnteredDock;
        this._releaseMagnification();
        if (endedEdgeSession)
            this._finishEdgeReveal();
        this._evaluateVisibility();
    }

    _isInsideDock(x, y) {
        const [dashX, dashY] = this._dash.get_transformed_position();
        const [dashWidth, dashHeight] = this._dash.get_transformed_size();
        return dashWidth > 0 && dashHeight > 0 &&
            x >= dashX && x <= dashX + dashWidth &&
            y >= dashY && y <= dashY + dashHeight + 3;
    }

    _isAtRevealEdge() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return false;
        const [dashX] = this._dash.get_transformed_position();
        const [dashWidth] = this._dash.get_transformed_size();
        const bottom = monitor.y + monitor.height;
        return Boolean(this._edgeTrigger?.hover) || (dashWidth > 0 &&
            this._pointerX >= dashX - 10 &&
            this._pointerX <= dashX + dashWidth + 10 &&
            this._pointerY >= bottom - 3 && this._pointerY <= bottom);
    }

    _finishEdgeReveal() {
        this._edgeRevealLatched = false;
        this._edgeRevealEnteredDock = false;
        this._edgeRevealUntil = 0;
    }

    _hasOverlappingWindow() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return false;
        const workspace = global.workspace_manager.get_active_workspace();
        const [dashX, transformedDashY] = this._dash.get_transformed_position();
        const [dashWidth, dashHeight] = this._dash.get_transformed_size();
        if (dashWidth <= 0 || dashHeight <= 0)
            return false;
        // translation_y animates the whole dock while hiding it. Removing that
        // translation gives us the exact visible-position rectangle and avoids
        // hide/show oscillation once the actor has moved below the monitor.
        const translationY = Number.isFinite(this._outer.translation_y)
            ? this._outer.translation_y : 0;
        const dockTop = transformedDashY - translationY;
        const dockBottom = dockTop + dashHeight;
        const dockRight = dashX + dashWidth;

        for (const window of global.display.get_tab_list(Meta.TabList.NORMAL, workspace)) {
            if (window.minimized || !window.showing_on_its_workspace() ||
                window.get_monitor() !== monitor.index)
                continue;
            const rect = window.get_frame_rect();
            const overlapsX = rect.x < dockRight && rect.x + rect.width > dashX;
            const overlapsY = rect.y < dockBottom &&
                rect.y + rect.height > dockTop;
            if (overlapsX && overlapsY)
                return true;
        }
        return false;
    }

    _hasMaximizedWindow() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return false;
        const workspace = global.workspace_manager.get_active_workspace();
        for (const window of global.display.get_tab_list(
            Meta.TabList.NORMAL, workspace)) {
            if (window.minimized || !window.showing_on_its_workspace() ||
                window.get_monitor() !== monitor.index)
                continue;
            if (this._isFullyMaximized(window))
                return true;
        }
        return false;
    }

    _isFullyMaximized(window) {
        // GNOME 50 exposes these states as GObject properties; get_maximized()
        // is not part of the JavaScript API.
        return Boolean(window?.maximized_horizontally &&
            window?.maximized_vertically);
    }

    _evaluateVisibility() {
        if (!this._outer)
            return;
        const mode = this._settings.get_string('visibility-mode');
        const interactionOpen = this._menuOpen || Boolean(this._stack);
        const pinnedOpen = interactionOpen || this._launchPinned;
        let pointerOverDock = this._pointerInside;
        if (!this._hidden && !pointerOverDock) {
            try {
                const [pointerX, pointerY] = global.get_pointer();
                pointerOverDock = this._isInsideDock(pointerX, pointerY);
            } catch {
                pointerOverDock = this._isInsideDock(
                    this._pointerX, this._pointerY);
            }
        }
        const edge = this._isAtRevealEdge();
        const now = GLib.get_monotonic_time() / 1000;
        if (this._edgeRevealLatched && !this._edgeRevealEnteredDock &&
                !this._pointerInside && now >= this._edgeRevealUntil)
            this._finishEdgeReveal();
        if (!edge && !this._pointerInside)
            this._edgeRevealArmed = true;
        if (edge && this._hidden && this._edgeRevealArmed) {
            this._edgeRevealLatched = true;
            this._edgeRevealArmed = false;
            this._edgeRevealUntil = now + EDGE_REVEAL_GRACE;
        }
        if (this._pointerInside && this._edgeRevealLatched)
            this._edgeRevealEnteredDock = true;
        const edgeRevealActive = this._edgeRevealLatched ||
            now < this._edgeRevealUntil;
        let shouldHide = false;
        let immediate = false;

        if (this._settings.get_boolean('hide-in-overview') && this._inOverview) {
            shouldHide = true;
            immediate = true;
        } else if (this._settings.get_boolean(
            'reserve-space-for-maximized') && this._hasMaximizedWindow()) {
            // Reserved space represents a persistent Dock. A maximized window
            // constrained by that strut must not auto-hide it.
            shouldHide = false;
        } else if (mode === 'dodge') {
            const overlap = this._hasOverlappingWindow();
            // Keep a launch stable while Mutter maps its first window. Stored
            // pointer coordinates also survive the transient hover loss caused
            // by the new client receiving keyboard focus.
            if (overlap && !pointerOverDock &&
                    !edgeRevealActive && !pinnedOpen) {
                shouldHide = true;
                immediate = true;
            }
        } else if (mode === 'autohide') {
            shouldHide = !this._pointerInside &&
                !edgeRevealActive && !pinnedOpen;
        }

        const delay = shouldHide
            ? (immediate ? 0 : this._settings.get_int('hide-delay'))
            : this._settings.get_int('show-delay');
        this._scheduleHidden(shouldHide, delay);
    }

    _scheduleHidden(hidden, delay) {
        if (this._visibilityTarget === hidden && this._visibilityTimeout)
            return;
        if (!this._visibilityTimeout && this._hidden === hidden) {
            this._visibilityTarget = hidden;
            return;
        }
        if (this._visibilityTimeout) {
            GLib.source_remove(this._visibilityTimeout);
            this._visibilityTimeout = 0;
        }
        this._visibilityTarget = hidden;
        if (delay <= 0) {
            this._applyHidden(hidden);
            return;
        }
        this._visibilityTimeout = GLib.timeout_add_once(
            GLib.PRIORITY_DEFAULT, delay, () => {
                this._visibilityTimeout = 0;
                this._applyHidden(hidden);
            });
        GLib.Source.set_name_by_id(this._visibilityTimeout,
            '[maclike-dock] visibility delay');
    }

    _applyHidden(hidden) {
        if (!this._outer || this._hidden === hidden)
            return;
        this._hidden = hidden;
        if (hidden) {
            this._releaseMagnification();
        } else {
            this._noteInteraction();
        }
        this._outer.remove_all_transitions();
        this._outer.ease({
            translation_y: hidden ? this._outer.height - 2 : 0,
            duration: this._settings.get_int('hide-animation-duration'),
            mode: hidden
                ? Clutter.AnimationMode.EASE_IN_QUAD
                : Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    _updateVisibilityWatcher() {
        if (this._windowWatchId) {
            GLib.source_remove(this._windowWatchId);
            this._windowWatchId = 0;
        }
        if (this._settings.get_string('visibility-mode') !== 'dodge' &&
            !this._settings.get_boolean('reserve-space-for-maximized'))
            return;
        this._windowWatchId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 50, () => {
                this._evaluateVisibility();
                return GLib.SOURCE_CONTINUE;
            });
        GLib.Source.set_name_by_id(this._windowWatchId,
            '[maclike-dock] window overlap watcher');
    }

    _startTimeline() {
        if (!this._timeline.is_playing()) {
            this._lastFrameTime = GLib.get_monotonic_time() / 1000;
            this._timeline.start();
        }
    }

    _releaseMagnification() {
        this._pointerInside = false;
        this._hideTooltip();
        for (const item of this._items)
            item.targetScale = 1;
        if (this._items.length > 0)
            this._startTimeline();
    }

    _tick() {
        if (this._items.length === 0)
            return;

        // Theme pseudo-class changes can reallocate #dash without notifying
        // its y property. Keep the visible glass anchored during interaction.
        this._syncDashBottomAnchor();

        const now = GLib.get_monotonic_time() / 1000;
        let delta = now - this._lastFrameTime;
        if (!Number.isFinite(delta) || delta < 0)
            delta = 1;
        delta = Math.clamp(delta, 1, 50);
        this._lastFrameTime = now;
        const response = Math.max(20, this._settings.get_int('animation-duration'));
        const alpha = 1 - Math.exp(-delta / response);
        const baseSize = this._settings.get_int('icon-size');
        const maxScale = this._settings.get_double('magnification');
        const radius = baseSize * this._settings.get_double('magnification-radius');

        let moving = false;
        for (const item of this._items) {
            if (this._pointerInside) {
                const distance = Math.abs(this._pointerX - item.baseCenterX());
                const normalized = radius > 0 ? Math.min(1, distance / radius) : 0;
                const influence = Math.pow(Math.cos(normalized * Math.PI / 2), 2);
                item.targetScale = 1 + (maxScale - 1) * influence;
            } else {
                item.targetScale = 1;
            }
            if (!Number.isFinite(item.targetScale) || item.targetScale <= 0)
                item.targetScale = 1;
            if (!Number.isFinite(item.currentScale) || item.currentScale <= 0)
                item.currentScale = 1;
            item.currentScale += (item.targetScale - item.currentScale) * alpha;
            if (!Number.isFinite(item.currentScale))
                item.currentScale = 1;
            if (Math.abs(item.targetScale - item.currentScale) > 0.002)
                moving = true;
        }

        const expansions = this._items.map(item =>
            baseSize * (item.currentScale - 1) * 0.46);
        const totalExpansion = expansions.reduce((sum, value) => sum + value, 0);
        let cursor = -totalExpansion / 2;
        this._items.forEach((item, index) => {
            const translation = cursor + expansions[index] / 2;
            cursor += expansions[index];
            item.applyMagnification(item.currentScale, translation);
        });

        this._syncTooltip();
        if (!this._pointerInside && !moving)
            this._timeline.stop();
    }

    _syncTooltip() {
        if (!this._pointerInside || this._menuOpen || this._stack) {
            this._hideTooltip();
            return;
        }

        let nearest = null;
        let nearestDistance = Infinity;
        for (const item of this._items) {
            const distance = Math.abs(this._pointerX - item.visualCenterX());
            if (distance < nearestDistance) {
                nearest = item;
                nearestDistance = distance;
            }
        }
        if (!nearest || nearestDistance > nearest.baseSlotSize * 0.62) {
            this._hideTooltip();
            return;
        }

        if (this._tooltipItem !== nearest) {
            this._tooltipItem = nearest;
            this._tooltip.text = nearest.labelText;
            this._tooltip.show();
            this._tooltip.opacity = 255;
        }
        const [iconX, iconY] = nearest._iconActor.get_transformed_position();
        const [iconWidth] = nearest._iconActor.get_transformed_size();
        const [, labelWidth] = this._tooltip.get_preferred_width(-1);
        const [, labelHeight] = this._tooltip.get_preferred_height(labelWidth);
        this._tooltip.set_position(
            Math.round(Math.clamp(iconX + (iconWidth - labelWidth) / 2,
                8, global.stage.width - labelWidth - 8)),
            Math.round(iconY - labelHeight - 9));
    }

    _hideTooltip() {
        this._tooltipItem = null;
        this._tooltip?.hide();
    }

    destroy() {
        this._stack?.destroy();
        this._stack = null;
        this._timeline?.stop();
        if (this._visibilityTimeout)
            GLib.source_remove(this._visibilityTimeout);
        if (this._windowWatchId)
            GLib.source_remove(this._windowWatchId);
        if (this._launchPinTimeout)
            GLib.source_remove(this._launchPinTimeout);
        this._disconnectLaunchAppSignals();
        for (const id of this._startupRelayoutIds)
            GLib.source_remove(id);
        this._startupRelayoutIds = [];
        this._visibilityTimeout = 0;
        this._windowWatchId = 0;
        this._launchPinTimeout = 0;
        this._destroyStrut();
        this._disconnectBmsSettings();
        const bmsDashInfo = this._bmsDashInfo;
        this._disconnectBmsDashManager();
        this._detachDynamicDockBlur();
        if (bmsDashInfo?.remove_dash_blur) {
            try {
                // Let Blur My Shell detach while both sibling actors still
                // have a parent. Its dash destroy handler otherwise runs after
                // Clutter has already disposed the managed background group.
                bmsDashInfo.remove_dash_blur();
            } catch (error) {
                this._logger.warn(
                    `${_('Unable to detach the Blur My Shell surface')}: ` +
                    `${error}`);
            }
        }
        this._detachNativeBlur();
        for (const [object, id] of this._signals) {
            try {
                object.disconnect(id);
            } catch {
                // The object may have disappeared during Shell shutdown.
            }
        }
        this._signals = [];
        for (const item of this._items)
            item.cleanup();
        if (this._overviewDash && this._overviewDashState) {
            this._overviewDash.opacity = this._overviewDashState.opacity;
            this._overviewDash.reactive = this._overviewDashState.reactive;
            if (this._overviewDashState.visible)
                this._overviewDash.show();
        }
        this._tooltip?.destroy();
        if (this._edgeTrigger) {
            try {
                Main.layoutManager.removeChrome(this._edgeTrigger);
            } catch {
                // Shell may already have removed the hot edge.
            }
            this._edgeTrigger.destroy();
        }
        this._outer?.destroy();
        this._timeline = null;
        this._tooltip = null;
        this._edgeTrigger = null;
        this._outer = null;
        this._dash = null;
        this._border = null;
        this._itemsBox = null;
        this._items = [];
        this._settings = null;
        this._interfaceSettings = null;
    }
}
