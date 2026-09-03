import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import St from 'gi://St';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const FILE_ATTRIBUTES = [
    'standard::name',
    'standard::display-name',
    'standard::icon',
    'standard::content-type',
    'standard::type',
    'standard::is-hidden',
    'time::modified',
].join(',');

function iconForFile(file, info) {
    const contentType = info?.has_attribute('standard::content-type')
        ? info.get_content_type() ?? ''
        : '';
    if (contentType.startsWith('image/'))
        return new Gio.FileIcon({file});
    return info?.get_icon() ?? new Gio.ThemedIcon({name: 'text-x-generic-symbolic'});
}

const FanRow = GObject.registerClass(
class FanRow extends St.Button {
    _init({file, info, isFolderAction = false, openIcon, activate}) {
        super._init({
            style_class: 'maclike-stack-row',
            reactive: true,
            can_focus: true,
            track_hover: true,
            pivot_point: new Graphene.Point({x: 0.82, y: 0.5}),
        });

        const box = new St.BoxLayout({
            style_class: 'maclike-stack-row-box',
            orientation: Clutter.Orientation.HORIZONTAL,
        });
        const label = new St.Label({
            style_class: 'maclike-stack-label',
            text: isFolderAction ? _('Open in Files') : info.get_display_name(),
            y_align: Clutter.ActorAlign.CENTER,
        });
        const icon = new St.Icon({
            style_class: isFolderAction
                ? 'maclike-stack-open-icon'
                : 'maclike-stack-file-icon',
            gicon: isFolderAction ? openIcon : iconForFile(file, info),
            icon_size: isFolderAction ? 44 : 48,
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(label);
        box.add_child(icon);
        this.set_child(box);

        this.connect('clicked', activate);
    }
});

const GridTile = GObject.registerClass(
class GridTile extends St.Button {
    _init({file, info, isFolderAction = false, openIcon, activate}) {
        super._init({
            style_class: 'maclike-stack-grid-tile',
            reactive: true,
            can_focus: true,
            track_hover: true,
            width: 118,
            height: 104,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
        });
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const icon = new St.Icon({
            style_class: isFolderAction
                ? 'maclike-stack-grid-open-icon'
                : 'maclike-stack-grid-file-icon',
            gicon: isFolderAction ? openIcon : iconForFile(file, info),
            icon_size: 62,
            x_align: Clutter.ActorAlign.CENTER,
        });
        const label = new St.Label({
            style_class: 'maclike-stack-grid-label',
            text: isFolderAction ? _('Open in Files') : info.get_display_name(),
            width: 108,
            x_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        label.clutter_text.single_line_mode = true;
        label.clutter_text.line_alignment = Pango.Alignment.CENTER;
        box.add_child(icon);
        box.add_child(label);
        this.set_child(box);
        this.connect('clicked', activate);
        this.connect('notify::hover', () => {
            this.ease({
                scale_x: this.hover ? 1.055 : 1,
                scale_y: this.hover ? 1.055 : 1,
                duration: 100,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        });
    }
});

export class StackPopup {
    constructor({
        file,
        anchorActor,
        maxItems,
        sortMode,
        viewMode,
        gridColumns,
        openIcon,
        logger,
        onDestroy = null,
    }) {
        this._file = file;
        this._anchorActor = anchorActor;
        this._maxItems = maxItems;
        this._sortMode = sortMode;
        this._viewMode = viewMode;
        this._gridColumns = gridColumns;
        this._openIcon = openIcon;
        this._logger = logger;
        this._onDestroy = onDestroy;
        this._animatedActors = [];
        this._closing = false;
    }

    open() {
        if (this._overlay)
            return;

        this._overlay = new St.Widget({
            name: 'maclike-stack-overlay',
            reactive: false,
            layout_manager: new Clutter.FixedLayout(),
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height,
        });
        this._backdrop = new St.Widget({
            style_class: 'maclike-stack-backdrop',
            reactive: true,
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height,
        });
        this._backdrop.connect('button-press-event', () => {
            this.close();
            return Clutter.EVENT_STOP;
        });
        this._overlay.add_child(this._backdrop);
        Main.layoutManager.addTopChrome(this._overlay);

        try {
            const entries = this._readEntries();
            if (this._viewMode === 'grid')
                this._buildGrid(entries);
            else
                this._buildFan(entries);
        } catch (error) {
            this._logger.error(
                `${_('Unable to read this folder')}: ` +
                `${this._file.get_path()}: ${error}`);
            this._buildError();
        }
    }

    _readEntries() {
        const enumerator = this._file.enumerate_children(
            FILE_ATTRIBUTES,
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null);
        const entries = [];
        try {
            while (entries.length < 256) {
                const info = enumerator.next_file(null);
                if (!info)
                    break;
                if (!info.get_is_hidden()) {
                    entries.push({
                        info,
                        file: enumerator.get_child(info),
                    });
                }
            }
        } finally {
            enumerator.close(null);
        }

        entries.sort((a, b) => {
            if (this._sortMode === 'name')
                return a.info.get_display_name().localeCompare(b.info.get_display_name());
            const aTime = a.info.get_modification_date_time()?.to_unix() ?? 0;
            const bTime = b.info.get_modification_date_time()?.to_unix() ?? 0;
            return bTime - aTime;
        });
        return entries.slice(0, this._maxItems);
    }

    _actions(entries) {
        return [
            ...entries.map(entry => ({
                ...entry,
                activate: () => this._launch(entry.file),
            })),
            {
                file: this._file,
                info: null,
                isFolderAction: true,
                openIcon: this._openIcon,
                activate: () => this._launch(this._file),
            },
        ];
    }

    _buildFan(entries) {
        const [anchorX, anchorY] = this._anchorActor.get_transformed_position();
        const [anchorWidth] = this._anchorActor.get_transformed_size();
        const anchorCenter = anchorX + anchorWidth / 2;
        const screenWidth = global.stage.width;
        const fanToLeft = anchorCenter > screenWidth / 2;

        this._actions(entries).forEach((entry, index) => {
            const row = new FanRow(entry);
            this._overlay.add_child(row);
            this._animatedActors.push(row);

            const [, naturalWidth] = row.get_preferred_width(-1);
            const distance = index + 1;
            const curve = Math.min(90, 9 * Math.pow(distance, 1.36));
            const iconCenterOffset = naturalWidth - 27;
            let x = anchorCenter - iconCenterOffset;
            x += fanToLeft ? -curve : curve;
            x = Math.clamp(x, 12, screenWidth - naturalWidth - 12);
            const y = Math.max(18, anchorY - distance * 59 - 10);
            row.set_position(Math.round(x), Math.round(y));
            row.set_size(naturalWidth, 57);

            row.opacity = 0;
            row.scale_x = 0.55;
            row.scale_y = 0.55;
            row.translation_x = Math.round(anchorCenter - (x + iconCenterOffset));
            row.translation_y = Math.round(anchorY - y);
            row.ease({
                opacity: 255,
                scale_x: 1,
                scale_y: 1,
                translation_x: 0,
                translation_y: 0,
                delay: index * 22,
                duration: 230,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        });
    }

    _buildGrid(entries) {
        const [anchorX, anchorY] = this._anchorActor.get_transformed_position();
        const [anchorWidth] = this._anchorActor.get_transformed_size();
        const anchorCenter = anchorX + anchorWidth / 2;
        const panel = new St.Widget({
            style_class: 'maclike-stack-grid-panel',
            layout_manager: new Clutter.BinLayout(),
            pivot_point: new Graphene.Point({x: 0.5, y: 1}),
        });
        const blurSurface = new St.Widget({
            name: 'maclike-stack-grid-blur-surface',
            style_class: 'maclike-stack-grid-blur-surface',
            reactive: false,
            x_expand: true,
            y_expand: true,
        });
        const content = new St.BoxLayout({
            style_class: 'maclike-stack-grid-content',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        panel.add_child(blurSurface);
        panel.add_child(content);
        const title = new St.Label({
            style_class: 'maclike-stack-grid-title',
            text: this._file.get_basename(),
            x_align: Clutter.ActorAlign.CENTER,
        });
        content.add_child(title);

        const layout = new Clutter.GridLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            column_homogeneous: true,
            row_homogeneous: true,
        });
        layout.column_spacing = 8;
        layout.row_spacing = 8;
        const grid = new St.Widget({layout_manager: layout});
        const columns = Math.clamp(this._gridColumns, 3, 6);
        this._actions(entries).forEach((entry, index) => {
            const tile = new GridTile(entry);
            layout.attach(tile, index % columns, Math.floor(index / columns), 1, 1);
        });
        content.add_child(grid);
        this._overlay.add_child(panel);
        this._animatedActors.push(panel);
        this._attachGridBlur(blurSurface);

        const [, naturalWidth] = panel.get_preferred_width(-1);
        const [, naturalHeight] = panel.get_preferred_height(naturalWidth);
        const x = Math.clamp(anchorCenter - naturalWidth / 2,
            14, global.stage.width - naturalWidth - 14);
        const y = Math.max(16, anchorY - naturalHeight - 18);
        panel.set_position(Math.round(x), Math.round(y));
        panel.set_size(naturalWidth, naturalHeight);
        panel.opacity = 0;
        panel.scale_x = 0.74;
        panel.scale_y = 0.74;
        panel.translation_x = Math.round(anchorCenter - (x + naturalWidth / 2));
        panel.translation_y = Math.round(anchorY - (y + naturalHeight));
        panel.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            translation_x: 0,
            translation_y: 0,
            duration: 235,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    _attachGridBlur(surface) {
        this._gridBlurSurface = surface;
        this._gridBlurSignals = [];
        this._gridBlurStatus = 'initializing';
        try {
            const bms = global.blur_my_shell;
            const dashSettings = bms?._settings?.dash_to_dock;
            const effectsManager = bms?._effects_manager;
            if (!dashSettings) {
                this._gridBlurStatus = 'dash-settings-unavailable';
                return;
            }
            if (!effectsManager) {
                this._gridBlurStatus = 'effects-manager-unavailable';
                return;
            }

            const radius = this._getBmsGridRadius(dashSettings, bms);
            const effect = effectsManager.new_native_dynamic_gaussian_blur_effect({
                unscaled_radius: 2 * dashSettings.SIGMA,
                brightness: dashSettings.BRIGHTNESS,
                corner_radius: radius,
            });
            const cornerEffect = effectsManager.new_corner_effect({
                radius,
                corners_top: true,
                corners_bottom: true,
            });
            surface.set_style(`border-radius: ${radius}px;`);
            surface.add_effect(cornerEffect);
            surface.add_effect(effect);
            effect.unscaled_corner_radius = radius;
            this._gridBlurEffect = effect;
            this._gridCornerEffect = cornerEffect;
            this._gridBlurEffectsManager = effectsManager;
            this._gridBlurStatus = 'attached';

            const settings = dashSettings.settings;
            if (settings) {
                this._gridBlurSignals.push([
                    settings,
                    settings.connect('changed::sigma', () => {
                        if (this._gridBlurEffect)
                            this._gridBlurEffect.unscaled_radius =
                                2 * dashSettings.SIGMA;
                    }),
                ]);
                this._gridBlurSignals.push([
                    settings,
                    settings.connect('changed::brightness', () => {
                        if (this._gridBlurEffect)
                            this._gridBlurEffect.brightness =
                                dashSettings.BRIGHTNESS;
                    }),
                ]);
                this._gridBlurSignals.push([
                    settings,
                    settings.connect('changed::corner-radius', () => {
                        if (!this._gridBlurEffect)
                            return;
                        const updatedRadius = this._getBmsGridRadius(
                            dashSettings, bms);
                        this._gridBlurEffect.unscaled_corner_radius =
                            updatedRadius;
                        if (this._gridCornerEffect)
                            this._gridCornerEffect.radius = updatedRadius;
                        this._gridBlurSurface?.set_style(
                            `border-radius: ${updatedRadius}px;`);
                    }),
                ]);
            }
        } catch (error) {
            this._gridBlurStatus = `error: ${error}`;
            this._logger.warn(
                `${_('Unable to apply Blur My Shell to the grid')}: ` +
                `${error}`);
            this._detachGridBlur();
        }
    }

    _getBmsGridRadius(dashSettings, bms) {
        if (!dashSettings.STATIC_BLUR)
            return dashSettings.CORNER_RADIUS ?? 20;
        const pipeline = bms?._pipelines_manager?.pipelines?.[
            dashSettings.PIPELINE];
        for (const effect of pipeline?.effects ?? []) {
            if (effect.type === 'corner' && effect.params?.radius)
                return effect.params.radius;
        }
        return dashSettings.CORNER_RADIUS ?? 20;
    }

    _detachGridBlur() {
        for (const [object, id] of this._gridBlurSignals ?? []) {
            try {
                object.disconnect(id);
            } catch {
                // Blur My Shell may have been disabled before the popup closed.
            }
        }
        this._gridBlurSignals = [];
        if (this._gridCornerEffect) {
            try {
                this._gridBlurEffectsManager?.remove(this._gridCornerEffect);
            } catch {
                this._gridBlurSurface?.remove_effect(this._gridCornerEffect);
            }
        }
        if (this._gridBlurEffect) {
            try {
                this._gridBlurEffectsManager?.remove(this._gridBlurEffect);
            } catch {
                this._gridBlurSurface?.remove_effect(this._gridBlurEffect);
            }
        }
        this._gridCornerEffect = null;
        this._gridBlurEffect = null;
        this._gridBlurEffectsManager = null;
        this._gridBlurSurface = null;
    }

    _buildError() {
        const label = new St.Label({
            style_class: 'maclike-stack-label',
            text: _('Unable to read this folder'),
        });
        this._overlay.add_child(label);
        this._animatedActors.push(label);
        const [x, y] = this._anchorActor.get_transformed_position();
        label.set_position(Math.max(12, x - 160), Math.max(12, y - 64));
    }

    _launch(file) {
        Gio.AppInfo.launch_default_for_uri(file.get_uri(), null);
        this.close();
    }

    close() {
        if (!this._overlay || this._closing)
            return;
        this._closing = true;
        if (this._animatedActors.length === 0) {
            this.destroy();
            return;
        }

        this._animatedActors.forEach((actor, index) => {
            actor.ease({
                opacity: 0,
                scale_x: 0.78,
                scale_y: 0.78,
                duration: 135,
                delay: Math.min(index, 4) * 10,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: index === this._animatedActors.length - 1
                    ? () => this.destroy()
                    : null,
            });
        });
    }

    destroy() {
        const onDestroy = this._onDestroy;
        this._onDestroy = null;
        this._detachGridBlur();
        this._overlay?.destroy();
        this._overlay = null;
        this._backdrop = null;
        this._animatedActors = [];
        this._closing = false;
        onDestroy?.();
    }
}
