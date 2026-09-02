# Maclike Dock

Maclike Dock is a GNOME Shell 50 extension built around the parts of the macOS
Dock that are genuinely useful on a desktop: fluid magnification, readable
running indicators, folder stacks and a compact glass background.

It is a standalone dock. It does not patch Dash to Dock or replace application
icons with macOS artwork.

## Highlights

- Distance-based magnification with high-resolution icon rendering
- Automatic light and dark glass styles
- Automatic or explicitly light/dark glass tint
- Native dynamic blur, optional Blur My Shell integration, or no blur
- Fan and grid views for local folders
- Optional four-file thumbnail stack for folder icons
- One running indicator per window, with a configurable visual limit
- Optional GNOME accent color for running indicators
- Native GNOME application menus plus a Force Quit action
- Auto-hide and dodge-windows modes with edge reveal
- Optional reserved space for maximized windows
- English interface with a bundled Spanish translation

The default motion profile uses 58 px icons, a maximum scale of 1.72, a 3.25
icon influence range and a 105 ms response. These values can all be changed in
the preferences window.

## Requirements

- GNOME Shell 50
- Wayland
- Blur My Shell 72 or newer only when the Blur My Shell engine is selected

Other permanent dock extensions should be disabled to avoid duplicate struts,
edge triggers and overview behavior.

### Rounded blur library on Fedora 44

These are the commands used to install `gnome-rounded-blur` for Blur My Shell:

```bash
sudo dnf install -y mutter-devel gobject-introspection-devel
git clone https://github.com/kancko/gnome-rounded-blur.git
cd gnome-rounded-blur
env PATH=/usr/bin:/bin meson setup build --prefix=/usr -Dc_link_args='-Wl,-rpath,/usr/lib64/mutter-18'
env PATH=/usr/bin:/bin meson compile -C build
sudo env PATH=/usr/bin:/bin meson install -C build
sudo ldconfig
```

The first command installs the GNOME development headers. The explicit `PATH`
avoids mixing a Nix toolchain with Fedora libraries, `--prefix=/usr` puts the
typelib on GJS's search path, and `ldconfig` refreshes the library cache.
Verify it with:

```bash
gjs -c 'const Blur = imports.gi.Blur; print(Blur.BlurEffect);'
```

## Install from a release

Download `maclike-dock@angelojulioth.github.io.zip`, then run:

```bash
gnome-extensions install --force maclike-dock@angelojulioth.github.io.zip
gnome-extensions enable maclike-dock@angelojulioth.github.io
```

Log out and back in after installing or upgrading. GNOME Shell does not fully
reload extension modules in a Wayland session.

Open the settings window with:

```bash
gnome-extensions prefs maclike-dock@angelojulioth.github.io
```

## Build from source

The build requires `glib-compile-schemas`, `gettext`, `make` and `zip`.

```bash
make
```

The extension archive is written to
`maclike-dock@angelojulioth.github.io.zip`.

## Folder previews

The card-stack icon uses GNOME thumbnails when they already exist. Local image
files can be rendered directly; other files fall back to their MIME-type icon.
Cards are kept axis-aligned to avoid texture aliasing during magnification.
Between two and ten recent previews can be shown. Their hover spread moves only
upward and its distance is configurable. Scrolling cycles through the cards
indefinitely, raising and magnifying the active preview. The stack uses one
shared drop shadow instead of accumulating a shadow on every card. The active
card magnification factor is configurable from 1.00x to 1.50x.
Once scrolling begins, the folder item is painted above every neighbouring Dock
icon and its tooltip stays hidden until the card stack collapses.

## Blur engines

The native engine uses a separate `Shell.BlurMode.BACKGROUND` surface and a
rounded shader mask. Blur My Shell mode uses its managed Dash to Dock surface.
The selected glass tint is painted over either blur engine. Automatic tint
tracks GNOME's current color scheme; light and dark can also be forced.

## Translations

English is the source language. Spanish is included under
`locale/es/LC_MESSAGES`. New translations are welcome through pull requests.

## Contributing

Bug reports should include the GNOME Shell version, display scale, selected
blur engine and relevant output from the user journal. Keep changes focused and
test both light and dark color schemes when touching the stylesheet.

If the extension is useful to you, consider
[starring the project](https://github.com/angelojulioth/maclike-dock) and
[following angelojulioth](https://github.com/angelojulioth).

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
