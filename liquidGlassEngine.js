import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

const uid = Date.now();

export const LiquidGlassEffect = GObject.registerClass({
    GTypeName: `MaclikeDockLiquidGlassEffect_${uid}`,
}, class LiquidGlassEffect extends Clutter.ShaderEffect {
    _init({
        radius = 20,
        scale = 1,
        refraction = 0.35,
        dispersion = 0.025,
        specular = 0.65,
        darkTheme = false,
    } = {}) {
        super._init();
        this._radius = radius;
        this._scale = scale;
        this._refraction = refraction;
        this._dispersion = dispersion;
        this._specular = specular;
        this._darkTheme = darkTheme;
        this._signals = [];

        this.set_shader_source(`
            uniform sampler2D tex;
            uniform float corner_radius;
            uniform float width;
            uniform float height;
            uniform float scale;
            uniform float refraction_strength;
            uniform float dispersion;
            uniform float specular_intensity;
            uniform float is_dark;

            // Signed Distance Field (SDF) function for a rounded rectangle.
            // Returns negative values inside the shape, positive outside, and 0 on the exact edge.
            float sdRoundRect(vec2 p, vec2 b, float r) {
                vec2 d = abs(p) - b + vec2(r);
                return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)) - r;
            }

            // Normalizes the depth value based on the edge curvature.
            float normalizedDepth(float d, float r) {
                float maxDepth = max(r, 1.0);
                float interiorDepth = max(-d, 0.0);
                return clamp(interiorDepth / maxDepth, 0.0, 1.0);
            }

            // Calculates the surface height profile using a superellipse formula.
            float profileHeight(float t, float zScale, float n) {
                float invT = clamp(1.0 - t, 0.0, 1.0);
                float inner = max(1.0 - pow(invT, n), 0.0);
                return pow(inner, 1.0 / n) * zScale;
            }

            // Computes the absolute height at a specific 2D coordinate with smooth edge boundary.
            float getHeight(vec2 p, vec2 b, float r, float zScale, float n, float smoothZone) {
                float d = sdRoundRect(p, b, r);
                if (d > smoothZone)
                    return 0.0;
                float t = normalizedDepth(d, r);
                float h = profileHeight(t, zScale, n);
                float fade = 1.0 - smoothstep(-smoothZone, smoothZone, d);
                return h * fade;
            }

            // Estimates the height gradient (slope) by sampling neighboring pixels.
            vec2 heightGradient(vec2 p, vec2 b, float r, float zScale, float n, float smoothZone, vec2 resolution) {
                float e = clamp(min(resolution.x, resolution.y) / 560.0, 0.5, 1.25);
                float hR = getHeight(p + vec2(e, 0.0), b, r, zScale, n, smoothZone);
                float hL = getHeight(p - vec2(e, 0.0), b, r, zScale, n, smoothZone);
                float hB = getHeight(p + vec2(0.0, e), b, r, zScale, n, smoothZone);
                float hT = getHeight(p - vec2(0.0, e), b, r, zScale, n, smoothZone);
                return vec2((hR - hL) / (2.0 * e), (hB - hT) / (2.0 * e));
            }

            // Converts the 2D gradient into a 3D normal vector.
            vec3 getNormal(vec2 gradH) {
                return normalize(vec3(-gradH.x, -gradH.y, 1.0));
            }

            // Calculates the UV coordinate displacement caused by light refraction (Snell's Law).
            vec2 getDisplacement(float d, vec3 normal, vec2 resolution, float iorVal, float dispScale) {
                if (d > 0.0)
                    return vec2(0.0);

                vec3 viewDir = vec3(0.0, 0.0, -1.0);
                float eta = 1.0 / max(iorVal, 1.001);
                vec3 refractedRay = refract(viewDir, normal, eta);

                if (length(refractedRay) < 0.0001)
                    return vec2(0.0);

                float minRes = max(min(resolution.x, resolution.y), 1.0);
                float thicknessNorm = dispScale / minRes;
                float safe_z = max(-refractedRay.z, 0.15);
                vec2 displacement = (refractedRay.xy / safe_z) * thicknessNorm;
                float max_disp = 0.25;
                if (length(displacement) > max_disp) {
                    displacement = normalize(displacement) * max_disp;
                }
                return displacement;
            }

            void main(void) {
                vec2 uv = cogl_tex_coord_in[0].xy;
                vec2 size = vec2(width, height);
                vec2 pixel_coord = uv * size;
                vec2 center = size * 0.5;
                vec2 local_pos = pixel_coord - center;

                float edgeFeather = max(1.0, 0.85 * scale);
                vec2 box_size = max(center - vec2(edgeFeather * 0.5), vec2(1.0));
                float r = min(corner_radius, min(box_size.x, box_size.y));

                float d = sdRoundRect(local_pos, box_size, r);

                // Anti-aliased geometry boundary
                float outsideTransition = smoothstep(-edgeFeather, edgeFeather, d);
                float alpha = 1.0 - outsideTransition;
                if (alpha <= 0.0) {
                    cogl_color_out = vec4(0.0);
                    return;
                }

                // Superellipse profile height & normal
                float zScale = 22.0 * scale;
                float n = 3.2;
                vec2 gradH = heightGradient(local_pos, box_size, r, zScale, n, edgeFeather, size);
                vec3 normal = getNormal(gradH);

                // Snell's Law refraction
                float iorVal = 1.48; // Physical crown glass IOR
                float dispScale = 65.0 * scale * refraction_strength;
                vec2 disp = getDisplacement(d, normal, size, iorVal, dispScale);

                // Dampen refraction near edges to avoid stretching
                float edgeDampen = smoothstep(0.0, edgeFeather * 2.5, -d);
                disp *= edgeDampen;

                // Chromatic dispersion
                vec2 chromaDir = length(disp) > 0.00001 ? normalize(disp) : vec2(0.0);
                float minRes = max(min(size.x, size.y), 1.0);
                vec2 chromaVec = chromaDir * ((dispersion * 38.0 * scale) / minRes) * edgeDampen;

                vec2 refrUv = clamp(uv + disp, vec2(0.001), vec2(0.999));
                vec2 uvR = clamp(refrUv + chromaVec, vec2(0.001), vec2(0.999));
                vec2 uvG = refrUv;
                vec2 uvB = clamp(refrUv - chromaVec, vec2(0.001), vec2(0.999));

                // 4-tap RGSS antialiased texture sampling
                float edgeProximity = 1.0 - smoothstep(0.0, edgeFeather * 4.0, -d);
                float aa_spread = mix(0.5, 1.6, edgeProximity);
                vec2 texel = vec2(aa_spread) / size;
                vec2 off1 = vec2( 0.375, -0.125) * texel;
                vec2 off2 = vec2( 0.125,  0.375) * texel;
                vec2 off3 = vec2(-0.375,  0.125) * texel;
                vec2 off4 = vec2(-0.125, -0.375) * texel;

                vec2 margin = vec2(1.2) / size;

                vec3 refrColor = vec3(
                    (texture2D(tex, clamp(uvR + off1, margin, 1.0 - margin)).r +
                     texture2D(tex, clamp(uvR + off2, margin, 1.0 - margin)).r +
                     texture2D(tex, clamp(uvR + off3, margin, 1.0 - margin)).r +
                     texture2D(tex, clamp(uvR + off4, margin, 1.0 - margin)).r) * 0.25,

                    (texture2D(tex, clamp(uvG + off1, margin, 1.0 - margin)).g +
                     texture2D(tex, clamp(uvG + off2, margin, 1.0 - margin)).g +
                     texture2D(tex, clamp(uvG + off3, margin, 1.0 - margin)).g +
                     texture2D(tex, clamp(uvG + off4, margin, 1.0 - margin)).g) * 0.25,

                    (texture2D(tex, clamp(uvB + off1, margin, 1.0 - margin)).b +
                     texture2D(tex, clamp(uvB + off2, margin, 1.0 - margin)).b +
                     texture2D(tex, clamp(uvB + off3, margin, 1.0 - margin)).b +
                     texture2D(tex, clamp(uvB + off4, margin, 1.0 - margin)).b) * 0.25
                );

                // Base glass color & theme tint
                vec3 baseColor;
                if (is_dark > 0.5) {
                    vec3 darkTint = vec3(0.09, 0.12, 0.18);
                    baseColor = mix(refrColor, darkTint, 0.32);
                } else {
                    vec3 lightTint = vec3(0.96, 0.98, 1.0);
                    baseColor = mix(refrColor, lightTint, 0.16);
                    baseColor += vec3(0.035);
                }

                // Inner Ambient Occlusion
                float aoRadius = clamp(r * 0.40, 6.0 * scale, 18.0 * scale);
                float aoMask = 1.0 - smoothstep(0.0, aoRadius, -d);
                float aoIntensity = (is_dark > 0.5) ? 0.32 : 0.18;
                baseColor *= (1.0 - aoMask * aoIntensity);

                // Surface Lighting & Specular Highlights
                vec3 lightDir = normalize(vec3(0.0, -0.75, 0.55));
                vec3 viewDir = vec3(0.0, 0.0, 1.0);
                vec3 halfVec = normalize(lightDir + viewDir);

                float rimWidth = clamp(r * 0.55, 6.0 * scale, 16.0 * scale);
                float edgeBand = (1.0 - smoothstep(0.0, rimWidth, abs(d)));
                float rimDot = 1.0 - max(dot(normal, viewDir), 0.0);
                float rimFresnel = pow(max(rimDot, 0.0), 1.8);
                float lightMask = pow(max(abs(dot(normal, lightDir)), 0.0), 1.6);
                float rimShape = mix(pow(edgeBand, 0.85), rimFresnel, 0.55) * edgeBand;
                float finalRimLight = rimShape * lightMask * 0.75 * specular_intensity;

                float NdotH = max(dot(normal, halfVec), 0.0);
                float specularLight = pow(NdotH, 28.0) * specular_intensity;
                specularLight *= clamp(edgeBand + 0.35, 0.0, 1.0);

                float topFacing = max(0.0, -normal.y);
                float topCrest = smoothstep(2.8 * scale, 0.6 * scale, abs(d)) * topFacing * 0.42 * specular_intensity;

                float bottomFacing = max(0.0, normal.y);
                float bottomRim = smoothstep(2.2 * scale, 0.6 * scale, abs(d)) * bottomFacing * 0.14 * specular_intensity;

                float sheenFacing = max(dot(normal, lightDir), 0.0);
                float surfaceSheen = pow(sheenFacing, 2.0) * 0.09 * specular_intensity;
                surfaceSheen *= mix(1.0, 0.6, edgeBand);

                vec3 addedLight = vec3(specularLight + finalRimLight + topCrest + bottomRim + surfaceSheen);
                vec3 litColor = baseColor + addedLight - (baseColor * addedLight);

                float maxChannel = max(litColor.r, max(litColor.g, litColor.b));
                if (maxChannel > 1.0) {
                    litColor /= maxChannel;
                }
                litColor = max(litColor, 0.0);

                cogl_color_out = vec4(litColor * alpha, alpha);
            }
        `);

        this.set_uniform_value('corner_radius', parseFloat(this._radius));
        this.set_uniform_value('scale', parseFloat(this._scale));
        this.set_uniform_value('refraction_strength', parseFloat(this._refraction));
        this.set_uniform_value('dispersion', parseFloat(this._dispersion));
        this.set_uniform_value('specular_intensity', parseFloat(this._specular));
        this.set_uniform_value('is_dark', this._darkTheme ? 1.0 : 0.0);
        this.set_uniform_value('width', 100.0);
        this.set_uniform_value('height', 50.0);
    }

    vfunc_paint_target(...args) {
        try {
            const actor = this.get_actor();
            if (actor) {
                const alloc = actor.get_allocation_box();
                const w = (alloc && alloc.x2 > alloc.x1) ? (alloc.x2 - alloc.x1) : actor.width;
                const h = (alloc && alloc.y2 > alloc.y1) ? (alloc.y2 - alloc.y1) : actor.height;
                if (w > 0 && h > 0) {
                    this.set_uniform_value('width', Math.max(1.0, parseFloat(w)));
                    this.set_uniform_value('height', Math.max(1.0, parseFloat(h)));
                    this.set_uniform_value('corner_radius', parseFloat(this._radius));
                    this.set_uniform_value('scale', parseFloat(this._scale));
                    this.set_uniform_value('refraction_strength', parseFloat(this._refraction));
                    this.set_uniform_value('dispersion', parseFloat(this._dispersion));
                    this.set_uniform_value('specular_intensity', parseFloat(this._specular));
                    this.set_uniform_value('is_dark', this._darkTheme ? 1.0 : 0.0);
                }
            }
        } catch (_) {}
        return super.vfunc_paint_target(...args);
    }

    vfunc_set_actor(actor) {
        if (this._connectedActor && this._signals?.length) {
            for (const id of this._signals) {
                try {
                    this._connectedActor.disconnect(id);
                } catch (_) {}
            }
        }
        this._signals = [];
        this._connectedActor = actor;
        if (actor) {
            const sync = () => {
                const alloc = actor.get_allocation_box();
                const w = (alloc && alloc.x2 > alloc.x1) ? (alloc.x2 - alloc.x1) : actor.width;
                const h = (alloc && alloc.y2 > alloc.y1) ? (alloc.y2 - alloc.y1) : actor.height;
                if (w > 0 && h > 0) {
                    this.set_uniform_value('width', Math.max(1.0, parseFloat(w)));
                    this.set_uniform_value('height', Math.max(1.0, parseFloat(h)));
                    this.set_uniform_value('corner_radius', parseFloat(this._radius));
                    this.set_uniform_value('scale', parseFloat(this._scale));
                    this.set_uniform_value('refraction_strength', parseFloat(this._refraction));
                    this.set_uniform_value('dispersion', parseFloat(this._dispersion));
                    this.set_uniform_value('specular_intensity', parseFloat(this._specular));
                    this.set_uniform_value('is_dark', this._darkTheme ? 1.0 : 0.0);
                }
                this.queue_repaint();
            };
            this._signals.push(actor.connect('notify::size', sync));
            this._signals.push(actor.connect('notify::allocation', sync));
            sync();
        }
        super.vfunc_set_actor(actor);
    }

    set radius(value) {
        this._radius = value;
        this.set_uniform_value('corner_radius', parseFloat(value));
        this.queue_repaint();
    }

    set scale(value) {
        this._scale = value;
        this.set_uniform_value('scale', parseFloat(value));
        this.queue_repaint();
    }

    set refraction(value) {
        this._refraction = value;
        this.set_uniform_value('refraction_strength', parseFloat(value));
        this.queue_repaint();
    }

    set dispersion(value) {
        this._dispersion = value;
        this.set_uniform_value('dispersion', parseFloat(value));
        this.queue_repaint();
    }

    set specular(value) {
        this._specular = value;
        this.set_uniform_value('specular_intensity', parseFloat(value));
        this.queue_repaint();
    }

    set darkTheme(value) {
        this._darkTheme = Boolean(value);
        this.set_uniform_value('is_dark', this._darkTheme ? 1.0 : 0.0);
        this.queue_repaint();
    }
});

