import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const TRANSPARENCY = 'transparency';
const DARK_FULL_SCREEN = 'dark-full-screen';
const DISABLE_TEXT_SHADOW = 'disable-text-shadow';
const AUTO_TRANSPARENCY = 'auto-transparency';
const AUTO_MIN = 'auto-min-transparency';
const AUTO_MAX = 'auto-max-transparency';

export default class TransparentTopBarPrefsWidget extends ExtensionPreferences {

    fillPreferencesWindow(window) {
        window._settings = this.getSettings();
        const opacity = window._settings.get_int(TRANSPARENCY);
        const darkFullScreen = window._settings.get_boolean(DARK_FULL_SCREEN);
        const disableTextShadow = window._settings.get_boolean(DISABLE_TEXT_SHADOW);

        const page = new Adw.PreferencesPage();

        const group = new Adw.PreferencesGroup({
            title: _('Top bar opacity (%)'),
        });

        // scale
        const scale = new Gtk.Scale();
        scale.set_digits(0);
        scale.set_round_digits(0);

        scale.set_range(0, 100);
        scale.set_draw_value(true);

        // setting value last as it might not work if the scale is not set up properly
        scale.set_value(opacity);
        scale.connect('value-changed', (scale) => {
            window._settings.set_int(TRANSPARENCY, scale.get_value());
        });
        group.add(scale);

        // Switch for full opacity when window touch the bar
        const row = new Gtk.Box();
        row.set_orientation(Gtk.HORIZONTAL);
        row.set_margin_top(20);
        row.set_margin_bottom(20);
        //row.set_homogeneous(true);

        const sw = new Gtk.Switch();
        sw.set_active(darkFullScreen);
        sw.connect('state-set', (sw) => {
            window._settings.set_boolean(DARK_FULL_SCREEN, sw.get_active());
        });
        sw.set_halign(Gtk.Align.END);

        const label = Gtk.Label.new('Opaque top bar when a window touches it');
        label.set_hexpand(true);
        label.set_halign(Gtk.Align.START);

        row.append(label);
        row.append(sw);
        group.add(row);

        const shadowRow = new Gtk.Box();
        shadowRow.set_orientation(Gtk.HORIZONTAL);
        shadowRow.set_margin_top(20);
        shadowRow.set_margin_bottom(20);

        const shadowSwitch = new Gtk.Switch();
        shadowSwitch.set_active(disableTextShadow);
        shadowSwitch.connect('state-set', (sw) => {
            window._settings.set_boolean(DISABLE_TEXT_SHADOW, sw.get_active());
        });
        shadowSwitch.set_halign(Gtk.Align.END);

        const shadowLabel = Gtk.Label.new('Disable text shadow');
        shadowLabel.set_hexpand(true);
        shadowLabel.set_halign(Gtk.Align.START);

        shadowRow.append(shadowLabel);
        shadowRow.append(shadowSwitch);
        group.add(shadowRow);

        page.add(group);

        // --- Auto opacity (fork addition) ---
        const autoGroup = new Adw.PreferencesGroup({
            title: _('Adapt to wallpaper'),
            description: _(
                'Measures the wallpaper behind the panel and picks the lowest opacity that keeps ' +
                'panel text at 4.5:1 contrast. Overrides the slider above while enabled.'),
        });

        const autoRow = new Adw.ActionRow({title: _('Adapt opacity to wallpaper')});
        const autoSwitch = new Gtk.Switch({valign: Gtk.Align.CENTER});
        window._settings.bind(AUTO_TRANSPARENCY, autoSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        autoRow.add_suffix(autoSwitch);
        autoRow.activatable_widget = autoSwitch;
        autoGroup.add(autoRow);

        const addBound = (key, title, subtitle) => {
            const row = new Adw.SpinRow({
                title: _(title),
                subtitle: _(subtitle),
                adjustment: new Gtk.Adjustment({lower: 0, upper: 100, step_increment: 1}),
            });
            // NOT Gio.Settings.bind(): Adw.SpinRow:value is a gdouble and these keys are 'i',
            // which g_settings_bind refuses to coerce — the row would silently never bind.
            row.set_value(window._settings.get_int(key));
            row.connect('notify::value', () => {
                const rounded = Math.round(row.get_value());
                if (window._settings.get_int(key) !== rounded) {
                    window._settings.set_int(key, rounded);
                }
            });
            const changedId = window._settings.connect(`changed::${key}`, () => {
                row.set_value(window._settings.get_int(key));
            });
            row.connect('destroy', () => window._settings.disconnect(changedId));
            // Meaningless while the fixed slider is in charge.
            window._settings.bind(AUTO_TRANSPARENCY, row, 'sensitive', Gio.SettingsBindFlags.GET);
            autoGroup.add(row);
        };
        addBound(AUTO_MIN, 'Minimum opacity (%)', 'Keeps some presence over very dark wallpapers');
        addBound(AUTO_MAX, 'Maximum opacity (%)', 'Stays translucent even over a white wallpaper');

        page.add(autoGroup);

        window.add(page);
    }

    onValueChanged(scale) {
        this.settings.set_int("transparency", this._opacity.get_value());
    }

    onDarkFullScreenChanged(gtkSwitch) {
        this.settings.set_boolean("dark-full-screen", this._darkFullScreen.get_active());
    }
}

