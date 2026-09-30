/**
 * Colour maths for auto panel opacity.
 *
 * Deliberately free of any `gi://` import so it can run outside gnome-shell — see
 * `scripts/check-opacity.mjs`, which exercises it against real wallpaper files.
 */

/** Panel text colour set by stylesheet.scss (`#panel.transparent-top-bar .panel-button { color: #eee }`). */
export const PANEL_TEXT_VALUE = 0xee;
/** WCAG 2.1 AA for body text. The panel also carries a text-shadow, so this is a floor, not a ceiling. */
export const CONTRAST_TARGET = 4.5;
/** Fraction of sampled pixels allowed to be brighter than the value we plan against. */
export const BRIGHT_PERCENTILE = 0.95;

export function srgbToLinear(value) {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(linear) {
    const c = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
    return Math.min(255, Math.max(0, c * 255));
}

/** WCAG 2.1 relative luminance for an 8-bit sRGB triple. */
export function relativeLuminance(r, g, b) {
    return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

export function contrastRatio(luminanceA, luminanceB) {
    const hi = Math.max(luminanceA, luminanceB);
    const lo = Math.min(luminanceA, luminanceB);
    return (hi + 0.05) / (lo + 0.05);
}

/**
 * Representative brightness of the strip behind the panel.
 *
 * A high percentile rather than the mean: a mostly-dark wallpaper with one bright patch under the
 * clock still needs the panel darkened, and a mean would average that patch away.
 */
export function percentile(luminances, fraction = BRIGHT_PERCENTILE) {
    if (luminances.length === 0) return 0;
    const sorted = Float64Array.from(luminances).sort();
    const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
    return sorted[index];
}

/**
 * Lowest opacity (0-100) at which `#eee` panel text still clears CONTRAST_TARGET over a backdrop of
 * the given luminance, clamped to [min, max].
 *
 * The panel paints `rgba(0,0,0,opacity)` over the wallpaper, so each channel is scaled by
 * (1 - opacity). We reduce the sampled backdrop to the equivalent grey first — exact for greys and
 * close enough otherwise, since the scaling is per-channel and uniform.
 */
export function pickOpacity(backdropLuminance, { min = 0, max = 100 } = {}) {
    const textLuminance = srgbToLinear(PANEL_TEXT_VALUE);
    const grey = linearToSrgb(backdropLuminance);
    const lo = Math.max(0, Math.min(100, Math.round(min)));
    const hi = Math.max(lo, Math.min(100, Math.round(max)));
    for (let opacity = lo; opacity <= hi; opacity++) {
        const composited = srgbToLinear(grey * (1 - opacity / 100));
        if (contrastRatio(textLuminance, composited) >= CONTRAST_TARGET) return opacity;
    }
    return hi;
}

/**
 * Parses a GDK colour string as used by `org.gnome.desktop.background primary-color`.
 *
 * GSettings stores these in GDK's legacy form, which is 16 bits per channel
 * (`#000000000000`), but 8-bit (`#rrggbb`) and 4-bit (`#rgb`) forms are also valid. Returns
 * `[r, g, b]` scaled to 8 bits, or `null` if unparseable.
 */
export function parseGdkColor(value) {
    if (typeof value !== 'string') return null;
    // The leading '#' is required: this validates arbitrary string-valued GSettings input, and
    // without it a bare all-hex string would silently parse instead of falling back.
    const match = /^#((?:[0-9a-fA-F]{3}){1,4})$/.exec(value.trim());
    if (!match) return null;
    const hex = match[1];
    const per = hex.length / 3;
    const max = 16 ** per - 1;
    return [0, 1, 2].map((i) =>
        Math.round((parseInt(hex.slice(i * per, (i + 1) * per), 16) / max) * 255),
    );
}
