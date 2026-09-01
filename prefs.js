import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function addSwitch(group, settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
}

function addSpin(group, settings, key, title, subtitle, lower, upper, step, digits = 0) {
    const adjustment = new Gtk.Adjustment({
        lower,
        upper,
        step_increment: step,
        page_increment: step * 5,
        value: settings.get_value(key).deep_unpack(),
    });
    settings.bind(key, adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment,
        digits,
        numeric: true,
    });
    group.add(row);
}

export default class MaclikeDockPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_title(_('Maclike Dock'));
        window.set_default_size(640, 680);

        const page = new Adw.PreferencesPage({
            title: _('Dock'),
            icon_name: 'view-app-grid-symbolic',
        });
        window.add(page);

        const appearance = new Adw.PreferencesGroup({
            title: _('Magnification'),
            description: _('Scale falls off smoothly with the distance between each icon and the pointer.'),
        });
        page.add(appearance);
        addSpin(appearance, settings, 'icon-size',
            _('Base size'), _('Icon size when the pointer is away.'),
            32, 80, 2);
        addSpin(appearance, settings, 'magnification',
            _('Maximum magnification'), _('1.0 is the normal icon size.'),
            1.1, 2.5, 0.05, 2);
        addSpin(appearance, settings, 'magnification-radius',
            _('Influence range'), _('How many neighboring icons take part in the wave.'),
            1, 4, 0.1, 1);
        addSpin(appearance, settings, 'animation-duration',
            _('Animation response'), _('Lower values react faster; higher values feel softer.'),
            0, 250, 5);
        addSwitch(appearance, settings, 'show-running-apps',
            _('Show running applications'),
            _('Add open applications that are not favorites yet.'));
        addSwitch(appearance, settings, 'border-enabled',
            _('Container border'),
            _('Draw a subtle frame around the Dock, matched to the blur radius.'));
        addSpin(appearance, settings, 'indicator-max-dots',
            _('Indicators per application'), _('Dots below the icon represent open windows; this limit prevents clutter.'),
            1, 5, 1);
        addSwitch(appearance, settings, 'use-accent-color-indicators',
            _('Use system accent for indicators'),
            _('Color active application indicators with the GNOME accent color.'));
        addSwitch(appearance, settings, 'hide-in-overview',
            _('Hide this Dock in Activities'),
            _('Hide Maclike Dock while the overview is open.'));
        addSwitch(appearance, settings, 'hide-overview-dash',
            _('Hide the original Dash'),
            _('Prevent the GNOME Dash from appearing in Activities.'));

        const visibility = new Adw.PreferencesGroup({
            title: _('Visibility'),
            description: _('Touch the bottom edge to reveal the Dock while it is hidden.'),
        });
        page.add(visibility);
        const visibilityModel = Gtk.StringList.new([
            _('Always visible'),
            _('Auto-hide'),
            _('Dodge overlapping windows'),
        ]);
        const visibilityValues = ['always', 'autohide', 'dodge'];
        const visibilityRow = new Adw.ComboRow({
            title: _('Visibility mode'),
            subtitle: _('Dodge mode hides the Dock whenever a window enters its area.'),
            model: visibilityModel,
            selected: Math.max(0,
                visibilityValues.indexOf(settings.get_string('visibility-mode'))),
        });
        visibilityRow.connect('notify::selected', () =>
            settings.set_string('visibility-mode',
                visibilityValues[visibilityRow.selected] ?? 'always'));
        settings.connect('changed::visibility-mode', () => {
            visibilityRow.selected = Math.max(0,
                visibilityValues.indexOf(settings.get_string('visibility-mode')));
        });
        visibility.add(visibilityRow);
        addSwitch(visibility, settings, 'reserve-space-for-maximized',
            _('Reserve space for maximized windows'),
            _('Maximized windows stop above the Dock and the Dock remains visible.'));
        addSpin(visibility, settings, 'hide-delay',
            _('Hide delay'), _('Milliseconds before hiding starts.'),
            0, 2000, 20);
        addSpin(visibility, settings, 'show-delay',
            _('Show delay'), _('Milliseconds after touching the bottom edge.'),
            0, 1000, 20);
        addSpin(visibility, settings, 'hide-animation-duration',
            _('Transition duration'), _('Duration of the Dock entrance and exit.'),
            80, 500, 10);

        const integration = new Adw.PreferencesGroup({
            title: _('Blur'),
            description: _('The native engine captures the area behind the Dock and requires no other extension.'),
        });
        page.add(integration);
        const blurModel = Gtk.StringList.new([
            _('Maclike Dock native'),
            'Blur My Shell',
            _('No blur'),
        ]);
        const blurValues = ['native', 'bms', 'off'];
        const blurRow = new Adw.ComboRow({
            title: _('Blur engine'),
            subtitle: _('Blur My Shell uses its Dash to Dock surface; the native mode is self-contained.'),
            model: blurModel,
            selected: Math.max(0, blurValues.indexOf(settings.get_string('blur-engine'))),
        });
        blurRow.connect('notify::selected', () => settings.set_string(
            'blur-engine', blurValues[blurRow.selected] ?? 'native'));
        settings.connect('changed::blur-engine', () => {
            blurRow.selected = Math.max(0,
                blurValues.indexOf(settings.get_string('blur-engine')));
        });
        integration.add(blurRow);
        const tintModel = Gtk.StringList.new([
            _('Automatic (follow GNOME)'),
            _('Light'),
            _('Dark'),
        ]);
        const tintValues = ['auto', 'light', 'dark'];
        const tintRow = new Adw.ComboRow({
            title: _('Glass tint'),
            subtitle: _('Automatic follows the current GNOME light or dark appearance.'),
            model: tintModel,
            selected: Math.max(0,
                tintValues.indexOf(settings.get_string('tint-mode'))),
        });
        tintRow.connect('notify::selected', () => settings.set_string(
            'tint-mode', tintValues[tintRow.selected] ?? 'auto'));
        settings.connect('changed::tint-mode', () => {
            tintRow.selected = Math.max(0,
                tintValues.indexOf(settings.get_string('tint-mode')));
        });
        integration.add(tintRow);
        addSpin(integration, settings, 'blur-sigma',
            _('Native intensity'), _('Blur radius used by the built-in engine.'),
            5, 80, 1);
        addSpin(integration, settings, 'blur-brightness',
            _('Native brightness'), _('Brightness multiplier for the captured background.'),
            0.2, 1, 0.02, 2);

        const stacks = new Adw.PreferencesGroup({
            title: _('Folder stacks'),
            description: _('Click a folder to open its contents as a macOS-style fan or grid.'),
        });
        page.add(stacks);
        const iconModel = Gtk.StringList.new([
            _('Folder icon'),
            _('Recent file previews'),
        ]);
        const iconRow = new Adw.ComboRow({
            title: _('Dock icon'),
            subtitle: _('The card stack previews the most recently modified files.'),
            model: iconModel,
            selected: settings.get_string('folder-icon-style') === 'stack' ? 1 : 0,
        });
        iconRow.connect('notify::selected', () => settings.set_string(
            'folder-icon-style', iconRow.selected === 1 ? 'stack' : 'folder'));
        settings.connect('changed::folder-icon-style', () => {
            iconRow.selected = settings.get_string('folder-icon-style') === 'stack' ? 1 : 0;
        });
        stacks.add(iconRow);
        addSpin(stacks, settings, 'folder-card-count',
            _('Preview cards'),
            _('Number of recent files shown in the Dock stack.'),
            2, 10, 1);
        addSpin(stacks, settings, 'folder-card-spread',
            _('Card spread'),
            _('Maximum upward separation as a percentage of the icon size.'),
            15, 60, 1);
        const viewModel = Gtk.StringList.new([_('Fan'), _('Grid')]);
        const viewRow = new Adw.ComboRow({
            title: _('Presentation'),
            subtitle: _('Choose between a macOS-inspired fan and a compact grid.'),
            model: viewModel,
            selected: settings.get_string('stack-view') === 'grid' ? 1 : 0,
        });
        viewRow.connect('notify::selected', () =>
            settings.set_string('stack-view', viewRow.selected === 1 ? 'grid' : 'fan'));
        settings.connect('changed::stack-view', () => {
            viewRow.selected = settings.get_string('stack-view') === 'grid' ? 1 : 0;
        });
        stacks.add(viewRow);
        addSpin(stacks, settings, 'grid-columns',
            _('Grid columns'), _('Used only by the grid presentation.'),
            3, 6, 1);
        addSpin(stacks, settings, 'stack-max-items',
            _('Visible items'), _('Remaining items stay available through “Open in Files”.'),
            4, 20, 1);

        const sortModel = Gtk.StringList.new([
            _('Most recent first'),
            _('Alphabetical name'),
        ]);
        const sortRow = new Adw.ComboRow({
            title: _('Stack order'),
            model: sortModel,
            selected: settings.get_string('stack-sort') === 'name' ? 1 : 0,
        });
        sortRow.connect('notify::selected', () => {
            settings.set_string('stack-sort', sortRow.selected === 1 ? 'name' : 'modified');
        });
        settings.connect('changed::stack-sort', () => {
            sortRow.selected = settings.get_string('stack-sort') === 'name' ? 1 : 0;
        });
        stacks.add(sortRow);

        const folders = new Adw.PreferencesGroup({
            title: _('Dock folders'),
            description: _('Downloads is included by default. You can add any local folder.'),
        });
        page.add(folders);

        const controls = new Adw.ActionRow({
            title: _('Manage folders'),
            subtitle: _('The order of this list matches the order in the Dock.'),
        });
        const addButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Add folder'),
        });
        controls.add_suffix(addButton);
        folders.add(controls);

        let folderRows = [];
        const rebuildFolders = () => {
            for (const row of folderRows)
                folders.remove(row);
            folderRows = [];

            const downloads = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) ??
                GLib.build_filenamev([GLib.get_home_dir(), 'Downloads']);
            for (const storedPath of settings.get_strv('folder-paths')) {
                const path = storedPath === 'special://downloads' ? downloads : storedPath;
                const row = new Adw.ActionRow({
                    title: GLib.basename(path),
                    subtitle: path,
                });
                const remove = new Gtk.Button({
                    icon_name: 'list-remove-symbolic',
                    valign: Gtk.Align.CENTER,
                    tooltip_text: _('Remove from Dock'),
                });
                remove.add_css_class('flat');
                remove.connect('clicked', () => {
                    settings.set_strv('folder-paths',
                        settings.get_strv('folder-paths').filter(value => value !== storedPath));
                });
                row.add_suffix(remove);
                folders.add(row);
                folderRows.push(row);
            }
        };
        settings.connect('changed::folder-paths', rebuildFolders);
        rebuildFolders();

        addButton.connect('clicked', () => {
            const chooser = new Gtk.FileChooserNative({
                title: _('Select a folder for the Dock'),
                action: Gtk.FileChooserAction.SELECT_FOLDER,
                transient_for: window,
                modal: true,
                accept_label: _('Add'),
                cancel_label: _('Cancel'),
            });
            chooser.connect('response', (dialog, response) => {
                if (response === Gtk.ResponseType.ACCEPT) {
                    const path = dialog.get_file()?.get_path();
                    const current = settings.get_strv('folder-paths');
                    if (path && !current.includes(path))
                        settings.set_strv('folder-paths', [...current, path]);
                }
                chooser.destroy();
            });
            chooser.show();
        });
    }
}
