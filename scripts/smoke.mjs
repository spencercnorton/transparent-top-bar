#!/usr/bin/env node
/**
 * Runs the real extension.js through enable() and disable() against stub GNOME APIs.
 *
 * Wayland gives no live-reload path on this box, so a mistake in enable() costs a whole
 * logout/login cycle to discover and another to fix. This catches the cheap half of that class —
 * typos, missing methods, undefined fields, bad property names — plus the expensive half that
 * review keeps finding by hand: **signals and GLib sources that enable() creates and disable()
 * fails to release.**
 *
 * It stubs, so it proves nothing about real St/Clutter behaviour. It is a smoke test, not a
 * substitute for the relogin.
 *
 * Run: node scripts/smoke.mjs
 */
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- Bookkeeping the assertions are actually about -------------------------------------------
const live = { signals: new Map(), sources: new Set() };
let nextId = 1;

function connectable(name) {
    return {
        connect(signal) {
            const id = nextId++;
            live.signals.set(id, `${name}::${signal}`);
            return id;
        },
        disconnect(id) {
            assert.ok(live.signals.has(id), `${name}: disconnect of unknown//double id ${id}`);
            live.signals.delete(id);
        },
    };
}

// --- Stub modules, generated so this stays one file ------------------------------------------
const STUBS = {
    'GLib.js': `
        export const PRIORITY_DEFAULT = 0, PRIORITY_LOW = 300, SOURCE_REMOVE = false;
        export default {
            PRIORITY_DEFAULT, PRIORITY_LOW, SOURCE_REMOVE,
            timeout_add(prio, ms, fn) { const id = globalThis.__hooks.addSource(); globalThis.__hooks.pending.push([id, fn]); return id; },
            source_remove(id) { globalThis.__hooks.removeSource(id, 'source_remove'); return true; },
            Source: { remove(id) { globalThis.__hooks.removeSource(id, 'Source.remove'); return true; } },
            getenv(name) { return globalThis.__hooks.env[name] ?? null; },
        };`,
    'Gio.js': `
        export default {
            SettingsBindFlags: { DEFAULT: 0, GET: 1, INVERT_BOOLEAN: 8 },
            Settings: class { constructor(p) { Object.assign(this, globalThis.__hooks.settings(p?.schema ?? 'ext')); } },
            Cancellable: class { constructor() { this._c = false; } cancel() { this._c = true; } is_cancelled() { return this._c; } },
            File: { new_for_uri(uri) { return globalThis.__hooks.file(uri); } },
        };`,
    'St.js': `
        export default {
            Settings: { get: () => globalThis.__hooks.stSettings },
            ThemeContext: { get_for_stage: () => ({ scale_factor: 1 }) },
        };`,
    'Meta.js': `
        export default {
            WindowType: { DESKTOP: 'desktop' },
            LaterType: { BEFORE_REDRAW: 'before-redraw' },
            later_add(type, fn) {
                const id = globalThis.__hooks.addSource();
                globalThis.__hooks.pending.push([id, fn]);
                return id;
            },
            later_remove(id) { globalThis.__hooks.removeSource(id, 'Meta.later_remove'); },
        };`,
    'GdkPixbuf.js': `
        export default { Pixbuf: {
            new_from_stream_at_scale_async(s, w, h, keep, cancel, cb) { globalThis.__hooks.pixbufCalls++; cb(null, 'result'); },
            new_from_stream_finish() { return globalThis.__hooks.pixbuf(); },
        } };`,
    'Main.js': `
        export const panel = globalThis.__hooks.panel;
        export const overview = globalThis.__hooks.overview;
        export const sessionMode = globalThis.__hooks.sessionMode;
        export const layoutManager = globalThis.__hooks.layoutManager;`,
    'Extension.js': `
        export class Extension {
            constructor(metadata) { this.metadata = metadata; }
            getSettings(schema) { return globalThis.__hooks.settings(schema); }
        }`,
};

const dir = mkdtempSync(join(tmpdir(), 'ttb-smoke-'));
mkdirSync(join(dir, 'stubs'));
for (const [file, body] of Object.entries(STUBS)) {
    writeFileSync(join(dir, 'stubs', file), body);
}
// Copy the real sources, rewriting only the import specifiers.
for (const file of readdirSync(join(root, 'src')).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(join(root, 'src', file), 'utf8')
        .replace(/from 'gi:\/\/(\w+)'/g, "from './stubs/$1.js'")
        .replace(/from 'resource:\/\/\/org\/gnome\/shell\/ui\/main\.js'/g, "from './stubs/Main.js'")
        .replace(
            /from 'resource:\/\/\/org\/gnome\/shell\/extensions\/extension\.js'/g,
            "from './stubs/Extension.js'",
        );
    writeFileSync(join(dir, file), src);
}

