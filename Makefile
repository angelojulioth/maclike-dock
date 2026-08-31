UUID = maclike-dock@angelojulioth.github.com
ZIP = $(UUID).zip
RUNTIME = metadata.json extension.js dock.js dockItem.js stackFan.js \
	nativeBlur.js stylesheet.css icons schemas locale LICENSE

.PHONY: all schemas translations package clean

all: package

schemas:
	glib-compile-schemas schemas

translations:
	mkdir -p locale/es/LC_MESSAGES
	msgfmt po/es.po -o locale/es/LC_MESSAGES/maclike-dock.mo

package: schemas translations
	rm -f $(ZIP)
	zip -qr $(ZIP) $(RUNTIME)

clean:
	rm -f schemas/gschemas.compiled locale/es/LC_MESSAGES/maclike-dock.mo $(ZIP)