export const LiquidGlassSurface = GObject.registerClass({
    GTypeName: `MaclikeDockLiquidGlassSurface_${uid}`,
}, class LiquidGlassSurface extends St.Widget {
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

        this._glassEffect = new LiquidGlassEffect({
            radius: radius * this._scale,
            scale: this._scale,
            refraction,
            dispersion,
            specular,
            darkTheme,
        });

        this._blurEffect = new Shell.BlurEffect({
            mode: Shell.BlurMode.BACKGROUND,
            radius: sigma * 2 * this._scale,
            brightness,
        });

        // Clutter paints effects in reverse order of addition.
        // Adding the shader effect first means the blur effect (added second)
        // runs first, providing the blurred background texture to the shader.
        this.add_effect(this._glassEffect);
        this.add_effect(this._blurEffect);
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
        if (sigma !== undefined && this._blurEffect)
            this._blurEffect.radius = sigma * 2 * this._scale;
        if (brightness !== undefined && this._blurEffect)
            this._blurEffect.brightness = brightness;
        if (radius !== undefined && this._glassEffect)
            this._glassEffect.radius = radius * this._scale;
        if (refraction !== undefined && this._glassEffect)
            this._glassEffect.refraction = refraction;
        if (dispersion !== undefined && this._glassEffect)
            this._glassEffect.dispersion = dispersion;
        if (specular !== undefined && this._glassEffect)
            this._glassEffect.specular = specular;
        if (darkTheme !== undefined && this._glassEffect)
            this._glassEffect.darkTheme = darkTheme;

        this._blurEffect?.queue_repaint();
        this._glassEffect?.queue_repaint();
    }

    updateTheme(darkTheme) {
        if (this._glassEffect) {
            this._glassEffect.darkTheme = darkTheme;
            this._blurEffect?.queue_repaint();
            this._glassEffect?.queue_repaint();
        }
    }

    destroy() {
        if (this._glassEffect) {
            this.remove_effect(this._glassEffect);
            this._glassEffect = null;
        }
        if (this._blurEffect) {
            this.remove_effect(this._blurEffect);
            this._blurEffect = null;
        }
        super.destroy();
    }
});
