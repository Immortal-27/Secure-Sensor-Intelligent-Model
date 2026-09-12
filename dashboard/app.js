/* ═══════════════════════════════════════════════════════════════════════════
   app.js — Quantum-Resilient IoT Telemetry Dashboard Client
   ═══════════════════════════════════════════════════════════════════════════
   High-frequency real-time WebSocket client (4 Hz), dynamic canvas sparklines,
   heat-map entropy spectrum, real-time trend analytics, tamper testing,
   and interactive ESP32 Hardware Link & Controller.
   Zero external libraries — pure Vanilla JS + Canvas API.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
    "use strict";

    /* ── Configuration ────────────────────────────────────────────────── */
    const WS_URL = `ws://${window.location.host}/ws/telemetry`;
    const API_BASE = `${window.location.origin}/api`;
    const MAX_SPARKLINE_POINTS = 50;
    const RECONNECT_BASE_MS = 1000;
    const RECONNECT_MAX_MS = 10000;
    const MAX_LOG = 50;

    /* ── State ────────────────────────────────────────────────────────── */
    let ws = null;
    let reconnectAttempts = 0;
    let packetCount = 0;
    const sparklineData = {}; /* channelIndex -> { raw: [], prevVal: null } */
    const logEntries = [];
    let frameTimestamps = [];
    let startTime = Date.now();
    let lastEntropyFetchTime = 0;
    let entropyFetchPending = false;

    let activeLabels = [
        "Temperature", "Humidity", "Pressure", "Light",
        "CO₂", "Vibration", "Voltage", "Current"
    ];
    let activeUnits = ["°C", "%RH", "hPa", "lux", "ppm", "g", "V", "A"];
    let isHardwareActive = false;

    /* Integrity tracking */
    let integrityCheckCount = 0;
    let integrityFailCount = 0;
    let tamperArmed = false;
    let lastIntegrityState = "VERIFIED";

    /* ── DOM References ───────────────────────────────────────────────── */
    const dom = {
        // Header
        statusDot: document.getElementById("status-dot"),
        statusText: document.getElementById("status-text"),
        sourceBadge: document.getElementById("source-badge"),
        packetBadge: document.getElementById("packet-count"),
        rateBadge: document.getElementById("rate-badge"),
        uptimeBadge: document.getElementById("uptime-badge"),
        utcClock: document.getElementById("live-utc-clock"),

        // ESP32 Hardware Link Panel
        espPanel: document.getElementById("esp-control-panel"),
        espStatusLight: document.getElementById("esp-status-light"),
        espLinkStatus: document.getElementById("esp-link-status"),
        espActivePort: document.getElementById("esp-active-port"),
        espActiveBaud: document.getElementById("esp-active-baud"),
        espHwPkts: document.getElementById("esp-hw-pkts"),
        espPortSelect: document.getElementById("esp-port-select"),
        espBaudSelect: document.getElementById("esp-baud-select"),
        btnScanPorts: document.getElementById("btn-scan-ports"),
        btnConnectEsp: document.getElementById("btn-connect-esp"),
        btnDisconnectEsp: document.getElementById("btn-disconnect-esp"),
        btnAutoConnect: document.getElementById("btn-auto-connect"),
        espConsoleMsg: document.getElementById("esp-console-msg"),

        // Telemetry Panels
        channelGrid: document.getElementById("channel-grid"),
        hmacOriginal: document.getElementById("hmac-original"),
        hmacRecomputed: document.getElementById("hmac-recomputed"),
        integrityBadge: document.getElementById("integrity-badge"),
        integrityPanel: document.getElementById("integrity-panel"),
        tamperBtn: document.getElementById("tamper-btn"),
        hmacMatchIndicator: document.getElementById("hmac-match-indicator"),
        matchIcon: document.getElementById("match-icon"),
        matchText: document.getElementById("match-text"),
        integrityCheckCount: document.getElementById("integrity-check-count"),
        integrityFailCount: document.getElementById("integrity-fail-count"),
        tamperLogEntries: document.getElementById("tamper-log-entries"),
        entropyShannon: document.getElementById("entropy-shannon"),
        entropyChi: document.getElementById("entropy-chi"),
        entropyMin: document.getElementById("entropy-min"),
        entropyCanvas: document.getElementById("entropy-canvas"),
        mathFormula: document.getElementById("math-live"),
        logBody: document.getElementById("log-body"),
    };

    /* ── Initialization ───────────────────────────────────────────────── */
    function init() {
        buildChannelCards();
        connectWebSocket();
        startUtcClock();
        initEspControls();
        scanSerialPorts();

        if (dom.tamperBtn) {
            dom.tamperBtn.addEventListener("click", triggerTamper);
        }
    }

    /* ── Live UTC Clock ───────────────────────────────────────────────── */
    function startUtcClock() {
        function tick() {
            const now = new Date();
            const h = String(now.getUTCHours()).padStart(2, "0");
            const m = String(now.getUTCMinutes()).padStart(2, "0");
            const s = String(now.getUTCSeconds()).padStart(2, "0");
            const ms = String(Math.floor(now.getUTCMilliseconds() / 100));
            if (dom.utcClock) {
                dom.utcClock.textContent = `${h}:${m}:${s}.${ms}`;
            }
        }
        tick();
        setInterval(tick, 100);
    }

    function formatUptime(seconds) {
        if (!isFinite(seconds) || seconds < 0) return "00:00";
        const s = Math.floor(seconds);
        const hrs = Math.floor(s / 3600);
        const mins = Math.floor((s % 3600) / 60);
        const secs = s % 60;
        if (hrs > 0) {
            return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
        }
        return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    }

    /* ── ESP32 Hardware Link Controls ─────────────────────────────────── */
    function initEspControls() {
        if (dom.btnScanPorts) {
            dom.btnScanPorts.addEventListener("click", function () {
                scanSerialPorts(false);
            });
        }

        if (dom.btnConnectEsp) {
            dom.btnConnectEsp.addEventListener("click", connectEsp);
        }

        if (dom.btnDisconnectEsp) {
            dom.btnDisconnectEsp.addEventListener("click", disconnectEsp);
        }

        if (dom.btnAutoConnect) {
            dom.btnAutoConnect.addEventListener("click", autoConnectEsp);
        }
    }

    function setEspConsole(msg, isError) {
        if (dom.espConsoleMsg) {
            dom.espConsoleMsg.textContent = msg;
            dom.espConsoleMsg.style.color = isError ? "#f87171" : "var(--text-secondary)";
        }
    }

    function scanSerialPorts(silent) {
        if (!dom.espPortSelect) return;
        if (!silent) setEspConsole("Scanning serial ports for ESP32 devices…", false);

        fetch(`${API_BASE}/ports`)
            .then(function (r) { return r.json(); })
            .then(function (data) {
                const ports = data.ports || [];
                dom.espPortSelect.innerHTML = "";

                if (ports.length === 0) {
                    const opt = document.createElement("option");
                    opt.value = "";
                    opt.textContent = "NO SERIAL PORTS DETECTED";
                    dom.espPortSelect.appendChild(opt);
                    if (!silent) setEspConsole("No active serial ports found. Plug in ESP32 via USB and click [ SCAN ].", false);
                    return;
                }

                let autoSelected = false;
                ports.forEach(function (p) {
                    const opt = document.createElement("option");
                    opt.value = p.device;
                    const tag = p.is_esp ? " [ESP32]" : "";
                    opt.textContent = `${p.device} — ${p.description}${tag}`;
                    if (p.is_esp && !autoSelected) {
                        opt.selected = true;
                        autoSelected = true;
                    }
                    dom.espPortSelect.appendChild(opt);
                });

                if (!autoSelected && ports.length > 0) {
                    dom.espPortSelect.options[0].selected = true;
                }

                if (!silent) {
                    const espCount = ports.filter(function (p) { return p.is_esp; }).length;
                    setEspConsole(`Found ${ports.length} serial port(s). ${espCount ? "ESP32 candidate identified." : "Select port and connect."}`, false);
                }
            })
            .catch(function (err) {
                if (!silent) setEspConsole(`Port scan failed: ${err.message}`, true);
            });
    }

    function connectEsp() {
        const port = dom.espPortSelect ? dom.espPortSelect.value : "";
        const baud = dom.espBaudSelect ? parseInt(dom.espBaudSelect.value, 10) : 115200;

        if (!port) {
            setEspConsole("Please select a valid COM port to connect.", true);
            return;
        }

        if (dom.btnConnectEsp) {
            dom.btnConnectEsp.disabled = true;
            dom.btnConnectEsp.innerHTML = '<span class="hud-bracket">[</span> CONNECTING… <span class="hud-bracket">]</span>';
        }
        setEspConsole(`Attempting connection to ${port} @ ${baud} baud…`, false);

        fetch(`${API_BASE}/connect_esp`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ port: port, baud: baud }),
        })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.success) {
                    setEspConsole(`✓ ${data.message}`, false);
                    syncHardwareStateUI(data.info || { connected: true, port: port, baud: baud });
                } else {
                    setEspConsole(`✗ ${data.message}`, true);
                    syncHardwareStateUI(data.info || { connected: false });
                }
            })
            .catch(function (err) {
                setEspConsole(`Connection error: ${err.message}`, true);
            })
            .finally(function () {
                if (dom.btnConnectEsp) {
                    dom.btnConnectEsp.disabled = false;
                    dom.btnConnectEsp.innerHTML = '<span class="hud-bracket">[</span> CONNECT ESP32 <span class="hud-bracket">]</span>';
                }
            });
    }

    function disconnectEsp() {
        if (dom.btnDisconnectEsp) {
            dom.btnDisconnectEsp.disabled = true;
            dom.btnDisconnectEsp.innerHTML = '<span class="hud-bracket">[</span> DISCONNECTING… <span class="hud-bracket">]</span>';
        }

        fetch(`${API_BASE}/disconnect_esp`, { method: "POST" })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                setEspConsole("Disconnected from hardware. Reverted to Simulator source.", false);
                syncHardwareStateUI(data.info || { connected: false });
            })
            .catch(function (err) {
                setEspConsole(`Disconnect error: ${err.message}`, true);
            })
            .finally(function () {
                if (dom.btnDisconnectEsp) {
                    dom.btnDisconnectEsp.disabled = false;
                    dom.btnDisconnectEsp.innerHTML = '<span class="hud-bracket">[</span> DISCONNECT <span class="hud-bracket">]</span>';
                }
            });
    }

    function autoConnectEsp() {
        if (dom.btnAutoConnect) {
            dom.btnAutoConnect.disabled = true;
            dom.btnAutoConnect.innerHTML = '<span class="hud-bracket">[</span> SCANNING… <span class="hud-bracket">]</span>';
        }
        setEspConsole("Auto-detecting ESP32 hardware…", false);

        fetch(`${API_BASE}/connect_esp`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
        })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.success) {
                    setEspConsole(`✓ Auto-link successful: ${data.message}`, false);
                    syncHardwareStateUI(data.info || { connected: true });
                } else {
                    setEspConsole(`Notice: ${data.message}`, false);
                    syncHardwareStateUI(data.info || { connected: false });
                }
            })
            .catch(function (err) {
                setEspConsole(`Auto-connect error: ${err.message}`, true);
            })
            .finally(function () {
                if (dom.btnAutoConnect) {
                    dom.btnAutoConnect.disabled = false;
                    dom.btnAutoConnect.innerHTML = '<span class="hud-bracket">[</span> AUTO-LINK <span class="hud-bracket">]</span>';
                }
            });
    }

    function syncHardwareStateUI(info) {
        if (!info) return;
        isHardwareActive = !!info.connected;

        if (dom.espLinkStatus) {
            dom.espLinkStatus.textContent = isHardwareActive
                ? `HARDWARE LINKED (${info.port || "USB"})`
                : "SIMULATOR ACTIVE";
        }

        if (dom.espStatusLight) {
            dom.espStatusLight.className = "esp-status-light " + (isHardwareActive ? "connected" : "disconnected");
        }

        if (dom.espPanel) {
            if (isHardwareActive) {
                dom.espPanel.classList.add("hardware-active");
            } else {
                dom.espPanel.classList.remove("hardware-active");
            }
        }

        if (dom.espActivePort) {
            dom.espActivePort.textContent = info.port || "—";
        }

        if (dom.espActiveBaud && info.baud) {
            dom.espActiveBaud.textContent = String(info.baud);
        }

        if (dom.espHwPkts && info.packets_read !== undefined) {
            dom.espHwPkts.textContent = String(info.packets_read);
        }

        if (dom.btnConnectEsp && dom.btnDisconnectEsp) {
            if (isHardwareActive) {
                dom.btnConnectEsp.style.display = "none";
                dom.btnDisconnectEsp.style.display = "inline-flex";
            } else {
                dom.btnConnectEsp.style.display = "inline-flex";
                dom.btnDisconnectEsp.style.display = "none";
            }
        }
    }

    /* ── Channel Cards ────────────────────────────────────────────────── */
    function buildChannelCards() {
        dom.channelGrid.innerHTML = "";
        for (let i = 0; i < 8; i++) {
            sparklineData[i] = { raw: [], prevVal: null };
            const card = document.createElement("div");
            card.className = "glass-card channel-card fade-in";
            card.style.animationDelay = `${i * 30}ms`;
            card.id = `channel-${i}`;
            const label = (activeLabels[i] || `CH 0${i + 1}`).toUpperCase();
            card.innerHTML = `
                <div class="channel-header">
                    <span class="channel-name" id="ch-title-${i}">
                        <span class="hud-bracket">[</span> ▪ 0${i + 1} : ${label} <span class="hud-bracket">]</span>
                    </span>
                    <div class="channel-header-right">
                        <span class="channel-trend neutral" id="ch-trend-${i}">▪ 0.00</span>
                        <span class="channel-status-dot" id="ch-dot-${i}"></span>
                    </div>
                </div>
                <div class="channel-data-row">
                    <span class="data-label">[ RAW ]</span>
                    <span class="data-value highlight display-val" id="ch-raw-${i}">—</span>
                </div>
                <div class="channel-data-row">
                    <span class="data-label">[ QUANT ]</span>
                    <span class="data-value" id="ch-quant-${i}">—</span>
                </div>
                <div class="channel-data-row">
                    <span class="data-label">[ CIPHER ]</span>
                    <span class="data-value encrypted" id="ch-cipher-${i}">—</span>
                </div>
                <div class="sparkline-container">
                    <canvas id="sparkline-${i}" width="280" height="36"></canvas>
                </div>
            `;
            dom.channelGrid.appendChild(card);
        }
    }

    function updateChannelLabels(newLabels, newUnits) {
        if (!newLabels || !Array.isArray(newLabels)) return;
        let changed = false;
        for (let i = 0; i < Math.min(newLabels.length, 8); i++) {
            if (activeLabels[i] !== newLabels[i]) {
                activeLabels[i] = newLabels[i];
                changed = true;
            }
        }
        if (newUnits && Array.isArray(newUnits)) {
            for (let i = 0; i < Math.min(newUnits.length, 8); i++) {
                activeUnits[i] = newUnits[i];
            }
        }
        if (changed) {
            for (let i = 0; i < 8; i++) {
                const titleEl = document.getElementById(`ch-title-${i}`);
                if (titleEl) {
                    titleEl.innerHTML = `<span class="hud-bracket">[</span> ▪ 0${i + 1} : ${activeLabels[i].toUpperCase()} <span class="hud-bracket">]</span>`;
                }
            }
        }
    }

    /* ── WebSocket Connection ─────────────────────────────────────────── */
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
            RECONNECT_BASE_MS * Math.pow(1.3, reconnectAttempts),
            RECONNECT_MAX_MS
        );
        reconnectAttempts++;
        setTimeout(connectWebSocket, delay);
    }

    function setConnectionStatus(state) {
        if (dom.statusDot) dom.statusDot.className = "status-dot " + state;
        const labels = {
            connected: "LIVE",
            disconnected: "OFFLINE",
            connecting: "SYNCING…",
        };
        if (dom.statusText) dom.statusText.textContent = labels[state] || state.toUpperCase();
    }

    /* ── Frame Handler ─────────────────────────────────────────────────── */
    function handleTelemetryFrame(data) {
        packetCount++;

        /* Compute real-time frame rate */
        const now = performance.now();
        frameTimestamps.push(now);
        frameTimestamps = frameTimestamps.filter(t => now - t <= 2000);
        if (frameTimestamps.length > 1 && dom.rateBadge) {
            const elapsedSec = (now - frameTimestamps[0]) / 1000;
            const hz = (frameTimestamps.length - 1) / Math.max(elapsedSec, 0.1);
            dom.rateBadge.textContent = `${hz.toFixed(1)} Hz`;
        }

        /* Update header badges */
        if (dom.sourceBadge) {
            dom.sourceBadge.textContent = (data.source || "SIMULATOR").toUpperCase();
        }
        if (dom.packetBadge) {
            dom.packetBadge.textContent = String(data.packet_id || packetCount);
        }

        if (dom.uptimeBadge) {
            const uptime = data.uptime_seconds !== undefined
                ? data.uptime_seconds
                : (Date.now() - startTime) / 1000;
            dom.uptimeBadge.textContent = formatUptime(uptime);
        }

        /* Sync hardware link status */
        if (data.hardware_status) {
            syncHardwareStateUI(data.hardware_status);
        }

        /* Dynamic labels / units */
        if (data.channel_labels) {
            updateChannelLabels(data.channel_labels, data.channel_units);
        }

        /* Channel cards */
        for (let i = 0; i < 8; i++) {
            updateChannelCard(i, data);
        }

        /* Integrity panel */
        updateIntegrityPanel(data);

        /* Entropy panel (throttled) */
        if (data.entropy_metrics) {
            updateEntropyPanel(data.entropy_metrics);
        }

        /* Transformation example */
        updateMathShowcase(data);

        /* Packet Log */
        addLogEntry(data);
    }

    function updateChannelCard(i, data) {
        const rawEl = document.getElementById(`ch-raw-${i}`);
        const quantEl = document.getElementById(`ch-quant-${i}`);
        const cipherEl = document.getElementById(`ch-cipher-${i}`);
        const dotEl = document.getElementById(`ch-dot-${i}`);
        const trendEl = document.getElementById(`ch-trend-${i}`);

        if (!rawEl || !quantEl || !cipherEl) return;

        const raw = (data.raw_values && data.raw_values[i] !== undefined && isFinite(data.raw_values[i]))
            ? Number(data.raw_values[i])
            : null;

        const quant = (data.quantized && data.quantized[i] !== undefined && isFinite(data.quantized[i]))
            ? Number(data.quantized[i])
            : null;

        const cipher = (data.ciphertext && data.ciphertext[i] !== undefined && isFinite(data.ciphertext[i]))
            ? Number(data.ciphertext[i])
            : null;

        const unit = activeUnits[i] || "";

        /* Format Raw Value cleanly */
        if (raw !== null) {
            const decimals = (unit === "ADC" || Math.abs(raw) >= 100) ? 1 : 2;
            rawEl.textContent = `${raw.toFixed(decimals)} ${unit}`;
            flashElement(rawEl);

            /* Dynamic Trend Calculation */
            if (sparklineData[i].prevVal !== null && trendEl) {
                let delta = raw - sparklineData[i].prevVal;
                if (!isFinite(delta) || Math.abs(delta) < 0.01) {
                    trendEl.textContent = "▪ 0.00";
                    trendEl.className = "channel-trend neutral";
                } else if (delta > 0) {
                    trendEl.textContent = `▲ +${delta.toFixed(decimals)}`;
                    trendEl.className = "channel-trend up";
                } else {
                    trendEl.textContent = `▼ ${delta.toFixed(decimals)}`;
                    trendEl.className = "channel-trend down";
                }
            }
            sparklineData[i].prevVal = raw;
        } else {
            rawEl.textContent = "—";
        }

        /* Quantized */
        quantEl.textContent = (quant !== null) ? String(quant) : "—";

        /* Cipher */
        if (cipher !== null) {
            const hex = cipher.toString(16).toUpperCase().padStart(2, "0");
            cipherEl.textContent = `0x${hex} (${cipher})`;
        } else {
            cipherEl.textContent = "—";
        }

        /* Status dot */
        if (dotEl) {
            const isOk = data.integrity === "VERIFIED";
            dotEl.className = "channel-status-dot" + (isOk ? "" : " fail");
        }

        /* Sparkline buffer & redraw */
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
        void el.offsetWidth;
        el.classList.add("value-flash");
    }

    /* ── Format Hex String ────────────────────────────────────────────── */
    function formatHex(hex) {
        if (!hex || typeof hex !== "string") return "—";
        if (hex.length >= 32) {
            const front = hex.substring(0, 16).match(/.{1,4}/g).join(" ");
            const back = hex.substring(hex.length - 16).match(/.{1,4}/g).join(" ");
            return `${front} … ${back}`;
        }
        const chunks = hex.match(/.{1,4}/g);
        return chunks ? chunks.join(" ") : hex;
    }

    /* ── Integrity Panel (Fully Dynamic) ──────────────────────────────── */
    function updateIntegrityPanel(data) {
        /* Update HMAC hash displays */
        if (dom.hmacOriginal) dom.hmacOriginal.textContent = formatHex(data.hmac_original);
        if (dom.hmacRecomputed) dom.hmacRecomputed.textContent = formatHex(data.hmac_recomputed);

        const verified = data.integrity === "VERIFIED";

        /* Increment check counter */
        integrityCheckCount++;
        if (dom.integrityCheckCount) dom.integrityCheckCount.textContent = integrityCheckCount;

        /* HMAC Match Indicator */
        if (dom.hmacMatchIndicator) {
            if (verified) {
                dom.hmacMatchIndicator.className = "hmac-match-indicator matched";
                if (dom.matchIcon) dom.matchIcon.textContent = "═";
                if (dom.matchText) dom.matchText.textContent = "HASHES MATCH — INTEGRITY VERIFIED";
            } else {
                dom.hmacMatchIndicator.className = "hmac-match-indicator mismatched";
                if (dom.matchIcon) dom.matchIcon.textContent = "✗";
                if (dom.matchText) dom.matchText.textContent = "HASH MISMATCH — INTEGRITY VIOLATION DETECTED";
            }
        }

        /* HMAC value highlighting on mismatch */
        if (dom.hmacOriginal) {
            dom.hmacOriginal.classList.toggle("mismatch", !verified);
        }
        if (dom.hmacRecomputed) {
            dom.hmacRecomputed.classList.toggle("mismatch", !verified);
        }

        /* Integrity Badge */
        if (dom.integrityBadge) {
            dom.integrityBadge.textContent = verified ? "[ ✓ VERIFIED ]" : "[ ✗ INTEGRITY VIOLATION ]";
            dom.integrityBadge.className = "integrity-badge " + (verified ? "verified" : "failed");

            if (!verified) {
                dom.integrityBadge.style.animation = "none";
                void dom.integrityBadge.offsetWidth;
                dom.integrityBadge.style.animation = "";
            }
        }

        /* Panel border flash on violation */
        if (dom.integrityPanel) {
            if (!verified) {
                dom.integrityPanel.classList.add("violation");
                setTimeout(function () {
                    dom.integrityPanel.classList.remove("violation");
                }, 3000);
            } else {
                dom.integrityPanel.classList.remove("violation");
            }
        }

        /* Track failures and log tamper events */
        if (!verified && lastIntegrityState === "VERIFIED") {
            integrityFailCount++;
            if (dom.integrityFailCount) dom.integrityFailCount.textContent = integrityFailCount;
            addTamperLogEntry(data);
        }

        /* Reset tamper armed state after violation is detected */
        if (!verified && tamperArmed) {
            tamperArmed = false;
            if (dom.tamperBtn) {
                dom.tamperBtn.innerHTML = '<span class="hud-bracket">[</span> VIOLATION DETECTED <span class="hud-bracket">]</span>';
                setTimeout(function () {
                    dom.tamperBtn.disabled = false;
                    dom.tamperBtn.innerHTML = '<span class="hud-bracket">[</span> TAMPER TEST <span class="hud-bracket">]</span>';
                }, 2500);
            }
        }

        lastIntegrityState = data.integrity;
    }

    /* ── Tamper Event Log ─────────────────────────────────────────────── */
    function addTamperLogEntry(data) {
        if (!dom.tamperLogEntries) return;

        /* Clear the "no events" placeholder */
        const emptyMsg = dom.tamperLogEntries.querySelector(".tamper-log-empty");
        if (emptyMsg) emptyMsg.remove();

        /* Build timestamp */
        let ts = "—";
        if (data.timestamp) {
            const timePart = data.timestamp.split("T")[1];
            if (timePart) {
                ts = timePart.split("Z")[0].split("+")[0].substring(0, 8);
            }
        }

        /* Build detail string */
        let detail = "HMAC integrity violation — ciphertext corrupted";
        if (data.tampered_channel !== undefined) {
            const chLabel = activeLabels[data.tampered_channel] || ("CH" + data.tampered_channel);
            detail = `Tampered CH${data.tampered_channel} (${chLabel}) — HMAC mismatch detected`;
        }

        const entry = document.createElement("div");
        entry.className = "tamper-log-entry";
        entry.innerHTML =
            `<span class="log-time">${ts}</span>` +
            `<span class="log-detail">[ALERT] ${detail}</span>`;

        dom.tamperLogEntries.insertBefore(entry, dom.tamperLogEntries.firstChild);

        /* Cap log entries at 10 */
        while (dom.tamperLogEntries.children.length > 10) {
            dom.tamperLogEntries.removeChild(dom.tamperLogEntries.lastChild);
        }
    }

    /* ── Entropy Panel (Throttled) ────────────────────────────────────── */
    function updateEntropyPanel(metrics) {
        if (dom.entropyShannon) {
            dom.entropyShannon.textContent = (metrics.shannon !== undefined && isFinite(metrics.shannon))
                ? metrics.shannon.toFixed(2) : "—";
        }
        if (dom.entropyChi) {
            dom.entropyChi.textContent = (metrics.chi_squared !== undefined && isFinite(metrics.chi_squared))
                ? metrics.chi_squared.toFixed(4) : "—";
        }
        if (dom.entropyMin) {
            dom.entropyMin.textContent = (metrics.min_entropy !== undefined && isFinite(metrics.min_entropy))
                ? metrics.min_entropy.toFixed(2) : "—";
        }

        const now = Date.now();
        if (now - lastEntropyFetchTime >= 2000) {
            lastEntropyFetchTime = now;
            fetchEntropyDistribution();
        }
    }

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

    /* ── Transformation Example (Symbolic Variables Only) ────────────── */
    function updateMathShowcase(data) {
        if (!dom.mathFormula || !data.quantized || !data.pad_used || !data.ciphertext) return;

        const chName = (activeLabels[0] || "TEMPERATURE").toUpperCase();

        dom.mathFormula.innerHTML =
            `<span class="hud-bracket">[</span> <strong>EXAMPLE // CH0 (${chName})</strong> <span class="hud-bracket">]</span> &nbsp;&nbsp;` +
            `<span class="highlight">C</span> = (<span class="var">x</span> + <span class="var">K</span>) mod <span class="var">N</span> &nbsp;&nbsp;` +
            `<span class="op">where</span> &nbsp;` +
            `<span class="var">x</span> = quantized plaintext, &nbsp;` +
            `<span class="var">K</span> = OTP key (random pad), &nbsp;` +
            `<span class="var">N</span> = prime modulus, &nbsp;` +
            `<span class="highlight">C</span> = ciphertext`;
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

        /* Draw faint center grid line */
        ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, h / 2);
        ctx.lineTo(w, h / 2);
        ctx.stroke();

        if (data.length < 2) return;

        let min = Infinity, max = -Infinity;
        for (let i = 0; i < data.length; i++) {
            if (data[i] < min) min = data[i];
            if (data[i] > max) max = data[i];
        }
        const range = max - min || 1;
        const padding = 4;

        /* Gradient fill */
        const gradient = ctx.createLinearGradient(0, 0, 0, h);
        gradient.addColorStop(0, "rgba(245, 158, 11, 0.35)");
        gradient.addColorStop(1, "rgba(245, 158, 11, 0.01)");

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

        /* Line stroke */
        ctx.beginPath();
        for (let i = 0; i < data.length; i++) {
            const x = (i / (data.length - 1)) * w;
            const y = h - padding - ((data[i] - min) / range) * (h - 2 * padding);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = "#f59e0b";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        /* Current point */
        const lastX = w;
        const lastY = h - padding - ((data[data.length - 1] - min) / range) * (h - 2 * padding);
        ctx.beginPath();
        ctx.arc(lastX - 2, lastY, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.shadowColor = "#f59e0b";
        ctx.shadowBlur = 6;
        ctx.fill();
        ctx.shadowBlur = 0;
    }

    /* ── Entropy Histogram ────────────────────────────────────────────── */
    function drawEntropyHistogram(distribution) {
        const canvas = dom.entropyCanvas;
        if (!canvas) return;

        const ctx = canvas.getContext("2d");
        const w = canvas.width;
        const h = canvas.height;

        ctx.clearRect(0, 0, w, h);

        /* Draw subtle horizontal grid lines */
        ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
        ctx.lineWidth = 1;
        for (let y = 20; y < h; y += 20) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
        }

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

        /* Heat-map gradient bars */
        for (let i = 0; i < displayBins.length; i++) {
            const barHeight = (displayBins[i] / maxVal) * (h - 6);
            const x = i * barWidth;
            const y = h - barHeight - 2;

            const barGrad = ctx.createLinearGradient(0, h, 0, y);
            barGrad.addColorStop(0, "#fde047");
            barGrad.addColorStop(0.5, "#f97316");
            barGrad.addColorStop(1, "#ef4444");

            ctx.fillStyle = barGrad;
            ctx.fillRect(x, y, Math.max(barWidth - 0.8, 1), barHeight);
        }

        /* Baseline */
        ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, h - 2);
        ctx.lineTo(w, h - 2);
        ctx.stroke();
    }

    /* ── Real-Time Packet Log ─────────────────────────────────────────── */
    function addLogEntry(data) {
        if (!dom.logBody) return;
        logEntries.unshift(data);
        if (logEntries.length > MAX_LOG) logEntries.pop();

        const tbody = dom.logBody;
        const row = document.createElement("tr");
        row.className = "fade-in";

        let ts = "—";
        if (data.timestamp) {
            const timePart = data.timestamp.split("T")[1];
            if (timePart) {
                const parts = timePart.split("Z")[0].split("+")[0];
                ts = parts.substring(0, 11); /* HH:MM:SS.ms */
            }
        }
        const pid = data.packet_id || "—";
        const vals = data.raw_values || [];

        let summary = "Telemetry Frame";
        if (vals.length >= 4) {
            if (data.is_hardware) {
                // Hardware specific reading summary (Temp, Hum, Distance, MQ3)
                summary = `${Number(vals[0]).toFixed(1)}°C · ${Number(vals[1]).toFixed(0)}% · ${Number(vals[2]).toFixed(1)}cm · MQ3:${Number(vals[3]).toFixed(0)}`;
            } else {
                summary = `${Number(vals[0]).toFixed(1)}°C · ${Number(vals[1]).toFixed(0)}% · ${Number(vals[2]).toFixed(0)}hPa · ${Number(vals[6]).toFixed(1)}V`;
            }
        }

        const integrity = data.integrity || "—";
        const integrityClass = integrity === "VERIFIED" ? "integrity-verified" : "integrity-failed";

        row.innerHTML =
            `<td>${ts}</td>` +
            `<td>#${pid}</td>` +
            `<td class="reading-tag">${summary}</td>` +
            `<td class="cipher-tag">8 Channels Encrypted (Z₂₅₇)</td>` +
            `<td class="${integrityClass}">[ ${integrity} ]</td>`;

        tbody.insertBefore(row, tbody.firstChild);

        while (tbody.children.length > MAX_LOG) {
            tbody.removeChild(tbody.lastChild);
        }
    }

    /* ── Tamper Test ──────────────────────────────────────────────────── */
    function triggerTamper() {
        if (!dom.tamperBtn) return;
        dom.tamperBtn.disabled = true;
        tamperArmed = true;
        dom.tamperBtn.innerHTML = '<span class="hud-bracket">[</span> ARMING… <span class="hud-bracket">]</span>';

        fetch(API_BASE + "/tamper", { method: "POST" })
            .then(function (r) { return r.json(); })
            .then(function (result) {
                dom.tamperBtn.innerHTML = '<span class="hud-bracket">[</span> TAMPER ARMED — AWAITING NEXT FRAME <span class="hud-bracket">]</span>';

                /* If no violation detected within 8s, reset button */
                setTimeout(function () {
                    if (tamperArmed) {
                        tamperArmed = false;
                        dom.tamperBtn.disabled = false;
                        dom.tamperBtn.innerHTML = '<span class="hud-bracket">[</span> TAMPER TEST <span class="hud-bracket">]</span>';
                    }
                }, 8000);
            })
            .catch(function () {
                tamperArmed = false;
                dom.tamperBtn.disabled = false;
                dom.tamperBtn.innerHTML = '<span class="hud-bracket">[</span> FAILED — RETRY <span class="hud-bracket">]</span>';
                setTimeout(function () {
                    dom.tamperBtn.innerHTML = '<span class="hud-bracket">[</span> TAMPER TEST <span class="hud-bracket">]</span>';
                }, 2000);
            });
    }

    /* ── Boot ─────────────────────────────────────────────────────────── */
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