// --- The fake desktop --------------------------------------------------------------------
const panelClasses = new Set();
const settingValues = {
    transparency: 35,
    'dark-full-screen': true,
    'disable-text-shadow': false,
    'auto-transparency': true,
    'auto-min-transparency': 10,
    'auto-max-transparency': 85,
    'auto-last-opacity': -1,
    'picture-uri': 'file:///tmp/wall.jpg',
    'picture-uri-dark': 'file:///tmp/wall.jpg',
    'picture-options': 'spanned',
    'primary-color': '#000000000000',
    'secondary-color': '#ffffffffffff',
    'color-shading-type': 'solid',
    'color-scheme': 'prefer-dark',
};

globalThis.__hooks = {
    pending: [],
    pixbufCalls: 0,
    env: {},
    addSource() {
        const id = nextId++;
        live.sources.add(id);
        return id;
    },
    removeSource(id, via) {
        assert.ok(id, `${via} called with a falsy id (${id}) — that warns in GLib`);
        assert.ok(live.sources.has(id), `${via}(${id}) removed a stale/recycled source`);
        live.sources.delete(id);
    },
    settings(schema) {
        return {
            ...connectable(`Settings(${schema})`),
            get_int: (k) => settingValues[k] ?? 0,
            get_boolean: (k) => !!settingValues[k],
            get_string: (k) => settingValues[k] ?? '',
            set_int: (k, v) => (settingValues[k] = v),
            bind: () => {},
        };
    },
    file: () => ({
        read_async: (prio, cancel, cb) => cb({ read_finish: () => ({ close_async() {} }) }, 'res'),
    }),
    pixbuf: () => ({
        get_width: () => 1920,
        get_height: () => 360,
        get_n_channels: () => 3,
        get_rowstride: () => 1920 * 3,
        get_pixels: () => new Uint8Array(1920 * 360 * 3).fill(200),
    }),
    stSettings: {
        ...connectable('St.Settings'),
        high_contrast: false,
        enable_animations: true,
    },
    panel: {
        ...connectable('panel'),
        add_style_class_name: (c) => panelClasses.add(c),
        remove_style_class_name: (c) => panelClasses.delete(c),
        has_style_pseudo_class: () => false,
        get_height: () => 32,
        get_transformed_position: () => [0, 0],
    },
    overview: connectable('overview'),
    sessionMode: { ...connectable('sessionMode'), hasWindows: true },
    layoutManager: {
        ...connectable('layoutManager'),
        primaryMonitor: { x: 3840, y: 0, width: 3840, height: 2160 },
        monitors: [
            { x: 0, y: 0, width: 3840, height: 2160 },
            { x: 3840, y: 0, width: 3840, height: 2160 },
            { x: 7680, y: 0, width: 3840, height: 2160 },
        ],
    },
};

global.window_group = connectable('window_group');
global.window_manager = connectable('window_manager');
global.compositor = {
    get_laters: () => ({
        add(type, fn) {
            const id = globalThis.__hooks.addSource();
            globalThis.__hooks.pending.push([id, fn]);
            return id;
        },
        remove(id) {
            globalThis.__hooks.removeSource(id, 'laters.remove');
        },
    }),
};
global.stage = {};
global.get_window_actors = () => [];
let listWindowsCalls = 0;
global.workspace_manager = {
    get_active_workspace: () => ({
        list_windows: () => {
            listWindowsCalls++;
            return [];
        },
    }),
};

function drainPending(rounds = 5) {
    for (let round = 0; round < rounds; round++) {
        const due = globalThis.__hooks.pending.splice(0);
        for (const [id, fn] of due) {
            if (live.sources.has(id)) {
                live.sources.delete(id);
                assert.strictEqual(
                    fn(),
                    false,
                    `source callback ${id} must return GLib.SOURCE_REMOVE`,
                );
            }
        }
    }
}

// --- Run it ------------------------------------------------------------------------------
const { default: ExtensionClass } = await import(pathToFileURL(join(dir, 'extension.js')).href);

// --- A nested dev-harness Shell shares the live desktop's dconf ---------------------------------
// GNOME Shell 50 resolves the extension dir and dconf from the passwd home dir, so a nested test
// Shell loads this extension for real and its `set_int('auto-last-opacity', …)` lands in the live
// session's settings. Assert nothing runs under the marker — and, below, that everything still runs
// without it. A guard stuck on would pass this half alone.
{
    globalThis.__hooks.env.GNOME_SHELL_DEV_HARNESS = '1';
    const inert = new ExtensionClass({ uuid: 'transparent-top-bar@spencercnorton.github.io' });
    const opacityBefore = settingValues['auto-last-opacity'];
    inert.enable();
    assert.strictEqual(live.signals.size, 0, 'enable() connected signals inside the dev harness');
    assert.strictEqual(live.sources.size, 0, 'enable() queued a source inside the dev harness');
    assert.strictEqual(panelClasses.size, 0, 'enable() styled the panel inside the dev harness');
    assert.strictEqual(inert._settings, undefined, 'enable() opened settings inside the dev harness');
    drainPending();
    assert.strictEqual(
        settingValues['auto-last-opacity'],
        opacityBefore,
        'the dev harness wrote auto-last-opacity into the live session',
    );
    // disable() has no guard by design; it must still be safe to call after an inert enable().
    inert.disable();
    assert.strictEqual(live.signals.size, 0, 'disable() after an inert enable() left signals');
    delete globalThis.__hooks.env.GNOME_SHELL_DEV_HARNESS;
    console.log('  dev-harness marker ok — enable/disable inert, no dconf write');
}

