#!/usr/bin/env node
/**
 * Asserts the opacity curve does what it claims: panel text clears 4.5:1 over whatever the
 * wallpaper puts behind it, while staying inside the user's min/max clamp.
 *
 * Pure maths, so it runs outside gnome-shell. Optionally pass image paths to sample real
 * wallpapers via ImageMagick (skipped automatically if `convert` is unavailable):
 *
 *   node scripts/check-opacity.mjs [wallpaper.jpg ...]
 */
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const {
    pickOpacity,
    percentile,
    relativeLuminance,
    srgbToLinear,
    linearToSrgb,
    contrastRatio,
    CONTRAST_TARGET,
    PANEL_TEXT_VALUE,
    parseGdkColor,
} = await import(join(root, 'src/luminance.js'));

const TEXT_L = srgbToLinear(PANEL_TEXT_VALUE);
const CLAMP = { min: 10, max: 85 };
// A three-monitor spanned layout whose primary monitor is the middle one.
const MONITORS = 3;
const PRIMARY_INDEX = 1;

const achieved = (backdropLuminance, opacity) =>
    contrastRatio(TEXT_L, srgbToLinear(linearToSrgb(backdropLuminance) * (1 - opacity / 100)));

// --- 1. sRGB helpers round-trip -------------------------------------------------------------
for (const v of [0, 1, 8, 64, 128, 238, 255]) {
    assert.ok(
        Math.abs(linearToSrgb(srgbToLinear(v)) - v) < 0.5,
        `srgb round-trip broken at ${v}`,
    );
}

// --- 2. Monotonic: a brighter backdrop never asks for a *less* opaque panel -----------------
let previous = -1;
for (let grey = 0; grey <= 255; grey += 5) {
    const opacity = pickOpacity(srgbToLinear(grey), CLAMP);
    assert.ok(opacity >= previous, `opacity dropped from ${previous} to ${opacity} at grey ${grey}`);
    assert.ok(opacity >= CLAMP.min && opacity <= CLAMP.max, `opacity ${opacity} escaped the clamp`);
    previous = opacity;
}

// --- 3. The actual promise: contrast target met wherever the clamp allows -------------------
let clampedOut = 0;
for (let grey = 0; grey <= 255; grey++) {
    const backdrop = srgbToLinear(grey);
    const opacity = pickOpacity(backdrop, CLAMP);
    const ratio = achieved(backdrop, opacity);
    if (opacity < CLAMP.max) {
        assert.ok(
            ratio >= CONTRAST_TARGET,
            `grey ${grey}: got ${ratio.toFixed(2)}:1 at opacity ${opacity}, below target`,
        );
    } else {
        clampedOut++;
    }
}
console.log(
    `  synthetic greys 0-255: target met except ${clampedOut} greys where the ${CLAMP.max}% cap binds`,
);

// --- 4. Percentile picks the bright patch, not the average ---------------------------------
const mostlyDark = [...Array(950).fill(srgbToLinear(2)), ...Array(50).fill(srgbToLinear(250))];
assert.ok(
    percentile(mostlyDark) > srgbToLinear(200),
    'a bright 5% patch must survive the percentile, or a bright logo under the clock is ignored',
);

// --- 5. GDK colour parsing, for solid-colour desktops ---------------------------------------
// GSettings stores primary-color in GDK's 16-bit-per-channel form; 8- and 4-bit are also legal.
assert.deepStrictEqual(parseGdkColor('#000000000000'), [0, 0, 0]);
assert.deepStrictEqual(parseGdkColor('#ffffffffffff'), [255, 255, 255]);
assert.deepStrictEqual(parseGdkColor('#ff0000'), [255, 0, 0]);
assert.deepStrictEqual(parseGdkColor('#f00'), [255, 0, 0]);
assert.deepStrictEqual(parseGdkColor('#7fff7fff7fff'), [127, 127, 127]);
assert.strictEqual(parseGdkColor('nonsense'), null, 'garbage must not parse as a colour');
assert.strictEqual(parseGdkColor('#12345'), null, 'non-multiple-of-3 length must not parse');
assert.strictEqual(parseGdkColor(null), null);
// The leading '#' is mandatory — this validates arbitrary GSettings string input, so a bare
// all-hex string must fall back rather than silently produce an opacity.
assert.strictEqual(parseGdkColor('ff0000'), null, 'missing # must not parse');
assert.strictEqual(parseGdkColor('000000000000'), null, 'missing # must not parse');
assert.strictEqual(parseGdkColor('#ff00'), null, 'length not a multiple of 3 must not parse');
assert.strictEqual(parseGdkColor('#fffffffffffff'), null, 'over-long hex must not parse');
// A white solid desktop must still drive the panel opaque enough to read.
assert.ok(
    pickOpacity(relativeLuminance(255, 255, 255), CLAMP) > pickOpacity(relativeLuminance(0, 0, 0), CLAMP),
    'a white desktop must ask for more opacity than a black one',
);

// --- 6. Real wallpapers, if ImageMagick is around ------------------------------------------
const images = process.argv.slice(2);
if (images.length) {
    let haveMagick = true;
    try {
        execFileSync('convert', ['-version'], { stdio: 'ignore' });
    } catch {
        haveMagick = false;
        console.log('  (skipping real wallpapers: ImageMagick `convert` not found)');
    }
    for (const image of haveMagick ? images : []) {
        // Primary monitor is the MIDDLE third of the spanned composite on this layout, so the
        // crop needs an explicit x offset — `-gravity north` after `-crop` does not move it, and
        // `+0+0` would sample the left monitor instead.
        const size = execFileSync('identify', ['-format', '%w %h', image], { encoding: 'utf8' });
        const [imgW, imgH] = size.trim().split(/\s+/).map(Number);
        const cropW = Math.floor(imgW / MONITORS);
        const cropX = cropW * PRIMARY_INDEX;
        const cropH = Math.max(1, Math.round(imgH * 0.02)); // panel is ~2% of a 2160px monitor
        const txt = execFileSync('convert', [
            image,
            '-crop', `${cropW}x${cropH}+${cropX}+0`,
            '+repage',
            '-resize', '640x4!',
            'txt:-',
        ], { encoding: 'utf8', maxBuffer: 1 << 26 });
        const lums = [];
        for (const m of txt.matchAll(/\((\d+),(\d+),(\d+)/g)) {
            lums.push(relativeLuminance(+m[1], +m[2], +m[3]));
        }
        assert.ok(lums.length > 0, `no pixels parsed from ${image}`);
        const backdrop = percentile(lums);
        const opacity = pickOpacity(backdrop, CLAMP);
        const ratio = achieved(backdrop, opacity);
        assert.ok(
            opacity >= CLAMP.min && opacity <= CLAMP.max,
            `${image}: opacity ${opacity} escaped the clamp`,
        );
        console.log(
            `  ${basename(image).slice(0, 28).padEnd(30)} backdrop L=${backdrop.toFixed(3)}` +
                ` -> opacity ${String(opacity).padStart(3)}%  text ${ratio.toFixed(1)}:1`,
        );
    }
}

console.log('ok — opacity curve is monotonic, clamped, and meets the contrast target');
