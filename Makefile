# The release assets come from scripts/build.sh; this is the local shorthand.
.PHONY: test build install clean
test:
	node scripts/check-opacity.mjs
	node scripts/smoke.mjs
	python3 tests/static-check.py

build: test
	scripts/build.sh dist

install: build
	gnome-extensions install --force dist/transparent-top-bar.shell-extension.zip

clean:
	rm -rf build/ dist/ src/stylesheet.css src/stylesheet.css.map src/schemas/gschemas.compiled
