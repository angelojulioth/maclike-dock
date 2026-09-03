import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
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
            opacity: 255,
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
            opacity: 255,
            width: slotSize,
            height: iconSize + 12,
        });
        this._iconActor = icon;
        this._iconActor.add_style_class_name?.('maclike-dock-icon');
        if ('icon_size' in icon)
            icon.icon_size = renderSize;
        icon.set_size(renderSize, renderSize);
        icon.set_pivot_point(0.5, 1);
        icon.set_position(
            Math.round((slotSize - renderSize) / 2),
            iconSize - renderSize);
        this._root.add_child(icon);
        this.set_child(this._root);
        this._forceFullOpacity();
        this._forceIconTreeOpacity();
        this._opacitySignals = [this, this._root, this._iconActor].map(actor =>
            [actor, actor.connect('notify::opacity', () =>
                this._forceFullOpacity())]);
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
        this._forceFullOpacity();
        const renderScale = this._iconSize * scale / this._renderSize;
        if (!Number.isFinite(renderScale) || renderScale <= 0)
            this._iconActor.set_scale(1, 1);
        else
            this._iconActor.set_scale(renderScale, renderScale);
        this.translation_x = Math.round(translationX);
    }

    _forceFullOpacity() {
        for (const actor of [this, this._root, this._iconActor]) {
            if (actor && actor.opacity !== 255)
                actor.opacity = 255;
        }
    }

    _forceIconTreeOpacity() {
        const visit = actor => {
            if (!actor)
                return;
            if (actor.opacity !== 255)
                actor.opacity = 255;
            for (const child of actor.get_children?.() ?? [])
                visit(child);
        };
        visit(this._iconActor);
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
        for (const [actor, id] of this._opacitySignals ?? []) {
            try {
                actor.disconnect(id);
            } catch {
                // A composed icon may already have disposed a child actor.
            }
        }
        this._opacitySignals = [];
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
            iconStyle = 'folder', cardSpread = 36, cardCount = 4,
            activeCardScale = 1.16, cardScrollStateChanged = null}) {
        const previewCount = Math.clamp(cardCount, 2, 10);
        const icon = iconStyle === 'stack'
            ? this._createRecentFilesStack(file, renderSize, previewCount)
            : new St.Icon({gicon: file.query_info(
                'standard::icon', Gio.FileQueryInfoFlags.NONE, null).get_icon()});
        super._init({label, icon, iconSize, renderSize, slotSize, activate});
        this.add_style_class_name('maclike-dock-folder-item');
        this._folderIconStyle = iconStyle;
        this._cardStack = iconStyle === 'stack' ? icon : null;
        if (this._cardStack)
            this._cardStack.remove_style_class_name('maclike-dock-icon');
        this._cardSpread = Math.clamp(cardSpread, 15, 60) / 100;
        this._cardCount = previewCount;
        this._activeCardScale = Math.clamp(activeCardScale, 1, 1.5);
        this._activeCardIndex = Math.max(0,
            (this._cardStack?._previewCards.length ?? 1) - 1);
        this._smoothScrollAccumulator = 0;
        this._lastCardScrollTime = 0;
        this._cardsSpread = false;
        this._cardScrollActive = false;
        this._cardScrollStateChanged = cardScrollStateChanged;
        this._cardHoverSignal = this._cardStack
            ? this.connect('notify::hover', () =>
                this._setCardSpread(this.hover))
            : 0;
        this._cardScrollSignal = this._cardStack
            ? this.connect('scroll-event', (_actor, event) =>
                this._onCardScroll(event))
            : 0;
    }

    _createRecentFilesStack(file, size, previewCount) {
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
        const previews = files.slice(0, previewCount).reverse();
        const compactLayout = previews.map((_entry, index) => [
            0.07,
            previews.length > 1
                ? 0.018 * (previews.length - 1 - index) /
                    (previews.length - 1)
                : 0,
        ]);
        const cards = [];
        const shadow = new St.Widget({
            style_class: 'maclike-folder-card-stack-shadow',
            reactive: false,
            width: cardWidth,
            height: cardHeight,
        });
        shadow.set_pivot_point(0.5, 0.8);
        shadow.set_position(Math.round(size * 0.07), 0);
        stack.add_child(shadow);
        for (let index = 0; index < previews.length; index++) {
            const [x, y] = compactLayout[index];
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
            cards.push(card);
        }
        if (files.length === 0) {
            const fallback = new St.Icon({icon_name: 'folder-symbolic', icon_size: size});
            stack.add_child(fallback);
        }
        stack._previewCards = cards;
        stack._compactLayout = compactLayout;
        stack._previewSize = size;
        stack._shadow = shadow;
        return stack;
    }

    _raiseActivePreviewCard() {
        const stack = this._cardStack;
        const card = stack?._previewCards[this._activeCardIndex];
        if (!stack || !card)
            return;
        stack.set_child_above_sibling(card, null);
    }

    _restorePreviewCardOrder() {
        const stack = this._cardStack;
        if (!stack)
            return;
        for (const card of stack._previewCards)
            stack.set_child_above_sibling(card, null);
    }

    _cyclePreviewCard(step) {
        const stack = this._cardStack;
        const count = stack?._previewCards.length ?? 0;
        if (count < 2)
            return;
        this._activeCardIndex =
            (this._activeCardIndex + step % count + count) % count;
        this._applyActivePreviewCard(true);
    }

    _setCardScrollActive(active) {
        active = Boolean(active);
        if (this._cardScrollActive === active)
            return;
        this._cardScrollActive = active;
        this._syncCardDepth();
        this._cardScrollStateChanged?.(active, this);
    }

    _syncCardDepth() {
        // Depth raises the complete folder item without reordering BoxLayout
        // children, so overlapping previews paint correctly without shifting
        // neighbouring icons. Keep the depth delta tiny because Clutter also
        // interprets z-position as 3D distance and applies perspective.
        this.set_z_position(this._cardScrollActive
            ? 0.002
            : this._cardsSpread ? 0.001 : 0);
    }

    _onCardScroll(event) {
        if (!this._cardsSpread ||
                (this._cardStack?._previewCards.length ?? 0) < 2)
            return Clutter.EVENT_PROPAGATE;

        const direction = event.get_scroll_direction();
        let step = 0;
        if (direction === Clutter.ScrollDirection.UP ||
                direction === Clutter.ScrollDirection.RIGHT) {
            step = 1;
        } else if (direction === Clutter.ScrollDirection.DOWN ||
                direction === Clutter.ScrollDirection.LEFT) {
            step = -1;
        } else if (direction === Clutter.ScrollDirection.SMOOTH) {
            this._setCardScrollActive(true);
            const [, deltaY] = event.get_scroll_delta();
            this._smoothScrollAccumulator += deltaY;
            if (Math.abs(this._smoothScrollAccumulator) < 0.35)
                return Clutter.EVENT_STOP;
            step = this._smoothScrollAccumulator > 0 ? -1 : 1;
            this._smoothScrollAccumulator = 0;
        }
        if (step === 0)
            return Clutter.EVENT_PROPAGATE;

        this._setCardScrollActive(true);

        const now = GLib.get_monotonic_time() / 1000;
        if (now - this._lastCardScrollTime < 70)
            return Clutter.EVENT_STOP;
        this._lastCardScrollTime = now;
        this._cyclePreviewCard(step);
        return Clutter.EVENT_STOP;
    }

    _applyActivePreviewCard(animate) {
        const stack = this._cardStack;
        if (!stack)
            return;
        const duration = animate ? 160 : 0;
        for (let index = 0; index < stack._previewCards.length; index++) {
            const active = this._cardsSpread &&
                index === this._activeCardIndex;
            const scale = active ? this._activeCardScale : 1;
            stack._previewCards[index].ease({
                scale_x: scale,
                scale_y: scale,
                duration,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        }
        this._restorePreviewCardOrder();
        if (this._cardsSpread)
            this._raiseActivePreviewCard();

        const activeCard = stack._previewCards[this._activeCardIndex];
        stack._shadow?.ease({
            translation_x: 0,
            translation_y: this._cardsSpread
                ? activeCard?.translation_y ?? 0 : 0,
            scale_x: this._cardsSpread ? this._activeCardScale : 1,
            scale_y: this._cardsSpread ? this._activeCardScale : 1,
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    _setCardSpread(spread) {
        const stack = this._cardStack;
        this._cardsSpread = Boolean(spread &&
            (stack?._previewCards.length ?? 0) > 1);
        if (!this._cardsSpread)
            this._setCardScrollActive(false);
        this._syncCardDepth();
        if (!stack || stack._previewCards.length < 2)
            return;

        spread = this._cardsSpread;

        // These are paint-only transforms. Unlike animating x/y inside a
        // FixedLayout, translations never invalidate the stack's preferred
        // size or the Dock allocation while the cards spread upward.
        const cardCount = stack._previewCards.length;
        const maxLift = stack._previewSize * this._cardSpread;
        const duration = spread ? 200 : 240;
        const mode = spread
            ? Clutter.AnimationMode.EASE_OUT_CUBIC
            : Clutter.AnimationMode.EASE_OUT_QUAD;
        for (let index = 0; index < stack._previewCards.length; index++) {
            const card = stack._previewCards[index];
            const lift = spread && cardCount > 1
                ? maxLift * (cardCount - 1 - index) / (cardCount - 1)
                : 0;
            card.remove_all_transitions();
            card.ease({
                translation_x: 0,
                translation_y: -Math.round(lift),
                scale_x: spread && index === this._activeCardIndex
                    ? this._activeCardScale : 1,
                scale_y: spread && index === this._activeCardIndex
                    ? this._activeCardScale : 1,
                duration,
                mode,
            });
        }
        this._restorePreviewCardOrder();
        if (spread)
            this._raiseActivePreviewCard();
        const activeLift = spread && cardCount > 1
            ? maxLift * (cardCount - 1 - this._activeCardIndex) /
                (cardCount - 1)
            : 0;
        stack._shadow?.ease({
            translation_x: 0,
            translation_y: -Math.round(activeLift),
            scale_x: spread ? this._activeCardScale : 1,
            scale_y: spread ? this._activeCardScale : 1,
            duration,
            mode,
        });
        this._forceFullOpacity();
        this._forceIconTreeOpacity();
    }

    cleanup() {
        if (this._cardHoverSignal) {
            this.disconnect(this._cardHoverSignal);
            this._cardHoverSignal = 0;
        }
        if (this._cardScrollSignal) {
            this.disconnect(this._cardScrollSignal);
            this._cardScrollSignal = 0;
        }
        this._restorePreviewCardOrder();
        this._setCardSpread(false);
        this._cardScrollStateChanged = null;
        super.cleanup();
    }
});
