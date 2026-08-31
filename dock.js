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
        this._dockBlurStatus = 'not-attached';
        this._nativeBlurSurface = null;
        this._strut = null;
        this._launchPinned = false;
        this._launchPinTimeout = 0;
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
        this._dash.add_child(this._itemsBox);
        // The border is deliberately independent from dash-background.
        // Blur My Shell replaces the dash style class and owns the background,
        // but both actors still receive the exact same BinLayout allocation.
        this._dash.add_child(this._border);

        this._outer = new DashToDock(this._dash);
        this._syncColorScheme();
        Main.layoutManager.addChrome(this._outer, {
            affectsStruts: false,
            trackFullscreen: true,
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
        this._connect(Main.layoutManager, 'monitors-changed', () => this._relayout());
        this._connect(this._interfaceSettings, 'changed::color-scheme', () => {
            this._syncColorScheme();
            this._syncBorder();
        });
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
        const dark = this._interfaceSettings.get_string('color-scheme') ===
            'prefer-dark';
        this._darkTheme = dark;
        this._outer.remove_style_class_name('maclike-dark');
        this._outer.remove_style_class_name('maclike-light');
        this._outer.add_style_class_name(dark
            ? 'maclike-dark' : 'maclike-light');
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
            this._dash._background.set_style(
                `border-radius: ${radius}px; ` +
                'background-color: transparent; box-shadow: none;');
        } else if (this._dockBlurEffect || this._nativeBlurSurface) {
            const tint = this._darkTheme
                ? 'rgba(20, 24, 32, 0.46)'
                : 'rgba(205, 218, 239, 0.25)';
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
        if (managedInfo?.background_group) {
            this._bmsDashInfo = managedInfo;
            // Blur My Shell sizes its Dash-to-Dock surface from the outer
            // magnification reserve. That allocation is deliberately taller
            // than the visible glass, so its managed surface cannot be used
            // without leaking the startup geometry around the Dock. Keep that
            // actor hidden and attach BMS's own effects to the exact visible
            // background actor instead.
            managedInfo.background_group.hide();
        }

        const attachedActor = this._dockBlurEffect?.get_actor?.();
        const maskActor = this._dockCornerEffect?.get_actor?.();
        if (this._dockBlurEffectsManager !== effectsManager ||
            attachedActor !== this._dash._background ||
            maskActor !== this._dash._background) {
            this._detachDynamicDockBlur();
            try {
                const radius = this._getBmsDockRadius();
                this._dockBlurEffectsManager = effectsManager;
                this._dockBlurEffect =
                    effectsManager.new_native_dynamic_gaussian_blur_effect({
                        unscaled_radius: 2 * dashSettings.SIGMA,
                        brightness: dashSettings.BRIGHTNESS,
                        corner_radius: radius,
                    });
                this._dockCornerEffect = effectsManager.new_corner_effect({
                    radius,
                    corners_top: true,
                    corners_bottom: true,
                });
                // Clutter paints effects in reverse get_effects() order.
                // Add the mask first so it clips pixels expanded by the blur.
                this._dash._background.add_effect(this._dockCornerEffect);
                this._dash._background.add_effect(this._dockBlurEffect);
                this._dockBlurEffect.unscaled_corner_radius = radius;
                this._dockBlurStatus = 'attached-dynamic-bms-effect-and-mask';
            } catch (error) {
                this._dockBlurStatus = `error: ${error}`;
                this._logger.warn(
                    `${_('Unable to apply dynamic blur to the Dock')}: ` +
                    `${error}`);
                this._detachDynamicDockBlur();
                return;
            }
        }
        this._trackBmsDashManager();
        this._syncDynamicDockBlur();
        this._hideManagedBmsDashSurface();
        this._syncBorder();
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
                this._bmsDashInfo = global.blur_my_shell?._dash_to_dock_blur
                    ?.dashes?.find(candidate => candidate.dash === this._dash);
                this._bmsDashInfo?.background_group?.hide();
                this._syncDynamicDockBlur();
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
        this._bmsDashInfo = null;
        if (this._dockCornerEffect) {
            try {
                this._dockBlurEffectsManager?.remove(this._dockCornerEffect);
            } catch {
                try {
                    this._dash?._background?.remove_effect(
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
                    this._dash?._background?.remove_effect(this._dockBlurEffect);
                } catch {
                    // Blur My Shell already removed the effect.
                }
            }
        }
        this._dockCornerEffect = null;
        this._dockBlurEffect = null;
        this._dockBlurEffectsManager = null;
        this._applyDockBackgroundStyle(this._getBmsDockRadius());
    }

    _noteInteraction() {
        this._graceUntil = GLib.get_monotonic_time() / 1000 + INTERACTION_GRACE;
    }

    _onItemActivated() {
        this._noteInteraction();
        this._pinLaunch();
    }

    _pinLaunch() {
        this._launchPinned = true;
        if (this._launchPinTimeout) {
            GLib.source_remove(this._launchPinTimeout);
            this._launchPinTimeout = 0;
        }
        this._launchPinTimeout = GLib.timeout_add_once(
            GLib.PRIORITY_DEFAULT, LAUNCH_PIN_MS, () => {
                this._launchPinTimeout = 0;
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
        if (this._hidden)
            this._outer.translation_y = this._outer.height - 2;
        this._syncStrut();
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
                () => this._onItemActivated()));
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
            const endedEdgeSession = this._edgeRevealEnteredDock;
            this._releaseMagnification();
            if (endedEdgeSession)
                this._finishEdgeReveal();
            this._evaluateVisibility();
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
        return dashWidth > 0 &&
            this._pointerX >= dashX - 10 &&
            this._pointerX <= dashX + dashWidth + 10 &&
            this._pointerY >= bottom - 3 && this._pointerY <= bottom;
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
            // A real overlap takes precedence over the launch pin. Menus,
            // stacks, direct pointer interaction and edge reveal remain usable.
            if (overlap && !this._pointerInside &&
                    !edgeRevealActive && !interactionOpen) {
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
        for (const id of this._startupRelayoutIds)
            GLib.source_remove(id);
        this._startupRelayoutIds = [];
        this._visibilityTimeout = 0;
        this._windowWatchId = 0;
        this._launchPinTimeout = 0;
        this._destroyStrut();
        this._disconnectBmsSettings();
        if (this._bmsDashInfo?.remove_dash_blur) {
            try {
                // Let Blur My Shell detach while both sibling actors still
                // have a parent. Its dash destroy handler otherwise runs after
                // Clutter has already disposed the managed background group.
                this._bmsDashInfo.remove_dash_blur();
            } catch (error) {
                this._logger.warn(
                    `${_('Unable to detach the Blur My Shell surface')}: ` +
                    `${error}`);
            }
            this._bmsDashInfo = null;
        }
        this._disconnectBmsDashManager();
        this._detachDynamicDockBlur();
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
        this._outer?.destroy();
        this._timeline = null;
        this._tooltip = null;
        this._outer = null;
        this._dash = null;
        this._border = null;
        this._itemsBox = null;
        this._items = [];
        this._settings = null;
        this._interfaceSettings = null;
    }
}
