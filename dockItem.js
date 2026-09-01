import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {AppMenu} from 'resource:///org/gnome/shell/ui/appMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

export const DockItem = GObject.registerClass(
class DockItem extends St.Button {
    _init({label, icon, iconSize, renderSize, slotSize, activate,
            menuChanged = null, onActivated = null}) {
        super._init({
            style_class: 'maclike-dock-item',
            reactive: true,
            can_focus: true,
            track_hover: true,
            width: slotSize,
            height: iconSize + 12,
            accessible_name: label,
        });

        this.baseSlotSize = slotSize;
        this.labelText = label;
        this.currentScale = 1;
        this.targetScale = 1;
        this._iconSize = iconSize;
        this._renderSize = renderSize;
        this._activate = activate;
        this._menuChanged = menuChanged;
        this._onActivated = onActivated;

        this._root = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            width: slotSize,
            height: iconSize + 12,
        });
        this._iconActor = icon;
        this._iconActor.opacity = 255;
        if ('icon_size' in icon)
            icon.icon_size = renderSize;
        icon.set_size(renderSize, renderSize);
        icon.set_pivot_point(0.5, 1);
        icon.set_position(
            Math.round((slotSize - renderSize) / 2),
            iconSize - renderSize);
        this._root.add_child(icon);
        this.set_child(this._root);
        this.applyMagnification(1, 0);

        this.connect('clicked', (_actor, button) => {
            this._onActivated?.();
            this._activate?.(button);
        });
    }

    applyMagnification(scale, translationX) {
        if (!Number.isFinite(scale) || scale <= 0)
            scale = 1;
        if (!Number.isFinite(translationX))
            translationX = 0;
        this.currentScale = scale;
        this._iconActor.opacity = 255;
        const renderScale = this._iconSize * scale / this._renderSize;
        if (!Number.isFinite(renderScale) || renderScale <= 0)
            this._iconActor.set_scale(1, 1);
        else
            this._iconActor.set_scale(renderScale, renderScale);
        this.translation_x = Math.round(translationX);
    }

    visualCenterX() {
        const [x] = this.get_transformed_position();
        const [width] = this.get_transformed_size();
        if (!Number.isFinite(x) || !Number.isFinite(width) || width <= 0)
            return 0;
        return x + width / 2;
    }

    baseCenterX() {
        const translation = Number.isFinite(this.translation_x)
            ? this.translation_x : 0;
        return this.visualCenterX() - translation;
    }

    setMenuOpen(open) {
        this._menuChanged?.(open, this);
    }

    cleanup() {
        this._menuChanged = null;
    }
});

export const AppDockItem = GObject.registerClass(
class AppDockItem extends DockItem {
    _init(app, iconSize, renderSize, slotSize, menuChanged, maxDots,
            onActivated) {
        const icon = app.create_icon_texture(renderSize);
        super._init({
            label: app.get_name(),
            icon,
            iconSize,
            renderSize,
            slotSize,
            activate: button => this._activateApp(button),
            menuChanged,
            onActivated: () => onActivated?.(app),
        });

        this._app = app;
        this._windowTracker = Shell.WindowTracker.get_default();
        this._maxIndicators = Math.max(1, maxDots ?? 1);
        // Indicators do not inherit the icon scale, which keeps them crisp and
        // prevents them from moving into the centre of a magnified icon.
        this._indicators = new St.BoxLayout({
            style_class: 'maclike-dock-running-indicators',
            orientation: Clutter.Orientation.HORIZONTAL,
            height: 5,
        });
        this._root.add_child(this._indicators);
        this._stateSignal = app.connect('notify::state', () => this._syncState());
        this._windowsSignal = app.connect('windows-changed', () => this._syncState());
        this._syncState();

        this._menu = null;
        this._menuManager = new PopupMenu.PopupMenuManager(this);
        this.connect('popup-menu', () => this.popupMenu());

        const rightClick = new Clutter.ClickGesture({
            required_button: Clutter.BUTTON_SECONDARY,
            recognize_on_press: true,
        });
        rightClick.connect('recognize', () => this.popupMenu());
        this.add_action(rightClick);

        const longPress = new Clutter.LongPressGesture();
        longPress.connect('recognize', () => this.popupMenu());
        this.add_action(longPress);
    }

    _activateApp(button) {
        if (button === Clutter.BUTTON_MIDDLE) {
            if (this._app.can_open_new_window())
                this._app.open_new_window(-1);
            else
                this._app.activate();
            return;
        }

        const windows = this._getMinimizableWindows();
        if (this._windowTracker.focus_app === this._app && windows.length > 0) {
            // A second click on the focused app acts on its window group as a
            // single Dock unit. Transient dialogs follow their parent window.
            for (const window of windows)
                window.minimize();
            return;
        }

        this._app.activate();
    }

    _getMinimizableWindows() {
        return this._app.get_windows().filter(window =>
            !window.skip_taskbar &&
            !window.minimized &&
            window.showing_on_its_workspace());
    }

    _syncState() {
        const running = this._app.get_state() !== Shell.AppState.STOPPED;
        const windows = running
            ? this._app.get_windows().filter(window => !window.skip_taskbar)
            : [];
        this._renderIndicators(running ? Math.max(1, windows.length) : 0);

        // Shell.App may briefly refresh the texture while transitioning from
        // STARTING to RUNNING. Never let that state change hide the dock icon.
        this._iconActor.visible = true;
        this._iconActor.opacity = 255;
        if (this._forceQuitItem)
            this._forceQuitItem.visible = running;
    }

    _renderIndicators(instanceCount) {
        this._indicators.destroy_all_children();
        const visibleCount = Math.min(instanceCount, this._maxIndicators);
        const overflow = instanceCount > this._maxIndicators;
        for (let index = 0; index < visibleCount; index++) {
            const isOverflow = overflow && index === visibleCount - 1;
            const dot = new St.Widget({
                style_class: 'maclike-dock-running-dot',
                width: isOverflow ? 7 : 3,
                height: 3,
            });
            if (isOverflow)
                dot.add_style_class_name('maclike-dock-running-dot-overflow');
            this._indicators.add_child(dot);
        }
        const width = visibleCount > 0
            ? visibleCount * 3 + (visibleCount - 1) * 3 + (overflow ? 4 : 0)
            : 0;
        this._indicators.set_size(width, 4);
        this._indicators.set_position(
            Math.round((this.baseSlotSize - width) / 2), this._iconSize + 5);
        this._indicators.visible = visibleCount > 0;
        this._indicatorCount = instanceCount;
    }

    popupMenu() {
        if (!this._menu) {
            this._menu = new AppMenu(this, St.Side.BOTTOM, {
                favoritesSection: true,
                showSingleWindows: true,
            });
            this._menu.setApp(this._app);
            this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._forceQuitItem = this._menu.addAction(_('Force Quit'), () => {
                for (const window of this._app.get_windows())
                    window.kill();
            });
            this._forceQuitItem.add_style_class_name('maclike-force-quit-item');
            this._menu.connect('open-state-changed', (_menu, open) => {
                this.setMenuOpen(open);
            });
            Main.uiGroup.add_child(this._menu.actor);
            this._menuManager.addMenu(this._menu);
            this._syncState();
        }

        this.setMenuOpen(true);
        this._menu.open();
        return Clutter.EVENT_STOP;
    }

    cleanup() {
        if (this._stateSignal) {
            this._app.disconnect(this._stateSignal);
            this._stateSignal = 0;
        }
        if (this._windowsSignal) {
            this._app.disconnect(this._windowsSignal);
            this._windowsSignal = 0;
        }
        this._menu?.destroy();
        this._menu = null;
        this._menuManager = null;
        super.cleanup();
    }
});