const ext = new ExtensionClass({ uuid: 'transparent-top-bar@spencercnorton.github.io' });

ext.enable();
console.log(`  enable() ok — ${live.signals.size} signals, ${live.sources.size} sources live`);
assert.ok(live.signals.size > 0, 'enable() connected nothing — the stubs are not wired up');

// Drain debounce timers so the async measurement path actually executes.
drainPending();
assert.ok(globalThis.__hooks.pixbufCalls > 0, 'the wallpaper measurement path never ran');
const opacityClasses = [...panelClasses].filter((c) => /^transparent-top-bar-\d+$/.test(c));
assert.strictEqual(
    opacityClasses.length,
    1,
    `exactly one opacity class should be applied, found: ${opacityClasses.join(', ') || 'none'}`,
);
console.log(`  measurement ran — panel classes: ${[...panelClasses].join(' ')}`);

// Settings changes must not strand sources or desync the applied class.
ext.transparencyChanged(null, 'transparency');
ext.transparencyChanged(null, 'transparency');
ext.transparencyChanged(null, 'auto-transparency');
ext.transparencyChanged(null, 'disable-text-shadow');
drainPending();
console.log('  repeated settings changes ok — no stale source removed');

// Allocation/workspace bursts must produce one BEFORE_REDRAW scan, not one scan per signal.
const scansBeforeBurst = listWindowsCalls;
for (let i = 0; i < 100; i++) {
    ext._scheduleTransparencyUpdate();
}
assert.strictEqual(live.sources.size, 1, 'a burst should own exactly one BEFORE_REDRAW callback');
drainPending();
assert.strictEqual(
    listWindowsCalls,
    scansBeforeBurst + 1,
    'a burst of geometry changes should scan the active workspace exactly once',
);

// Duplicate/late child-removed notifications must be harmless and share the same frame callback.
ext._onWindowActorRemoved(null, {});
ext._onWindowActorRemoved(null, {});
assert.strictEqual(live.sources.size, 1, 'duplicate actor removal should still queue only one scan');
drainPending();
console.log('  geometry bursts coalesced — one owned scan per frame');

// Window/workspace geometry is irrelevant when window-driven darkening is disabled.
const scansBeforeDisabledGeometry = listWindowsCalls;
ext._darkFullScreen = false;
for (let i = 0; i < 100; i++) {
    ext._scheduleTransparencyUpdate();
}
assert.strictEqual(live.sources.size, 0, 'disabled window darkening must not queue a frame scan');
drainPending();
assert.strictEqual(
    listWindowsCalls,
    scansBeforeDisabledGeometry,
    'disabled window darkening must not scan the active workspace',
);
ext._darkFullScreen = true;

// A setting change between queue and frame must suppress the already-owned stale scan too.
const scansBeforeDisableRace = listWindowsCalls;
ext._scheduleTransparencyUpdate();
assert.strictEqual(live.sources.size, 1, 'enabled window darkening should queue one frame scan');
ext._darkFullScreen = false;
drainPending();
assert.strictEqual(
    listWindowsCalls,
    scansBeforeDisableRace,
    'a queued callback must recheck window darkening before scanning',
);
ext._darkFullScreen = true;

// High contrast remains an immediate opaque override; reduced motion only changes transitions.
globalThis.__hooks.stSettings.high_contrast = true;
ext._updateTransparent();
assert.ok(!panelClasses.has('transparent-top-bar'), 'high contrast must force an opaque panel');
globalThis.__hooks.stSettings.high_contrast = false;
ext._updateTransparent();
globalThis.__hooks.stSettings.enable_animations = false;
ext._updateMotion();
assert.ok(
    panelClasses.has('transparent-top-bar-no-motion'),
    'disabled animations must add the no-motion class',
);

// Leave a queued frame callback for disable() to prove it is cancelled and cannot run afterward.
ext._scheduleTransparencyUpdate();
ext.disable();
assert.strictEqual(
    live.signals.size,
    0,
    `disable() leaked ${live.signals.size} signal(s): ${[...live.signals.values()].join(', ')}`,
);
assert.strictEqual(live.sources.size, 0, `disable() leaked ${live.sources.size} GLib source(s)`);
assert.strictEqual(
    [...panelClasses].filter((c) => c.startsWith('transparent-top-bar')).length,
    0,
    `disable() left panel classes behind: ${[...panelClasses].join(', ')}`,
);

console.log('ok — enable/disable clean: no leaked signals, sources, or panel classes');
