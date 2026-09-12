/* ═══════════════════════════════════════════════════════════════════════════
   webthreads.js — WebGL2 WebThreads Animated Shader Background
   ═══════════════════════════════════════════════════════════════════════════
   High-performance GPU shader rendering dynamic glowing wave threads with
   mouse interactivity, harmonic dispersion, and film grain.
   Pure Vanilla WebGL2 — zero external libraries, zero overhead.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
    "use strict";

    const vertexShaderSrc = `#version 300 es
    in vec2 position;
    void main() {
        gl_Position = vec4(position, 0.0, 1.0);
    }`;

    const fragmentShaderSrc = `#version 300 es
    precision highp float;
    uniform vec2 iResolution;
    uniform float iTime;
    uniform float uSpeed;
    uniform float uThreadCount;
    uniform float uFrequency;
    uniform float uSpread;
    uniform float uTaper;
    uniform float uPosition;
    uniform float uFanMode;
    uniform float uGlow;
    uniform float uFalloff;
    uniform float uThickness;
    uniform float uBrightness;
    uniform float uOpacity;
    uniform float uMirror;
    uniform float uShimmer;
    uniform float uGrain;
    uniform float uGrainIntensity;
    uniform vec3 uColor1;
    uniform vec3 uColor2;
    uniform vec3 uColor3;
    uniform vec3 uBackgroundColor;
    uniform bool uLightMode;
    uniform vec2 uMouse;
    uniform float uMouseStrength;
    uniform float uEnableMouse;
    uniform float uMouseActive;
    out vec4 fragColor;

    #define TAU 6.28318530718
    #define MAX_THREADS 10

    float glow(float x, float str, float dist) {
        return dist / pow(max(x, 1e-4), str);
    }

    void main() {
        vec2 uv = gl_FragCoord.xy / iResolution.xy;
        float n = max(uThreadCount, 1.0);

        float pinchX = uFanMode < 0.5 ? 0.5 : (uFanMode < 1.5 ? 0.0 : 1.0);
        if (uEnableMouse > 0.5) {
            pinchX = mix(pinchX, uMouse.x, clamp(uMouseStrength, 0.0, 1.0) * uMouseActive);
        }

        float spreadDx = uSpread * abs(uv.x - pinchX);
        float baseT = iTime * uSpeed;
        float tauOverN = TAU / n;
        float mirror = uMirror > 0.5 ? sign(pinchX - uv.x) : 1.0;
        bool doShimmer = uShimmer > 0.5;
        float shimmerT = iTime * 1.7;
        float invThickness = 1.0 / max(uThickness, 0.01);
        float xFreq = uv.x * uFrequency;
        float yOff = uv.y - uPosition;
        float ciScale = n > 1.0 ? 1.0 / (n - 1.0) : 0.0;

        vec3 col = vec3(0.0);
        float gsum = 0.0;

        for (int idx = 0; idx < MAX_THREADS; idx++) {
            float i = float(idx);
            if (i >= n) break;

            float amplitude = spreadDx * (1.0 + i * uTaper);
            float shimmer = doShimmer ? sin(shimmerT + i * 1.3) * 0.35 : 0.0;
            float phase = (baseT + i * tauOverN) * mirror + shimmer;

            float sdf = abs(yOff + sin(xFreq + phase) * amplitude) * invThickness;

            float g = glow(sdf, uFalloff, uGlow);
            float ci = i * ciScale;
            vec3 threadCol = mix(uColor1, uColor2, ci);

            col += g * threadCol;
            gsum += g;
        }

        float coreAmt = smoothstep(0.5, 2.2, gsum);
        col = mix(col, uColor3 * gsum, coreAmt * 0.5);

        float bright = uBrightness;
        if (uEnableMouse > 0.5) {
            vec2 md = uv - uMouse;
            float d2 = dot(md, md);
            bright += clamp(uMouseStrength, 0.0, 1.0) * uMouseActive * exp(-d2 * 6.0) * 0.6;
        }
        col *= bright;

        float alpha = clamp(gsum, 0.0, 1.0) * uOpacity;

        vec3 outRgb = col * alpha;

        if (uGrain > 0.5) {
            float gv = (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233)) + iTime) * 43758.5453) - 0.5) * uGrainIntensity;
            outRgb = clamp(outRgb + gv, 0.0, 1.0);
            alpha = clamp(alpha + gv, 0.0, 1.0);
        }

        if (uLightMode) {
            vec3 mapped = vec3(1.0) - exp(-max(col, vec3(0.0)) * 1.3);
            float rawEnergy = clamp(max(mapped.r, max(mapped.g, mapped.b)) * uOpacity, 0.0, 1.0);
            float coverage = smoothstep(0.18, 0.72, rawEnergy);
            coverage *= coverage;
            vec3 hue = mapped / max(max(mapped.r, max(mapped.g, mapped.b)), 1e-4);
            vec3 chroma = pow(clamp(hue, 0.0, 1.0), vec3(0.78));
            vec3 pigment = mix(chroma, vec3(0.08), 0.12);
            vec3 ink = mix(vec3(0.9), pigment, 0.82 + coverage * 0.18);
            fragColor = vec4(mix(uBackgroundColor, ink, coverage), 1.0);
        } else {
            fragColor = vec4(outRgb, alpha);
        }
    }`;

    function hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        if (!result) return [1, 1, 1];
        return [
            parseInt(result[1], 16) / 255,
            parseInt(result[2], 16) / 255,
            parseInt(result[3], 16) / 255
        ];
    }

    function initWebThreads() {
        const canvas = document.getElementById("web-threads-canvas");
        if (!canvas) return;

        const gl = canvas.getContext("webgl2", {
            alpha: true,
            premultipliedAlpha: true,
            antialias: false,
            powerPreference: "high-performance"
        });

        if (!gl) {
            console.warn("WebGL2 not supported for WebThreads background");
            return;
        }

        // Compile vertex shader
        const vs = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vs, vertexShaderSrc);
        gl.compileShader(vs);
        if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
            console.error("VS error:", gl.getShaderInfoLog(vs));
            return;
        }

        // Compile fragment shader
        const fs = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fs, fragmentShaderSrc);
        gl.compileShader(fs);
        if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
            console.error("FS error:", gl.getShaderInfoLog(fs));
            return;
        }

        // Link program
        const program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error("Program link error:", gl.getProgramInfoLog(program));
            return;
        }

        gl.useProgram(program);

        // Fullscreen single triangle covering [-1, -1] to [3, -1] and [-1, 3]
        const vertices = new Float32Array([
            -1.0, -1.0,
             3.0, -1.0,
            -1.0,  3.0
        ]);

        const vbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

        const posLoc = gl.getAttribLocation(program, "position");
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

        // Uniform locations cache
        const u = {
            iResolution: gl.getUniformLocation(program, "iResolution"),
            iTime: gl.getUniformLocation(program, "iTime"),
            uSpeed: gl.getUniformLocation(program, "uSpeed"),
            uThreadCount: gl.getUniformLocation(program, "uThreadCount"),
            uFrequency: gl.getUniformLocation(program, "uFrequency"),
            uSpread: gl.getUniformLocation(program, "uSpread"),
            uTaper: gl.getUniformLocation(program, "uTaper"),
            uPosition: gl.getUniformLocation(program, "uPosition"),
            uFanMode: gl.getUniformLocation(program, "uFanMode"),
            uGlow: gl.getUniformLocation(program, "uGlow"),
            uFalloff: gl.getUniformLocation(program, "uFalloff"),
            uThickness: gl.getUniformLocation(program, "uThickness"),
            uBrightness: gl.getUniformLocation(program, "uBrightness"),
            uOpacity: gl.getUniformLocation(program, "uOpacity"),
            uMirror: gl.getUniformLocation(program, "uMirror"),
            uShimmer: gl.getUniformLocation(program, "uShimmer"),
            uGrain: gl.getUniformLocation(program, "uGrain"),
            uGrainIntensity: gl.getUniformLocation(program, "uGrainIntensity"),
            uColor1: gl.getUniformLocation(program, "uColor1"),
            uColor2: gl.getUniformLocation(program, "uColor2"),
            uColor3: gl.getUniformLocation(program, "uColor3"),
            uBackgroundColor: gl.getUniformLocation(program, "uBackgroundColor"),
            uLightMode: gl.getUniformLocation(program, "uLightMode"),
            uMouse: gl.getUniformLocation(program, "uMouse"),
            uMouseStrength: gl.getUniformLocation(program, "uMouseStrength"),
            uEnableMouse: gl.getUniformLocation(program, "uEnableMouse"),
            uMouseActive: gl.getUniformLocation(program, "uMouseActive")
        };

        // Default Config (matching user parameters)
        const config = {
            color1: "#5227FF",
            color2: "#FF9FFC",
            color3: "#FFFFFF",
            backgroundColor: "#060911",
            speed: 0.2,
            threadCount: 6.0,
            frequency: 5.0,
            spread: 0.18,
            taper: 1.0,
            position: 0.5,
            fanMode: 0.0, // center
            glow: 0.02,
            falloff: 0.6,
            thickness: 1.1,
            brightness: 0.65,
            opacity: 0.9,
            mirror: 1.0,
            shimmer: 0.0,
            grain: 1.0,
            grainIntensity: 0.05,
            lightMode: false,
            mouseStrength: 0.3,
            enableMouse: 1.0
        };

        // Static uniform initialization
        const c1 = hexToRgb(config.color1);
        const c2 = hexToRgb(config.color2);
        const c3 = hexToRgb(config.color3);
        const bg = hexToRgb(config.backgroundColor);

        gl.uniform3f(u.uColor1, c1[0], c1[1], c1[2]);
        gl.uniform3f(u.uColor2, c2[0], c2[1], c2[2]);
        gl.uniform3f(u.uColor3, c3[0], c3[1], c3[2]);
        gl.uniform3f(u.uBackgroundColor, bg[0], bg[1], bg[2]);

        gl.uniform1f(u.uSpeed, config.speed);
        gl.uniform1f(u.uThreadCount, config.threadCount);
        gl.uniform1f(u.uFrequency, config.frequency);
        gl.uniform1f(u.uSpread, config.spread);
        gl.uniform1f(u.uTaper, config.taper);
        gl.uniform1f(u.uPosition, config.position);
        gl.uniform1f(u.uFanMode, config.fanMode);
        gl.uniform1f(u.uGlow, config.glow);
        gl.uniform1f(u.uFalloff, config.falloff);
        gl.uniform1f(u.uThickness, config.thickness);
        gl.uniform1f(u.uBrightness, config.brightness);
        gl.uniform1f(u.uOpacity, config.opacity);
        gl.uniform1f(u.uMirror, config.mirror);
        gl.uniform1f(u.uShimmer, config.shimmer);
        gl.uniform1f(u.uGrain, config.grain);
        gl.uniform1f(u.uGrainIntensity, config.grainIntensity);
        gl.uniform1i(u.uLightMode, config.lightMode ? 1 : 0);
        gl.uniform1f(u.uMouseStrength, config.mouseStrength);
        gl.uniform1f(u.uEnableMouse, config.enableMouse);

        // Resize handler with devicePixelRatio support
        function resize() {
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const w = Math.floor(window.innerWidth * dpr);
            const h = Math.floor(window.innerHeight * dpr);
            if (canvas.width !== w || canvas.height !== h) {
                canvas.width = w;
                canvas.height = h;
                gl.viewport(0, 0, w, h);
                gl.uniform2f(u.iResolution, w, h);
            }
        }
        window.addEventListener("resize", resize);
        resize();

        // Mouse tracking across full window
        const currentMouse = [0.5, 0.5];
        const targetMouse = [0.5, 0.5];
        let currentActive = 0.0;
        let targetActive = 0.0;

        window.addEventListener("mousemove", function (e) {
            targetMouse[0] = e.clientX / window.innerWidth;
            targetMouse[1] = 1.0 - (e.clientY / window.innerHeight);
            targetActive = 1.0;
        });

        window.addEventListener("mouseenter", function () {
            targetActive = 1.0;
        });

        window.addEventListener("mouseleave", function () {
            targetActive = 0.0;
        });

        // Render loop
        let t0 = performance.now();
        let isPageVisible = !document.hidden;

        document.addEventListener("visibilitychange", function () {
            isPageVisible = !document.hidden;
        });

        function render(now) {
            if (isPageVisible) {
                const elapsedSec = (now - t0) * 0.001;
                gl.uniform1f(u.iTime, elapsedSec);

                // Smooth mouse interpolation
                currentMouse[0] += 0.05 * (targetMouse[0] - currentMouse[0]);
                currentMouse[1] += 0.05 * (targetMouse[1] - currentMouse[1]);
                currentActive += 0.05 * (targetActive - currentActive);

                gl.uniform2f(u.uMouse, currentMouse[0], currentMouse[1]);
                gl.uniform1f(u.uMouseActive, currentActive);

                gl.drawArrays(gl.TRIANGLES, 0, 3);
            }
            requestAnimationFrame(render);
        }

        requestAnimationFrame(render);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initWebThreads);
    } else {
        initWebThreads();
    }
})();
