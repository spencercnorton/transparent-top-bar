/**
 * Samples the wallpaper strip sitting behind the top panel.
 *
 * Split out from extension.js so the geometry rule is readable on its own, and so the pure maths in
 * luminance.js stays importable by the offline check.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { percentile, relativeLuminance } from './luminance.js';

/**
 * Width the wallpaper is decoded down to before sampling.
 *
 * Big enough that a bright patch the width of the clock still survives as several pixels (a spanned
 * wallpaper 11520px across three 4K monitors is sampled at ~640px per monitor), small enough that
 * the JPEG loader can scale during decode instead of after.
 */
const SAMPLE_WIDTH = 1920;

/** Bounding box of every monitor, which is what `picture-options: spanned` stretches across. */
function monitorUnion() {
    const monitors = Main.layoutManager.monitors;
    if (!monitors || monitors.length === 0) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const monitor of monitors) {
        x0 = Math.min(x0, monitor.x);
        y0 = Math.min(y0, monitor.y);
        x1 = Math.max(x1, monitor.x + monitor.width);
        y1 = Math.max(y1, monitor.y + monitor.height);
    }
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * The panel's footprint as fractions of the wallpaper image, in [0,1].
 *
 * Only `spanned` stretches one image across the whole layout; every other mode draws the image
 * within each monitor, so for those the panel sits over the top of the image itself.
 */
function panelRegionFractions(pictureOptions) {
    const primary = Main.layoutManager.primaryMonitor;
    if (!primary) return null;
    const panelHeight = Math.max(1, Main.panel.get_height());

    if (pictureOptions === 'spanned') {
        const union = monitorUnion();
        if (!union || union.width <= 0 || union.height <= 0) return null;
        return {
            x0: (primary.x - union.x) / union.width,
            x1: (primary.x + primary.width - union.x) / union.width,
            y0: (primary.y - union.y) / union.height,
            y1: (primary.y - union.y + panelHeight) / union.height,
        };
    }
    // An approximation for zoom/scaled/centered/wallpaper — treats the image as filling the
    // primary monitor. Exact for 'zoom' and 'stretched'; slightly off for 'centered'/'scaled' with
    // letterboxing, which only makes us sample a brighter strip than reality, i.e. err darker.
    return { x0: 0, x1: 1, y0: 0, y1: panelHeight / primary.height };
}

/** Reads the pixels of `region` out of `pixbuf` and returns their relative luminances. */
function regionLuminances(pixbuf, region) {
    const width = pixbuf.get_width();
    const height = pixbuf.get_height();
    const channels = pixbuf.get_n_channels();
    const rowstride = pixbuf.get_rowstride();
    const pixels = pixbuf.get_pixels();

    const px0 = Math.max(0, Math.min(width - 1, Math.floor(region.x0 * width)));
    const px1 = Math.max(px0 + 1, Math.min(width, Math.ceil(region.x1 * width)));
    const py0 = Math.max(0, Math.min(height - 1, Math.floor(region.y0 * height)));
    // At least one row: the panel is a sliver of a 2160px-tall wallpaper and can round to zero.
    const py1 = Math.max(py0 + 1, Math.min(height, Math.ceil(region.y1 * height)));

    const luminances = [];
    for (let y = py0; y < py1; y++) {
        for (let x = px0; x < px1; x++) {
            const offset = y * rowstride + x * channels;
            luminances.push(
                relativeLuminance(pixels[offset], pixels[offset + 1], pixels[offset + 2]),
            );
        }
    }
    return luminances;
}

/**
 * Asynchronously measures the wallpaper behind the panel.
 *
 * Calls `callback(luminance)` with a value in [0,1], or `callback(null)` if the wallpaper could not
 * be read (no wallpaper set, unreadable file, cancelled). Async because decoding even a
 * downscaled 25-megapixel composite on the shell's main loop would visibly stutter.
 */
export function measurePanelBackdrop(uri, pictureOptions, cancellable, callback) {
    const region = panelRegionFractions(pictureOptions);
    if (!region || !uri) {
        callback(null);
        return;
    }
    let file;
    try {
        file = Gio.File.new_for_uri(uri);
    } catch (e) {
        callback(null);
        return;
    }
    file.read_async(GLib.PRIORITY_LOW, cancellable, (source, result) => {
        let stream;
        try {
            stream = source.read_finish(result);
        } catch (e) {
            callback(null);
            return;
        }
        GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
            stream,
            SAMPLE_WIDTH,
            -1,
            true,
            cancellable,
            (pixbufSource, pixbufResult) => {
                try {
                    const pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(pixbufResult);
                    const luminances = regionLuminances(pixbuf, region);
                    callback(luminances.length ? percentile(luminances) : null);
                } catch (e) {
                    callback(null);
                } finally {
                    stream.close_async(GLib.PRIORITY_LOW, null, null);
                }
            },
        );
    });
}
