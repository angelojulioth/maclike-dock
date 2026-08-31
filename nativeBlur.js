import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

const RoundedMaskEffect = GObject.registerClass(
class RoundedMaskEffect extends Clutter.ShaderEffect {
    _init(radius) {
        super._init();
        this._radius = radius;
        this.set_shader_source(`
            uniform sampler2D tex;
            uniform float radius;
            uniform float width;
            uniform float height;
            void main(void) {
                vec2 uv = cogl_tex_coord_in[0].xy;
                vec2 p = uv * vec2(width, height);
                vec2 q = min(p, vec2(width, height) - p);
                float a = 1.0;
                if (q.x < radius && q.y < radius) {
                    float d = length(q - vec2(radius));
                    a = 1.0 - smoothstep(radius - 1.0, radius, d);
                }
                vec4 c = texture2D(tex, uv);
                cogl_color_out = vec4(c.rgb * a, c.a * a);
            }
        `);
    }

    vfunc_set_actor(actor) {
        this._sizeSignal && this.get_actor()?.disconnect(this._sizeSignal);
        this._sizeSignal = 0;
        if (actor) {
            const sync = () => {
                this.set_uniform_value('radius', this._radius);
                this.set_uniform_value('width', Math.max(1, actor.width));
                this.set_uniform_value('height', Math.max(1, actor.height));
            };
            this._sizeSignal = actor.connect('notify::size', sync);
            sync();
        }
        super.vfunc_set_actor(actor);
    }

    set radius(value) {
        this._radius = value;
        this.set_uniform_value('radius', value);
    }
});

export const NativeBlurSurface = GObject.registerClass(
class NativeBlurSurface extends St.Widget {
    _init({sigma, brightness, radius}) {
        super._init({
            name: 'maclike-native-blur-surface',
            x_expand: true,
            y_expand: true,
            reactive: false,
        });
        this._initialParams = {sigma, brightness, radius};
    }

    initialize() {
        const {sigma, brightness, radius} = this._initialParams;
        this._initialParams = null;
        this._scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this.mask = new RoundedMaskEffect(radius * this._scale);
        this.blur = new Shell.BlurEffect({
            mode: Shell.BlurMode.BACKGROUND,
            radius: sigma * 2 * this._scale,
            brightness,
        });
        // Clutter paints the effect list in reverse order.
        this.add_effect(this.mask);
        this.add_effect(this.blur);
    }

    update({sigma, brightness, radius}) {
        this.blur.radius = sigma * 2 * this._scale;
        this.blur.brightness = brightness;
        this.mask.radius = radius * this._scale;
        this.blur.queue_repaint();
    }
});