export const FolderDockItem = GObject.registerClass(
class FolderDockItem extends DockItem {
    _init({file, label, iconSize, renderSize, slotSize, activate,
            iconStyle = 'folder'}) {
        const icon = iconStyle === 'stack'
            ? this._createRecentFilesStack(file, renderSize)
            : new St.Icon({gicon: file.query_info(
                'standard::icon', Gio.FileQueryInfoFlags.NONE, null).get_icon()});
        super._init({label, icon, iconSize, renderSize, slotSize, activate});
        this.add_style_class_name('maclike-dock-folder-item');
        this._folderIconStyle = iconStyle;
    }

    _createRecentFilesStack(file, size) {
        const files = [];
        const enumerator = file.enumerate_children(
            'standard::icon,standard::name,standard::content-type,' +
            'time::modified,thumbnail::path,thumbnail::is-valid',
            Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = enumerator.next_file(null)))
            files.push({info, file: enumerator.get_child(info)});
        enumerator.close(null);
        files.sort((a, b) =>
            (b.info.get_modification_date_time()?.to_unix() ?? 0) -
            (a.info.get_modification_date_time()?.to_unix() ?? 0));

        const stack = new St.Widget({
            style_class: 'maclike-folder-card-stack',
            layout_manager: new Clutter.FixedLayout(),
            width: size,
            height: size,
        });
        const cardWidth = Math.round(size * 0.86);
        const cardHeight = Math.round(size * 0.98);
        const layouts = [
            [0.04, 0.015], [0.08, 0.012],
            [0.10, 0.008], [0.07, 0.0],
        ];
        const previews = files.slice(0, 4).reverse();
        for (let index = 0; index < previews.length; index++) {
            const [x, y] = layouts[index];
            const entry = previews[index];
            const thumbnailPath = entry.info.get_attribute_boolean(
                'thumbnail::is-valid')
                ? entry.info.get_attribute_byte_string('thumbnail::path')
                : null;
            const contentType = entry.info.get_content_type() ?? '';
            const thumbnailFile = thumbnailPath
                ? Gio.File.new_for_path(thumbnailPath) : null;
            const previewIcon = thumbnailFile?.query_exists(null)
                ? new Gio.FileIcon({file: thumbnailFile})
                : contentType.startsWith('image/')
                    ? new Gio.FileIcon({file: entry.file})
                    : entry.info.get_icon();
            const card = new St.Bin({
                style_class: 'maclike-folder-card',
                child: new St.Icon({
                    gicon: previewIcon,
                    icon_size: cardWidth - 4,
                    opacity: 255,
                }),
                width: cardWidth,
                height: cardHeight,
            });
            card.set_pivot_point(0.5, 0.8);
            card.rotation_angle_z = 0;
            card.opacity = 255;
            card.set_position(Math.round(size * x),
                Math.round(size * y));
            stack.add_child(card);
        }
        if (files.length === 0) {
            const fallback = new St.Icon({icon_name: 'folder-symbolic', icon_size: size});
            stack.add_child(fallback);
        }
        return stack;
    }
});
