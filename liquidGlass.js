import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

export const LiquidGlassEffect = GObject.registerClass(
class LiquidGlassEffect extends Clutter.ShaderEffect {
    _init({radius = 20, scale = 1, refraction = 0.35, dispersion = 0.025, specular = 0.65, darkTheme = false} = {}) {
        super._init();
        this._radius = radius;
        this._scale = scale;
        this._refraction = refraction;
        this._dispersion = dispersion;
        this._specular = specular;
        this._darkTheme = darkTheme;
        this._sizeSignal = 0;

        this.set_shader_source(`
            uniform sampler2D tex;
            uniform float radius;
            uniform float width;
            uniform float height;
            uniform float scale;
            uniform float refraction_strength;
            uniform float dispersion;
            uniform float specular_intensity;
            uniform float is_dark;

            // Analytical signed distance to rounded box perimeter (positive inside, negative outside)
            float getDist(vec2 p, float r, vec2 size) {
                vec2 q = min(p, size - p);
                if (q.x < r && q.y < r) {
                    return r - length(vec2(r) - q);
                }
                return min(q.x, q.y);
            }

            void main(void) {
                vec2 uv = cogl_tex_coord_in[0].xy;
                vec2 size = vec2(width, height);
                vec2 p = uv * size;

                // Clamped corner radius
                float r = min(radius, min(width * 0.5, height * 0.5));
                float distToEdge = getDist(p, r, size);

                // Anti-aliased boundary mask
                float alpha = clamp(distToEdge + 0.5, 0.0, 1.0);
                if (alpha <= 0.0) {
                    cogl_color_out = vec4(0.0);
                    return;
                }

                // Meniscus rim bevel width in physical pixels
                float bevelWidth = clamp(r * 0.80, 8.0 * scale, 24.0 * scale);
                float t = clamp(distToEdge / bevelWidth, 0.0, 1.0);

                // Outward and inward normal from continuous central differences
                vec2 grad = vec2(
                    getDist(p + vec2(1.0, 0.0), r, size) - getDist(p - vec2(1.0, 0.0), r, size),
                    getDist(p + vec2(0.0, 1.0), r, size) - getDist(p - vec2(0.0, 1.0), r, size)
                );
                float gradLen = length(grad);
                vec2 nIn = (gradLen > 0.001) ? (grad / gradLen) : vec2(0.0, 1.0);
                vec2 nOut = -nIn;

                // Meniscus curvature profile
                float cosT = cos(t * 1.57079632679);
                float slope = cosT * cosT;

                vec3 color;
                // Optimization: flat interior fragments only perform 1 texture lookup
                if (t >= 0.999 || refraction_strength <= 0.001) {
                    color = texture2D(tex, uv).rgb;
                } else {
                    // Refraction offset in UV space
                    float maxRefractPx = 15.0 * scale * refraction_strength;
                    vec2 uvOffset = (nIn * slope * maxRefractPx) / size;

                    // Chromatic aberration (RGB dispersion)
                    float disp = dispersion * 0.5;
                    vec2 uvR = clamp(uv + uvOffset * (1.0 - disp), 0.002, 0.998);
                    vec2 uvG = clamp(uv + uvOffset, 0.002, 0.998);
                    vec2 uvB = clamp(uv + uvOffset * (1.0 + disp), 0.002, 0.998);

                    float red   = texture2D(tex, uvR).r;
                    float green = texture2D(tex, uvG).g;
                    float blue  = texture2D(tex, uvB).b;
                    color = vec3(red, green, blue);
                }

                // --- Apple Liquid Glass Specular & Lighting Model ---
                vec3 normal3D = normalize(vec3(nOut.x * slope * 0.85, nOut.y * slope * 0.85, 1.0));

                // Virtual key light from top-front
                vec3 lightDir = normalize(vec3(0.0, -0.80, 0.60));
                vec3 viewDir = vec3(0.0, 0.0, 1.0);
                vec3 halfVec = normalize(lightDir + viewDir);

                // Specular highlight on the curved bevel
                float NdotH = max(0.0, dot(normal3D, halfVec));
                float specular = pow(NdotH, 26.0) * specular_intensity * slope;

                // Razor-thin top crest glint
                float edgeDist = max(0.0, distToEdge);
                float topFacing = max(0.0, -nOut.y);
                float topCrest = smoothstep(2.5 * scale, 0.5 * scale, edgeDist) * topFacing * 0.38 * specular_intensity;

                // Subtle bottom bounce highlight
                float bottomFacing = max(0.0, nOut.y);
                float bottomRim = smoothstep(2.0 * scale, 0.5 * scale, edgeDist) * bottomFacing * 0.12 * specular_intensity;

                // Fresnel reflection at glancing angles
                float fresnel = pow(1.0 - normal3D.z, 2.5) * 0.24 * specular_intensity;

                // Internal reflection band along meniscus transition
                float innerBand = smoothstep(0.15, 0.45, t) * (1.0 - smoothstep(0.45, 0.85, t)) * 0.08;

                // Tone mapping & Theme adaptivity
                if (is_dark > 0.5) {
                    vec3 darkTint = vec3(0.12, 0.15, 0.22);
                    color = mix(color, darkTint, 0.28);
                    color += vec3(specular * 0.8 + topCrest * 0.95 + bottomRim * 0.5 + fresnel * 0.75 + innerBand);
                } else {
                    vec3 lightTint = vec3(0.95, 0.97, 1.0);
                    color = mix(color, lightTint, 0.15);
                    color += vec3(0.035);
                    color += vec3(specular + topCrest + bottomRim * 0.6 + fresnel * 0.85 + innerBand * 0.85);
                }

                // Premultiplied alpha output
                cogl_color_out = vec4(color * alpha, alpha);
            }
        `);
    }

    vfunc_set_actor(actor) {
        if (this._sizeSignal && this.get_actor()) {
            this.get_actor().disconnect(this._sizeSignal);
            this._sizeSignal = 0;
        }
        if (actor) {
            const sync = () => {
                this.set_uniform_value('radius', parseFloat(this._radius));
                this.set_uniform_value('scale', parseFloat(this._scale));
                this.set_uniform_value('refraction_strength', parseFloat(this._refraction));
                this.set_uniform_value('dispersion', parseFloat(this._dispersion));
                this.set_uniform_value('specular_intensity', parseFloat(this._specular));
                this.set_uniform_value('is_dark', this._darkTheme ? 1.0 : 0.0);
                this.set_uniform_value('width', Math.max(1.0, parseFloat(actor.width)));
                this.set_uniform_value('height', Math.max(1.0, parseFloat(actor.height)));
            };
            this._sizeSignal = actor.connect('notify::size', sync);
            sync();
        }
        super.vfunc_set_actor(actor);
    }

    set radius(value) {
        this._radius = value;
        this.set_uniform_value('radius', parseFloat(value));
    }

    set scale(value) {
        this._scale = value;
        this.set_uniform_value('scale', parseFloat(value));
    }

    set refraction(value) {
        this._refraction = value;
        this.set_uniform_value('refraction_strength', parseFloat(value));
    }

    set dispersion(value) {
        this._dispersion = value;
        this.set_uniform_value('dispersion', parseFloat(value));
    }

    set specular(value) {
        this._specular = value;
        this.set_uniform_value('specular_intensity', parseFloat(value));
    }

    set darkTheme(value) {
        this._darkTheme = Boolean(value);
        this.set_uniform_value('is_dark', this._darkTheme ? 1.0 : 0.0);
    }
});

