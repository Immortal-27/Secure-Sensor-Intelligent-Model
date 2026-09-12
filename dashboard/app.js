/* ═══════════════════════════════════════════════════════════════════════════
   app.js — Quantum-Resilient IoT Telemetry Dashboard Client
   ═══════════════════════════════════════════════════════════════════════════
   WebSocket client with auto-reconnect, canvas sparklines, entropy histogram,
   live pipeline rendering, and tamper test functionality.
   Zero external libraries — pure Vanilla JS + Canvas API.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
    "use strict";

    /* ── Configuration ────────────────────────────────────────────────── */
    const WS_URL = `ws://${window.location.host}/ws/telemetry`;
    const API_BASE = `${window.location.origin}/api`;
    const MAX_SPARKLINE_POINTS = 40;
    const RECONNECT_BASE_MS = 1000;
    const RECONNECT_MAX_MS = 30000;

    /* ── State ────────────────────────────────────────────────────────── */
    let ws = null;
    let reconnectAttempts = 0;
    let packetCount = 0;
    const sparklineData = {}; /* channelIndex -> { raw: [], quantized: [] } */
    const logEntries = [];
    const MAX_LOG = 50;

    /* ── DOM References ───────────────────────────────────────────────── */
    const dom = {
        statusDot: document.getElementById("status-dot"),
        statusText: document.getElementById("status-text"),
        sourceBadge: document.getElementById("source-badge"),
        packetBadge: document.getElementById("packet-count"),
        channelGrid: document.getElementById("channel-grid"),
        hmacOriginal: document.getElementById("hmac-original"),
        hmacRecomputed: document.getElementById("hmac-recomputed"),
        integrityBadge: document.getElementById("integrity-badge"),
        tamperBtn: document.getElementById("tamper-btn"),
        entropyShannon: document.getElementById("entropy-shannon"),
        entropyChi: document.getElementById("entropy-chi"),
        entropyMin: document.getElementById("entropy-min"),
        entropyCanvas: document.getElementById("entropy-canvas"),
        mathFormula: document.getElementById("math-live"),
        logBody: document.getElementById("log-body"),
        pipelineSteps: document.querySelectorAll(".pipeline-step"),
    };

    /* ── Initialization ───────────────────────────────────────────────── */
    function init() {
        buildChannelCards();
        connectWebSocket();
        dom.tamperBtn.addEventListener("click", triggerTamper);
        animatePipelineLoop();
    }

    /* ── Channel Cards ────────────────────────────────────────────────── */
    const CHANNEL_LABELS = [
        "Temperature", "Humidity", "Pressure", "Light",
        "CO₂", "Vibration", "Voltage", "Current"
    ];
    const CHANNEL_UNITS = ["°C", "%RH", "hPa", "lux", "ppm", "g", "V", "A"];

    function buildChannelCards() {
        dom.channelGrid.innerHTML = "";
        for (let i = 0; i < 8; i++) {
            sparklineData[i] = { raw: [], quantized: [] };
            const card = document.createElement("div");
            card.className = "glass-card channel-card fade-in";
            card.style.animationDelay = `${i * 60}ms`;
            card.id = `channel-${i}`;
            card.innerHTML = `
                <div class="channel-header">
                    <span class="channel-name">${CHANNEL_LABELS[i]}</span>
                    <span class="channel-status-dot" id="ch-dot-${i}"></span>
                </div>
                <div class="channel-data-row">
                    <span class="data-label">Raw</span>
                    <span class="data-value highlight" id="ch-raw-${i}">—</span>
                </div>
                <div class="channel-data-row">
                    <span class="data-label">Quantized</span>
                    <span class="data-value" id="ch-quant-${i}">—</span>
                </div>
                <div class="channel-data-row">
                    <span class="data-label">Pad (K)</span>
                    <span class="data-value pad-val" id="ch-pad-${i}">—</span>
                </div>
                <div class="channel-data-row">
                    <span class="data-label">Cipher</span>
                    <span class="data-value encrypted" id="ch-cipher-${i}">—</span>
                </div>
                <div class="channel-data-row">
                    <span class="data-label">Decrypted</span>
                    <span class="data-value" id="ch-dec-${i}">—</span>
                </div>
                <div class="sparkline-container">
                    <canvas id="sparkline-${i}" width="280" height="32"></canvas>
                </div>
            `;
            dom.channelGrid.appendChild(card);
        }
    }

    /* ── WebSocket ─────────────────────────────────────────────────────── */
    function connectWebSocket() {
        setConnectionStatus("connecting");

        try {
            ws = new WebSocket(WS_URL);
        } catch (e) {
            scheduleReconnect();
            return;
        }

        ws.onopen = function () {
            reconnectAttempts = 0;
            setConnectionStatus("connected");
        };

        ws.onmessage = function (event) {
            try {
                const data = JSON.parse(event.data);
                if (data.type === "ping") return;
                handleTelemetryFrame(data);
            } catch (e) {
                console.warn("Failed to parse WS message:", e);
            }
        };

        ws.onclose = function () {
            setConnectionStatus("disconnected");
            scheduleReconnect();
        };

        ws.onerror = function () {
            setConnectionStatus("disconnected");
        };
    }

    function scheduleReconnect() {
        const delay = Math.min(
            RECONNECT_BASE_MS * Math.pow(1.5, reconnectAttempts),
            RECONNECT_MAX_MS
        );
        reconnectAttempts++;
        setTimeout(connectWebSocket, delay);
    }

    function setConnectionStatus(state) {
        dom.statusDot.className = "status-dot " + state;
        const labels = {
            connected: "Connected",
            disconnected: "Disconnected",
            connecting: "Connecting…",
        };
        dom.statusText.textContent = labels[state] || state;
    }

    /* ── Frame Handler ─────────────────────────────────────────────────── */
    function handleTelemetryFrame(data) {
        packetCount++;

        /* Header badges */
        dom.sourceBadge.textContent = data.source || "—";
        dom.packetBadge.textContent = `PKT #${data.packet_id || packetCount}`;

        /* Channel cards */
        for (let i = 0; i < 8; i++) {
            updateChannelCard(i, data);
        }

        /* Integrity panel */
        updateIntegrityPanel(data);

        /* Entropy panel */
        if (data.entropy_metrics) {
            updateEntropyPanel(data.entropy_metrics);
        }

        /* Math showcase */
        updateMathShowcase(data);

        /* Log */
        addLogEntry(data);

        /* Pipeline animation pulse */
        pulsePipeline();
    }

    function updateChannelCard(i, data) {
        const rawEl = document.getElementById(`ch-raw-${i}`);
        const quantEl = document.getElementById(`ch-quant-${i}`);
        const padEl = document.getElementById(`ch-pad-${i}`);
        const cipherEl = document.getElementById(`ch-cipher-${i}`);
        const decEl = document.getElementById(`ch-dec-${i}`);
        const dotEl = document.getElementById(`ch-dot-${i}`);

        const raw = data.raw_values ? data.raw_values[i] : null;
        const quant = data.quantized ? data.quantized[i] : null;
        const pad = data.pad_used ? data.pad_used[i] : null;
        const cipher = data.ciphertext ? data.ciphertext[i] : null;
        const dec = data.decrypted ? data.decrypted[i] : null;

        if (raw !== null) {
            rawEl.textContent = raw.toFixed(2) + " " + CHANNEL_UNITS[i];
            flashElement(rawEl);
        }
        if (quant !== null) quantEl.textContent = quant;
        if (pad !== null) padEl.textContent = pad;
        if (cipher !== null) cipherEl.textContent = cipher;
        if (dec !== null) decEl.textContent = dec;

        /* Status dot */
        const isOk = data.integrity === "VERIFIED";
        dotEl.className = "channel-status-dot" + (isOk ? "" : " fail");

        /* Sparkline data */
        if (raw !== null) {
            sparklineData[i].raw.push(raw);
            if (sparklineData[i].raw.length > MAX_SPARKLINE_POINTS) {
                sparklineData[i].raw.shift();
            }
            drawSparkline(i);
        }
    }

    function flashElement(el) {
        el.classList.remove("value-flash");
        void el.offsetWidth; /* Force reflow to restart animation */
        el.classList.add("value-flash");
    }

    /* ── Integrity Panel ──────────────────────────────────────────────── */
    function updateIntegrityPanel(data) {
        dom.hmacOriginal.textContent = data.hmac_original || "—";
        dom.hmacRecomputed.textContent = data.hmac_recomputed || "—";

        const verified = data.integrity === "VERIFIED";
        dom.integrityBadge.textContent = verified ? "✓ VERIFIED" : "✗ INTEGRITY VIOLATION";
        dom.integrityBadge.className = "integrity-badge " + (verified ? "verified" : "failed");

        if (!verified) {
            /* Re-trigger shake animation */
            dom.integrityBadge.style.animation = "none";
            void dom.integrityBadge.offsetWidth;
            dom.integrityBadge.style.animation = "";
        }
    }

    /* ── Entropy Panel ────────────────────────────────────────────────── */
    function updateEntropyPanel(metrics) {
        dom.entropyShannon.textContent = metrics.shannon !== undefined
            ? metrics.shannon.toFixed(2) : "—";
        dom.entropyChi.textContent = metrics.chi_squared !== undefined
            ? metrics.chi_squared.toFixed(4) : "—";
        dom.entropyMin.textContent = metrics.min_entropy !== undefined
            ? metrics.min_entropy.toFixed(2) : "—";

        fetchEntropyDistribution();
    }

    let entropyFetchPending = false;
    function fetchEntropyDistribution() {
        if (entropyFetchPending) return;
        entropyFetchPending = true;
        fetch(API_BASE + "/entropy")
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.distribution) {
                    drawEntropyHistogram(data.distribution);
                }
            })
            .catch(function () { })
            .finally(function () { entropyFetchPending = false; });
    }

    /* ── Math Showcase ────────────────────────────────────────────────── */
    function updateMathShowcase(data) {
        if (!data.quantized || !data.pad_used || !data.ciphertext || !data.decrypted) return;

        const i = 0; /* Show channel 0 as example */
        const x = data.quantized[i];
        const k = data.pad_used[i];
        const c = data.ciphertext[i];
        const d = data.decrypted[i];

        dom.mathFormula.innerHTML =
            `<strong>Encrypt (ch0):</strong> C = (<span class="var">x</span> + <span class="var">K</span>) mod <span class="num">257</span><br>` +
            `&nbsp;&nbsp;C = (<span class="num">${x}</span> + <span class="num">${k}</span>) mod <span class="num">257</span> = <span class="num">${c}</span><br><br>` +
            `<strong>Decrypt (ch0):</strong> x = (<span class="var">C</span> − <span class="var">K</span> + <span class="num">257</span>) mod <span class="num">257</span><br>` +
            `&nbsp;&nbsp;x = (<span class="num">${c}</span> − <span class="num">${k}</span> + <span class="num">257</span>) mod <span class="num">257</span> = <span class="num">${d}</span>`;
    }

    /* ── Sparkline Drawing ────────────────────────────────────────────── */
    function drawSparkline(channelIdx) {
        const canvas = document.getElementById(`sparkline-${channelIdx}`);
        if (!canvas) return;

        const ctx = canvas.getContext("2d");
        const data = sparklineData[channelIdx].raw;
        const w = canvas.width;
        const h = canvas.height;

        ctx.clearRect(0, 0, w, h);

        if (data.length < 2) return;

        /* Find range */
        let min = Infinity, max = -Infinity;
        for (let i = 0; i < data.length; i++) {
            if (data[i] < min) min = data[i];
            if (data[i] > max) max = data[i];
        }
        const range = max - min || 1;
        const padding = 3;

        /* Draw gradient fill */
        const gradient = ctx.createLinearGradient(0, 0, 0, h);
        gradient.addColorStop(0, "rgba(56, 189, 248, 0.25)");
        gradient.addColorStop(1, "rgba(56, 189, 248, 0.02)");

        ctx.beginPath();
        ctx.moveTo(0, h);
        for (let i = 0; i < data.length; i++) {
            const x = (i / (data.length - 1)) * w;
            const y = h - padding - ((data[i] - min) / range) * (h - 2 * padding);
            ctx.lineTo(x, y);
        }
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();

        /* Draw line */
        ctx.beginPath();
        for (let i = 0; i < data.length; i++) {
            const x = (i / (data.length - 1)) * w;
            const y = h - padding - ((data[i] - min) / range) * (h - 2 * padding);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = "#38bdf8";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        /* Draw latest point */
        const lastX = w;
        const lastY = h - padding - ((data[data.length - 1] - min) / range) * (h - 2 * padding);
        ctx.beginPath();
        ctx.arc(lastX - 1, lastY, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = "#38bdf8";
        ctx.fill();
    }

    /* ── Entropy Histogram ────────────────────────────────────────────── */
    function drawEntropyHistogram(distribution) {
        const canvas = dom.entropyCanvas;
        if (!canvas) return;

        const ctx = canvas.getContext("2d");
        const w = canvas.width;
        const h = canvas.height;

        ctx.clearRect(0, 0, w, h);

        /* We have 257 bins — downsample to fit canvas width */
        const numBins = distribution.length;
        const binsPerPixel = Math.max(1, Math.ceil(numBins / w));
        const displayBins = [];
        for (let i = 0; i < numBins; i += binsPerPixel) {
            let sum = 0;
            for (let j = i; j < Math.min(i + binsPerPixel, numBins); j++) {
                sum += distribution[j];
            }
            displayBins.push(sum);
        }

        const maxVal = Math.max.apply(null, displayBins) || 1;
        const barWidth = w / displayBins.length;

        /* Draw bars with gradient */
        for (let i = 0; i < displayBins.length; i++) {
            const barHeight = (displayBins[i] / maxVal) * (h - 4);
            const x = i * barWidth;
            const y = h - barHeight - 2;

            const hue = 180 + (i / displayBins.length) * 60;
            ctx.fillStyle = `hsla(${hue}, 80%, 60%, 0.7)`;
            ctx.fillRect(x, y, Math.max(barWidth - 0.5, 1), barHeight);
        }

        /* Draw baseline */
        ctx.strokeStyle = "rgba(148, 163, 184, 0.15)";
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(0, h - 2);
        ctx.lineTo(w, h - 2);
        ctx.stroke();
    }

    /* ── Log Table ────────────────────────────────────────────────────── */
    function addLogEntry(data) {
        logEntries.unshift(data);
        if (logEntries.length > MAX_LOG) logEntries.pop();

        /* Render — newest on top */
        const tbody = dom.logBody;
        const row = document.createElement("tr");
        row.className = "fade-in";

        const ts = data.timestamp ? data.timestamp.split("T")[1].split(".")[0] : "—";
        const pid = data.packet_id || "—";
        const quant = data.quantized ? data.quantized.join(",") : "—";
        const cipher = data.ciphertext ? data.ciphertext.join(",") : "—";
        const dec = data.decrypted ? data.decrypted.join(",") : "—";
        const integrity = data.integrity || "—";
        const integrityClass = integrity === "VERIFIED" ? "integrity-verified" : "integrity-failed";

        row.innerHTML =
            `<td>${ts}</td>` +
            `<td>${pid}</td>` +
            `<td>[${quant}]</td>` +
            `<td>[${cipher}]</td>` +
            `<td>[${dec}]</td>` +
            `<td class="${integrityClass}">${integrity}</td>`;

        tbody.insertBefore(row, tbody.firstChild);

        /* Trim excess rows */
        while (tbody.children.length > MAX_LOG) {
            tbody.removeChild(tbody.lastChild);
        }
    }

    /* ── Tamper Test ──────────────────────────────────────────────────── */
    function triggerTamper() {
        dom.tamperBtn.disabled = true;
        dom.tamperBtn.textContent = "⏳ Armed…";

        fetch(API_BASE + "/tamper", { method: "POST" })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                dom.tamperBtn.textContent = "⚡ Tamper Armed!";
                setTimeout(function () {
                    dom.tamperBtn.disabled = false;
                    dom.tamperBtn.textContent = "🔓 Tamper Test";
                }, 3000);
            })
            .catch(function () {
                dom.tamperBtn.disabled = false;
                dom.tamperBtn.textContent = "🔓 Tamper Test";
            });
    }

    /* ── Pipeline Animation ───────────────────────────────────────────── */
    let pipelineAnimIndex = 0;

    function animatePipelineLoop() {
        setInterval(function () {
            pipelineAnimIndex = (pipelineAnimIndex + 1) % dom.pipelineSteps.length;
            dom.pipelineSteps.forEach(function (step, i) {
                step.classList.toggle("active", i === pipelineAnimIndex);
            });
        }, 800);
    }

    function pulsePipeline() {
        /* Quick full-pipeline highlight on new data */
        dom.pipelineSteps.forEach(function (step, i) {
            setTimeout(function () {
                step.classList.add("active");
                setTimeout(function () { step.classList.remove("active"); }, 300);
            }, i * 80);
        });
    }

    /* ── Boot ─────────────────────────────────────────────────────────── */
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