export const LiquidGlassSurface = GObject.registerClass(
class LiquidGlassSurface extends St.Widget {
    _init({
        sigma = 32,
        brightness = 0.72,
        radius = 20,
        refraction = 0.35,
        dispersion = 0.025,
        specular = 0.65,
        darkTheme = false,
    } = {}) {
        super._init({
            name: 'maclike-liquid-glass-surface',
            x_expand: true,
            y_expand: true,
            reactive: false,
        });
        this._initialParams = {
            sigma,
            brightness,
            radius,
            refraction,
            dispersion,
            specular,
            darkTheme,
        };
    }

    initialize() {
        if (!this._initialParams)
            return;
        const {
            sigma,
            brightness,
            radius,
            refraction,
            dispersion,
            specular,
            darkTheme,
        } = this._initialParams;
        this._initialParams = null;
        this._scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;

        this.effect = new LiquidGlassEffect({
            radius: radius * this._scale,
            scale: this._scale,
            refraction,
            dispersion,
            specular,
            darkTheme,
        });

        this.blur = new Shell.BlurEffect({
            mode: Shell.BlurMode.BACKGROUND,
            radius: sigma * 2 * this._scale,
            brightness,
        });

        // Clutter paints effects in reverse order of addition.
        // Adding the shader effect first means the blur effect (added second)
        // runs first, providing the blurred background texture to the shader.
        this.add_effect(this.effect);
        this.add_effect(this.blur);
    }

    update({
        sigma,
        brightness,
        radius,
        refraction,
        dispersion,
        specular,
        darkTheme,
    } = {}) {
        if (sigma !== undefined)
            this.blur.radius = sigma * 2 * this._scale;
        if (brightness !== undefined)
            this.blur.brightness = brightness;
        if (radius !== undefined)
            this.effect.radius = radius * this._scale;
        if (refraction !== undefined)
            this.effect.refraction = refraction;
        if (dispersion !== undefined)
            this.effect.dispersion = dispersion;
        if (specular !== undefined)
            this.effect.specular = specular;
        if (darkTheme !== undefined)
            this.effect.darkTheme = darkTheme;

        this.blur.queue_repaint();
    }

    updateTheme(darkTheme) {
        if (this.effect) {
            this.effect.darkTheme = darkTheme;
            this.blur?.queue_repaint();
        }
    }
});
