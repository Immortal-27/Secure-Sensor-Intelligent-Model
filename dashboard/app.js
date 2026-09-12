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
        "Temperature", "Distance", "MQ3 Alcohol", "MQ135 Air Qlt",
        "MQ9 CO/Gas", "MQ5 LPG Gas", "Acceleration", "Tilt Angle",
        "Lat / Lon GPS", "Atmos Pressure"
    ];
    let activeUnits = ["°C", "cm", "ADC", "ADC", "ADC", "ADC", "g", "°", "°N,°E", "hPa"];
    let isHardwareActive = false;
    let geoWeatherData = null;
    let geoWeatherInterval = null;

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
        signedTimestamp: document.getElementById("signed-timestamp"),
        timeVerifiedBadge: document.getElementById("time-verified-badge"),
        hmacOriginal: document.getElementById("hmac-original"),
        hmacRecomputed: document.getElementById("hmac-recomputed"),
        integrityBadge: document.getElementById("integrity-badge"),
        integrityPanel: document.getElementById("integrity-panel"),
        tamperBtn: document.getElementById("tamper-btn"),
        tamperTimeBtn: document.getElementById("tamper-time-btn"),
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
            dom.tamperBtn.addEventListener("click", function () {
                triggerTamper("data");
            });
        }
        if (dom.tamperTimeBtn) {
            dom.tamperTimeBtn.addEventListener("click", function () {
                triggerTamper("timestamp");
            });
        }

        /* Regular API calls for Geolocation (Lat/Lon) and Atmospheric Pressure */
        requestBrowserGps();
        fetchGeoWeatherAPI();
        if (!geoWeatherInterval) {
            geoWeatherInterval = setInterval(fetchGeoWeatherAPI, 15000);
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
        for (let i = 0; i < 10; i++) {
            sparklineData[i] = { raw: [], prevVal: null };
            const card = document.createElement("div");
            card.className = "glass-card channel-card fade-in" + (i >= 8 ? " api-topic-card" : "");
            card.style.animationDelay = `${i * 25}ms`;
            card.id = `channel-${i}`;
            const label = (activeLabels[i] || `CH ${(i + 1 < 10 ? "0" : "") + (i + 1)}`).toUpperCase();
            const numStr = (i + 1 < 10 ? "0" : "") + (i + 1);
            const isApi = i >= 8;
            const apiBadge = isApi
                ? `<span class="api-topic-badge" id="ch-api-badge-${i}">[ REGULAR API ]</span>`
                : "";

            card.innerHTML = `
                <div class="channel-header">
                    <span class="channel-name" id="ch-title-${i}">
                        <span class="hud-bracket">[</span> ▪ ${numStr} : ${label} <span class="hud-bracket">]</span>
                    </span>
                    <div class="channel-header-right">
                        ${apiBadge}
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
        for (let i = 0; i < Math.min(newLabels.length, 10); i++) {
            if (activeLabels[i] !== newLabels[i]) {
                activeLabels[i] = newLabels[i];
                changed = true;
            }
        }
        if (newUnits && Array.isArray(newUnits)) {
            for (let i = 0; i < Math.min(newUnits.length, 10); i++) {
                activeUnits[i] = newUnits[i];
            }
        }
        if (changed) {
            for (let i = 0; i < 10; i++) {
                const titleEl = document.getElementById(`ch-title-${i}`);
                if (titleEl) {
                    const numStr = (i + 1 < 10 ? "0" : "") + (i + 1);
                    titleEl.innerHTML = `<span class="hud-bracket">[</span> ▪ ${numStr} : ${activeLabels[i].toUpperCase()} <span class="hud-bracket">]</span>`;
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

        /* Detect DHT22 failure from scenario tag */
        const scenario = data.scenario || "";
        if (data.is_hardware && scenario.indexOf("DHT22 FAIL") !== -1) {
            if (dom.espConsoleMsg && !dom.espConsoleMsg._dhtWarnShown) {
                setEspConsole("⚠ DHT22 sensor failure — check wiring (data pin + 10kΩ pull-up). MQ & distance sensors active.", true);
                dom.espConsoleMsg._dhtWarnShown = true;
            }
        } else if (data.is_hardware && dom.espConsoleMsg && dom.espConsoleMsg._dhtWarnShown) {
            setEspConsole("✓ All sensors reporting — hardware streaming live.", false);
            dom.espConsoleMsg._dhtWarnShown = false;
        }

        /* Dynamic labels / units */
        if (data.channel_labels) {
            updateChannelLabels(data.channel_labels, data.channel_units);
        }

        /* Store geo_weather if provided in payload */
        if (data.geo_weather) {
            geoWeatherData = data.geo_weather;
            updateGeoWeatherBadges(data.geo_weather);
        }

        /* Channel cards (10 total: 8 physical/sim sensors + 2 regular API topics) */
        for (let i = 0; i < 10; i++) {
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
        const card = document.getElementById(`channel-${i}`);

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
        const scenario = data.scenario || "";
        const isDhtFail = data.is_hardware && scenario.indexOf("DHT22 FAIL") !== -1;

        /* Detect sensor failure states in hardware mode */
        let sensorFail = false;
        if (data.is_hardware && raw === 0.0) {
            /* CH0=Temperature, CH1=Humidity — DHT22 failure */
            if ((i === 0 || i === 1) && isDhtFail) {
                sensorFail = true;
            }
        }

        /* Visual indicator on the channel card for sensor failures */
        if (card) {
            if (sensorFail) {
                card.classList.add("sensor-fail");
            } else {
                card.classList.remove("sensor-fail");
            }
        }

        /* Format Raw Value cleanly */
        if (raw !== null) {
            if (sensorFail) {
                /* Show descriptive failure text for broken sensors */
                rawEl.textContent = "SENSOR N/A";
                rawEl.style.color = "#f87171";
            } else if (data.is_hardware && i === 1 && raw === 0.0) {
                /* HC-SR04: 0.00 means no echo received */
                rawEl.textContent = "0.0 cm (no echo)";
                rawEl.style.color = "#fbbf24";
            } else if (i === 8) {
                /* Channel 9: Latitude & Longitude (Regular API) */
                const gw = data.geo_weather || geoWeatherData;
                const latVal = typeof raw === "number" ? raw : (gw && (gw.live_latitude || gw.latitude) ? (gw.live_latitude || gw.latitude) : 0.0);
                const lonVal = (gw && (gw.live_longitude || gw.longitude)) ? (gw.live_longitude || gw.longitude) : 0.0;
                const latDir = latVal >= 0 ? "N" : "S";
                const lonDir = lonVal >= 0 ? "E" : "W";
                const locStr = (gw && gw.location_formatted && gw.location_formatted !== "Detecting...") ? gw.location_formatted : (gw && gw.city ? gw.city : "GPS LOCK");
                rawEl.innerHTML = `<span class="coord-primary">${Math.abs(latVal).toFixed(4)}° ${latDir}, ${Math.abs(lonVal).toFixed(4)}° ${lonDir}</span><span class="coord-loc">[ ${locStr} ]</span>`;
                rawEl.style.color = "";
            } else if (i === 9) {
                /* Channel 10: Atmospheric Pressure (Regular API) */
                const gw = data.geo_weather || geoWeatherData;
                const pressVal = typeof raw === "number" ? raw : (gw && gw.surface_pressure_hpa ? gw.surface_pressure_hpa : 1013.25);
                const mslVal = (gw && gw.pressure_msl_hpa) ? gw.pressure_msl_hpa : pressVal;
                rawEl.innerHTML = `<span class="pressure-primary">${pressVal.toFixed(2)} hPa</span><span class="pressure-sec">[ MSL: ${mslVal.toFixed(1)} hPa ]</span>`;
                rawEl.style.color = "";
            } else {
                let decimals = 1;
                if (unit === "ADC") decimals = 0;
                else if (unit === "g") decimals = 3;
                else if (unit === "°") decimals = 1;
                else if (unit === "°C") decimals = 1;
                else if (unit === "cm") decimals = 1;
                else if (Math.abs(raw) >= 100) decimals = 1;
                rawEl.textContent = `${raw.toFixed(decimals)} ${unit}`;
                rawEl.style.color = "";
            }
            flashElement(rawEl);

            /* Dynamic Trend Calculation */
            if (sparklineData[i].prevVal !== null && trendEl) {
                let delta = raw - sparklineData[i].prevVal;
                if (!isFinite(delta) || Math.abs(delta) < 0.01) {
                    trendEl.textContent = sensorFail ? "▪ N/A" : "▪ 0.00";
                    trendEl.className = "channel-trend neutral";
                } else if (delta > 0) {
                    const decimals = (unit === "ADC" || Math.abs(raw) >= 100) ? 1 : 2;
                    trendEl.textContent = `▲ +${delta.toFixed(decimals)}`;
                    trendEl.className = "channel-trend up";
                } else {
                    const decimals = (unit === "ADC" || Math.abs(raw) >= 100) ? 1 : 2;
                    trendEl.textContent = `▼ ${delta.toFixed(decimals)}`;
                    trendEl.className = "channel-trend down";
                }
            }
            sparklineData[i].prevVal = raw;
        } else {
            rawEl.textContent = "—";
            rawEl.style.color = "";
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
            if (sensorFail) {
                dotEl.className = "channel-status-dot fail";
            } else {
                const isOk = data.integrity === "VERIFIED";
                dotEl.className = "channel-status-dot" + (isOk ? "" : " fail");
            }
        }

        /* Sparkline buffer & redraw */
        if (raw !== null && !sensorFail) {
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
        /* Update signed timestamp display */
        if (dom.signedTimestamp) {
            let tsStr = data.signed_timestamp || data.timestamp || "—";
            dom.signedTimestamp.textContent = tsStr;
        }

        /* Update HMAC hash displays */
        if (dom.hmacOriginal) dom.hmacOriginal.textContent = formatHex(data.hmac_original);
        if (dom.hmacRecomputed) dom.hmacRecomputed.textContent = formatHex(data.hmac_recomputed);

        const verified = data.integrity === "VERIFIED";

        /* Signature / Timestamp binding badge */
        if (dom.timeVerifiedBadge) {
            if (verified) {
                dom.timeVerifiedBadge.textContent = "[ BOUND IN HMAC ✓ ]";
                dom.timeVerifiedBadge.className = "sig-badge verified";
                if (dom.signedTimestamp) dom.signedTimestamp.classList.remove("mismatch");
            } else {
                if (data.tamper_type === "timestamp") {
                    dom.timeVerifiedBadge.textContent = "[ FORGED / REPLAY ✗ ]";
                    dom.timeVerifiedBadge.className = "sig-badge failed";
                    if (dom.signedTimestamp) dom.signedTimestamp.classList.add("mismatch");
                } else {
                    dom.timeVerifiedBadge.textContent = "[ SIG INVALID ✗ ]";
                    dom.timeVerifiedBadge.className = "sig-badge failed";
                    if (dom.signedTimestamp) dom.signedTimestamp.classList.remove("mismatch");
                }
            }
        }

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
                if (dom.matchText) {
                    dom.matchText.textContent = data.tamper_type === "timestamp"
                        ? "TIMESTAMP SIGNATURE MISMATCH — FORGERY DETECTED"
                        : "HASH MISMATCH — INTEGRITY VIOLATION DETECTED";
                }
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
            const armedMode = tamperArmed;
            tamperArmed = null;
            if (armedMode === "timestamp" && dom.tamperTimeBtn) {
                dom.tamperTimeBtn.innerHTML = '<span class="hud-bracket">[</span> FORGERY CAUGHT <span class="hud-bracket">]</span>';
                setTimeout(function () {
                    dom.tamperTimeBtn.disabled = false;
                    dom.tamperTimeBtn.innerHTML = '<span class="hud-bracket">[</span> TAMPER TIMESTAMP <span class="hud-bracket">]</span>';
                }, 2500);
            } else if (dom.tamperBtn) {
                dom.tamperBtn.innerHTML = '<span class="hud-bracket">[</span> VIOLATION DETECTED <span class="hud-bracket">]</span>';
                setTimeout(function () {
                    dom.tamperBtn.disabled = false;
                    dom.tamperBtn.innerHTML = '<span class="hud-bracket">[</span> TAMPER DATA <span class="hud-bracket">]</span>';
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
        let detail = "HMAC integrity violation — signature verification failed";
        if (data.tamper_type === "timestamp") {
            const altered = data.tampered_timestamp ? ` (${data.tampered_timestamp.substring(0, 10)})` : "";
            detail = `Timestamp signature mismatch — forged/replayed timestamp detected${altered}`;
        } else if (data.tampered_channel !== undefined) {
            const chLabel = activeLabels[data.tampered_channel] || ("CH" + data.tampered_channel);
            detail = `Tampered CH${data.tampered_channel} (${chLabel}) — ciphertext corrupted, HMAC signature rejected`;
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
        let range = max - min;

        /* Minimum vertical range per channel to avoid auto-scaling micro-noise into huge waves */
        const minSpans = {
            0: 2.0,   // Temperature (°C)
            1: 15.0,  // Distance (cm)
            2: 50.0,  // MQ3 (ADC)
            3: 50.0,  // MQ135 (ADC)
            4: 50.0,  // MQ9 (ADC)
            5: 50.0,  // MQ5 (ADC)
            6: 0.05,  // Acceleration (g) — sensitive to physical taps and movement
            7: 10.0,  // Tilt (°)
            8: 0.1,   // GPS Coordinates (°) — keeps stationary GPS line steady
            9: 2.0,   // Atmos Pressure (hPa)
        };
        const minSpan = minSpans[channelIdx] !== undefined ? minSpans[channelIdx] : 1.0;
        if (range < minSpan) {
            const mid = (min + max) / 2;
            min = mid - minSpan / 2;
            max = mid + minSpan / 2;
            range = minSpan;
        }
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
            `<td class="cipher-tag">10 Channels Encrypted (Z₂₅₇)</td>` +
            `<td class="${integrityClass}">[ ${integrity} ]</td>`;

        tbody.insertBefore(row, tbody.firstChild);

        while (tbody.children.length > MAX_LOG) {
            tbody.removeChild(tbody.lastChild);
        }
    }

    /* ── Regular GeoWeather API Polling ────────────────────────────────── */
    function fetchGeoWeatherAPI() {
        fetch(API_BASE + "/geo_weather")
            .then(function (r) {
                if (!r.ok) throw new Error("HTTP " + r.status);
                return r.json();
            })
            .then(function (gw) {
                geoWeatherData = gw;
                updateGeoWeatherBadges(gw);
            })
            .catch(function (err) {
                console.warn("Regular GeoWeather API call error:", err);
            });
    }

    function updateGeoWeatherBadges(gw) {
        if (!gw) return;
        const b8 = document.getElementById("ch-api-badge-8");
        const b9 = document.getElementById("ch-api-badge-9");
        if (b8) {
            const locName = (gw.city && gw.city !== "Unknown" && gw.city !== "Detecting...") ? gw.city.toUpperCase() : (gw.source_geo || "GEO");
            b8.textContent = `[ ${locName}: 200 OK ]`;
        }
        if (b9) {
            const src = gw.source_weather ? gw.source_weather.replace(" API", "").toUpperCase() : "METEO";
            b9.textContent = `[ ${src}: 200 OK ]`;
        }
    }

    /* ── Tamper Test (Data or Timestamp) ──────────────────────────────── */
    function triggerTamper(mode) {
        mode = mode || "data";
        const btn = (mode === "timestamp") ? dom.tamperTimeBtn : dom.tamperBtn;
        if (!btn) return;

        btn.disabled = true;
        tamperArmed = mode;
        const originalText = (mode === "timestamp") ? "TAMPER TIMESTAMP" : "TAMPER DATA";
        btn.innerHTML = '<span class="hud-bracket">[</span> ARMING… <span class="hud-bracket">]</span>';

        fetch(API_BASE + "/tamper", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: mode }),
        })
            .then(function (r) { return r.json(); })
            .then(function (result) {
                btn.innerHTML = `<span class="hud-bracket">[</span> ${mode.toUpperCase()} ARMED — AWAITING FRAME <span class="hud-bracket">]</span>`;

                /* If no violation detected within 8s, reset button */
                setTimeout(function () {
                    if (tamperArmed === mode) {
                        tamperArmed = null;
                        btn.disabled = false;
                        btn.innerHTML = `<span class="hud-bracket">[</span> ${originalText} <span class="hud-bracket">]</span>`;
                    }
                }, 8000);
            })
            .catch(function () {
                tamperArmed = null;
                btn.disabled = false;
                btn.innerHTML = '<span class="hud-bracket">[</span> FAILED — RETRY <span class="hud-bracket">]</span>';
                setTimeout(function () {
                    btn.innerHTML = `<span class="hud-bracket">[</span> ${originalText} <span class="hud-bracket">]</span>`;
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

/* ═══════════════════════════════════════════════════════════════════════════
   ARBITRARY FILE ENTROPY VAULT CONTROLLER
   Physical One-Time Pad Masking & HMAC-SHA256 Document Verification
   ═══════════════════════════════════════════════════════════════════════════ */
(function initFileEntropyVault() {
    // Session state
    const state = {
        selectedSourceFile: null,
        cipherFile: null,
        padFile: null,
        cipherBlob: null,
        padBlob: null,
        cipherB64: null,
        padB64: null,
        expectedHmac: "",
        originalFilename: "",
        restoredBlob: null,
        restoredFilename: "",
    };

    function $(id) {
        return document.getElementById(id);
    }

    function formatBytes(bytes, decimals = 2) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }

    function b64ToBlob(b64Data, contentType = 'application/octet-stream') {
        const byteCharacters = atob(b64Data);
        const byteArrays = [];
        const sliceSize = 65536;
        for (let offset = 0; offset < byteCharacters.length; offset += sliceSize) {
            const slice = byteCharacters.slice(offset, offset + sliceSize);
            const byteNumbers = new Array(slice.length);
            for (let i = 0; i < slice.length; i++) {
                byteNumbers[i] = slice.charCodeAt(i);
            }
            const byteArray = new Uint8Array(byteNumbers);
            byteArrays.push(byteArray);
        }
        return new Blob(byteArrays, { type: contentType });
    }

    function triggerDownload(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
    }

    function setupVault() {
        const dropzone = $('vault-dropzone');
        const fileInput = $('vault-file-input');
        const btnBrowse = $('btn-browse-file');
        const fileBadge = $('file-badge');
        const badgeName = $('badge-filename');
        const badgeSize = $('badge-filesize');
        const badgeMime = $('badge-mimetype');
        const btnEncrypt = $('btn-encrypt-file');

        const resultBox = $('encrypt-result-box');
        const hmacDisplay = $('enc-hmac-display');
        const hexPlain = $('hex-preview-plain');
        const hexPad = $('hex-preview-pad');
        const hexCipher = $('hex-preview-cipher');
        const btnDownloadEnc = $('btn-download-enc');
        const btnDownloadPad = $('btn-download-pad');

        const dropEnc = $('drop-target-enc');
        const inputEnc = $('input-file-enc');
        const statusEnc = $('status-enc');

        const dropPad = $('drop-target-pad');
        const inputPad = $('input-file-pad');
        const statusPad = $('status-pad');

        const inputHmac = $('input-expected-hmac');
        const btnDecrypt = $('btn-decrypt-verify');
        const btnTamperSim = $('btn-tamper-sim');
        const verifyBanner = $('vault-verify-banner');

        const docViewer = $('doc-viewer-container');
        const viewerTitle = $('viewer-title');
        const btnViewerSave = $('btn-viewer-save');
        const txtPreview = $('txt-preview');
        const pdfPreview = $('pdfPreview');

        if (!dropzone || !btnEncrypt) return;

        // Prevent browser from opening dropped files outside dropzones
        window.addEventListener('dragover', (e) => e.preventDefault(), false);
        window.addEventListener('drop', (e) => e.preventDefault(), false);

        // 1. Source File Drag & Drop
        ['dragenter', 'dragover'].forEach(name => {
            dropzone.addEventListener(name, (e) => {
                e.preventDefault();
                e.stopPropagation();
                dropzone.classList.add('dragover');
            });
        });

        ['dragleave', 'drop'].forEach(name => {
            dropzone.addEventListener(name, (e) => {
                e.preventDefault();
                e.stopPropagation();
                dropzone.classList.remove('dragover');
            });
        });

        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                handleSourceFile(e.dataTransfer.files[0]);
            }
        });

        if (btnBrowse) {
            btnBrowse.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                fileInput.value = '';
                fileInput.click();
            });
        }

        dropzone.addEventListener('click', (e) => {
            if (e.target !== btnBrowse) {
                fileInput.value = '';
                fileInput.click();
            }
        });

        fileInput.addEventListener('click', (e) => {
            e.stopPropagation();
        });

        fileInput.addEventListener('change', () => {
            if (fileInput.files && fileInput.files.length > 0) {
                handleSourceFile(fileInput.files[0]);
            }
        });

        function handleSourceFile(file) {
            if (!file) return;
            const ext = file.name.split('.').pop().toLowerCase();
            if (ext !== 'txt' && ext !== 'pdf') {
                alert("Unsupported file format: ." + ext + "\nPlease choose a .txt or .pdf file.");
                return;
            }
            if (file.size > 10 * 1024 * 1024) {
                alert("File exceeds maximum allowed size of 10 MB (" + formatBytes(file.size) + ").");
                return;
            }

            state.selectedSourceFile = file;
            state.originalFilename = file.name;

            badgeName.textContent = file.name;
            badgeSize.textContent = formatBytes(file.size);
            badgeMime.textContent = file.type || (ext === 'pdf' ? 'application/pdf' : 'text/plain');

            fileBadge.classList.remove('hidden');
            btnEncrypt.disabled = false;
            btnEncrypt.classList.remove('disabled');
        }

        // 2. Encrypt with One-Time Pad
        btnEncrypt.addEventListener('click', async () => {
            if (!state.selectedSourceFile) return;

            btnEncrypt.disabled = true;
            btnEncrypt.innerHTML = '<span class="hud-bracket">[</span> ENCRYPTING WITH PHYSICAL OTP... <span class="hud-bracket">]</span>';

            const formData = new FormData();
            formData.append('file', state.selectedSourceFile);

            try {
                const res = await fetch('/api/file/encrypt', {
                    method: 'POST',
                    body: formData,
                });

                if (!res.ok) {
                    const err = await res.json();
                    throw new Error(err.error || 'Encryption failed with status ' + res.status);
                }

                const data = await res.json();

                state.cipherB64 = data.ciphertext_b64;
                state.padB64 = data.pad_b64;
                // Convert to binary Blobs immediately to stream efficiently on decrypt
                state.cipherBlob = b64ToBlob(data.ciphertext_b64, 'application/octet-stream');
                state.padBlob = b64ToBlob(data.pad_b64, 'application/octet-stream');
                state.expectedHmac = data.original_hmac;
                state.cipherFile = null;
                state.padFile = null;

                // Update UI Result Box
                hmacDisplay.textContent = data.original_hmac;
                hexPlain.textContent = data.preview_original_hex || '—';
                hexPad.textContent = data.preview_pad_hex || '—';
                hexCipher.textContent = data.preview_cipher_hex || '—';
                resultBox.classList.remove('hidden');

                // Auto-fill right panel verification inputs
                inputHmac.value = data.original_hmac;
                dropEnc.classList.add('loaded');
                statusEnc.textContent = `✓ ${data.filename}.enc (${formatBytes(data.size_bytes)})`;
                dropPad.classList.add('loaded');
                statusPad.textContent = `✓ ${data.filename}.pad (${formatBytes(data.size_bytes)})`;

                btnEncrypt.innerHTML = '<span class="hud-bracket">[</span> ENCRYPT WITH ONE-TIME PAD <span class="hud-bracket">]</span>';
                btnEncrypt.disabled = false;
            } catch (err) {
                console.error(err);
                alert("Encryption error: " + err.message);
                btnEncrypt.innerHTML = '<span class="hud-bracket">[</span> ENCRYPTION FAILED — RETRY <span class="hud-bracket">]</span>';
                setTimeout(() => {
                    btnEncrypt.innerHTML = '<span class="hud-bracket">[</span> ENCRYPT WITH ONE-TIME PAD <span class="hud-bracket">]</span>';
                    btnEncrypt.disabled = false;
                }, 2000);
            }
        });

        // 3. Download Buttons
        btnDownloadEnc.addEventListener('click', () => {
            const blob = state.cipherBlob || (state.cipherB64 ? b64ToBlob(state.cipherB64) : null);
            if (!blob) return;
            triggerDownload(blob, `${state.originalFilename || 'document'}.enc`);
        });

        btnDownloadPad.addEventListener('click', () => {
            const blob = state.padBlob || (state.padB64 ? b64ToBlob(state.padB64) : null);
            if (!blob) return;
            triggerDownload(blob, `${state.originalFilename || 'document'}.pad`);
        });

        // 4. Target 1: Ciphertext Upload
        ['dragenter', 'dragover'].forEach(name => {
            dropEnc.addEventListener(name, (e) => {
                e.preventDefault();
                e.stopPropagation();
                dropEnc.classList.add('dragover');
            });
        });
        ['dragleave', 'drop'].forEach(name => {
            dropEnc.addEventListener(name, (e) => {
                e.preventDefault();
                e.stopPropagation();
                dropEnc.classList.remove('dragover');
            });
        });
        dropEnc.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                handleCipherFile(e.dataTransfer.files[0]);
            }
        });
        dropEnc.addEventListener('click', () => {
            inputEnc.value = '';
            inputEnc.click();
        });
        inputEnc.addEventListener('click', (e) => e.stopPropagation());
        inputEnc.addEventListener('change', () => {
            if (inputEnc.files && inputEnc.files.length > 0) handleCipherFile(inputEnc.files[0]);
        });

        function handleCipherFile(file) {
            if (!file) return;
            state.cipherFile = file;
            state.cipherBlob = file;
            let derivedName = file.name;
            if (derivedName.toLowerCase().endsWith('.enc')) derivedName = derivedName.slice(0, -4);
            if (derivedName.toLowerCase().endsWith('.pad')) derivedName = derivedName.slice(0, -4);
            if (!state.originalFilename || state.originalFilename === 'document.bin') {
                state.originalFilename = derivedName;
            }
            dropEnc.classList.add('loaded');
            statusEnc.textContent = `✓ ${file.name} (${formatBytes(file.size)})`;
        }

        // 5. Target 2: Key Pad Upload
        ['dragenter', 'dragover'].forEach(name => {
            dropPad.addEventListener(name, (e) => {
                e.preventDefault();
                e.stopPropagation();
                dropPad.classList.add('dragover');
            });
        });
        ['dragleave', 'drop'].forEach(name => {
            dropPad.addEventListener(name, (e) => {
                e.preventDefault();
                e.stopPropagation();
                dropPad.classList.remove('dragover');
            });
        });
        dropPad.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                handlePadFile(e.dataTransfer.files[0]);
            }
        });
        dropPad.addEventListener('click', () => {
            inputPad.value = '';
            inputPad.click();
        });
        inputPad.addEventListener('click', (e) => e.stopPropagation());
        inputPad.addEventListener('change', () => {
            if (inputPad.files && inputPad.files.length > 0) handlePadFile(inputPad.files[0]);
        });

        function handlePadFile(file) {
            state.padFile = file;
            state.padBlob = file;
            let derivedName = file.name;
            if (derivedName.toLowerCase().endsWith('.pad')) derivedName = derivedName.slice(0, -4);
            if (derivedName.toLowerCase().endsWith('.enc')) derivedName = derivedName.slice(0, -4);
            if (!state.originalFilename || state.originalFilename === 'document.bin') {
                state.originalFilename = derivedName;
            }
            dropPad.classList.add('loaded');
            statusPad.textContent = `✓ ${file.name} (${formatBytes(file.size)})`;
        }

        // 6. Decrypt & Verify Integrity
        btnDecrypt.addEventListener('click', async () => {
            const hmacVal = (inputHmac.value || "").trim();
            if (!hmacVal) {
                alert("Please provide the Expected HMAC-SHA256 hex digest.");
                inputHmac.focus();
                return;
            }

            const cipherPayload = state.cipherFile || state.cipherBlob;
            const padPayload = state.padFile || state.padBlob;

            if (!cipherPayload) {
                alert("Please provide the Ciphertext (.enc) file.");
                return;
            }
            if (!padPayload) {
                alert("Please provide the Key Pad (.pad) file.");
                return;
            }

            let baseName = state.originalFilename || "document.bin";
            if (baseName.toLowerCase().endsWith('.enc')) baseName = baseName.slice(0, -4);
            if (baseName.toLowerCase().endsWith('.pad')) baseName = baseName.slice(0, -4);

            btnDecrypt.disabled = true;
            btnDecrypt.innerHTML = '<span class="hud-bracket">[</span> VERIFYING HMAC &amp; DECRYPTING... <span class="hud-bracket">]</span>';

            const formData = new FormData();
            formData.append('expected_hmac', hmacVal);
            formData.append('filename', baseName);
            // Stream as files to bypass the 1024KB form text field limit
            formData.append('ciphertext_file', cipherPayload, `${baseName}.enc`);
            formData.append('pad_file', padPayload, `${baseName}.pad`);

            try {
                const res = await fetch('/api/file/decrypt', {
                    method: 'POST',
                    body: formData,
                });

                if (res.status === 200) {
                    const blob = await res.blob();
                    const disposition = res.headers.get('Content-Disposition') || '';
                    let outName = '';
                    const fnMatch = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
                    if (fnMatch && fnMatch[1]) {
                        outName = decodeURIComponent(fnMatch[1].replace(/['"]/g, ''));
                    }
                    if (!outName) {
                        let base = state.originalFilename || 'document';
                        if (base.toLowerCase().endsWith('.enc')) base = base.slice(0, -4);
                        if (base.toLowerCase().endsWith('.pad')) base = base.slice(0, -4);
                        outName = `restored_${base}`;
                    }

                    // Check if PDF or TXT by inspecting MIME type or filename
                    const isPdf = res.headers.get('Content-Type')?.includes('pdf') || outName.toLowerCase().endsWith('.pdf');
                    const isTxt = res.headers.get('Content-Type')?.includes('text') || outName.toLowerCase().endsWith('.txt');

                    if (isPdf && !outName.toLowerCase().endsWith('.pdf')) {
                        outName = `${outName.replace(/\.[^/.]+$/, "")}.pdf`;
                    } else if (isTxt && !outName.toLowerCase().endsWith('.txt')) {
                        outName = `${outName.replace(/\.[^/.]+$/, "")}.txt`;
                    }

                    const typedBlob = new Blob([blob], {
                        type: isPdf ? 'application/pdf' : isTxt ? 'text/plain; charset=utf-8' : 'application/octet-stream'
                    });

                    state.restoredBlob = typedBlob;
                    state.restoredFilename = outName;

                    // Automatically download the restored file with original format
                    triggerDownload(typedBlob, outName);

                    // Show success banner
                    verifyBanner.className = 'vault-banner verified';
                    verifyBanner.innerHTML = `✓ HMAC VERIFIED — 100% BIT-FOR-BIT RECOVERY (${outName} DOWNLOADED)`;
                    verifyBanner.classList.remove('hidden');

                    // Render Document Viewer
                    const ext = outName.split('.').pop().toLowerCase();
                    viewerTitle.textContent = `RECOVERED: ${outName} (${formatBytes(blob.size)})`;

                    if (ext === 'txt') {
                        const reader = new FileReader();
                        reader.onload = function(evt) {
                            txtPreview.textContent = evt.target.result;
                            txtPreview.classList.remove('hidden');
                            pdfPreview.classList.add('hidden');
                            docViewer.classList.remove('hidden');
                        };
                        reader.readAsText(typedBlob);
                    } else if (ext === 'pdf') {
                        const reader = new FileReader();
                        reader.onload = function(evt) {
                            pdfPreview.src = evt.target.result;
                            pdfPreview.classList.remove('hidden');
                            txtPreview.classList.add('hidden');
                            docViewer.classList.remove('hidden');
                        };
                        reader.readAsDataURL(typedBlob);
                    } else {
                        txtPreview.classList.add('hidden');
                        pdfPreview.classList.add('hidden');
                        docViewer.classList.remove('hidden');
                    }
                } else if (res.status === 422) {
                    const errData = await res.json();
                    showIntegrityViolation(errData.error || "Integrity violation: Key pad mismatch or corrupted ciphertext.");
                } else {
                    const errData = await res.json().catch(() => ({}));
                    alert("Decryption error: " + (errData.detail || errData.error || "Server returned status " + res.status));
                }
            } catch (err) {
                console.error(err);
                alert("Network or decoding error: " + err.message);
            } finally {
                btnDecrypt.innerHTML = '<span class="hud-bracket">[</span> DECRYPT &amp; VERIFY INTEGRITY <span class="hud-bracket">]</span>';
                btnDecrypt.disabled = false;
            }
        });

        function showIntegrityViolation(msg) {
            verifyBanner.className = 'vault-banner violation';
            verifyBanner.innerHTML = '✕ INTEGRITY VIOLATION DETECTED — DECRYPTION REJECTED';
            verifyBanner.classList.remove('hidden');
            docViewer.classList.add('hidden');
        }

        // 7. Save Restored Document
        btnViewerSave.addEventListener('click', () => {
            if (state.restoredBlob) {
                triggerDownload(state.restoredBlob, state.restoredFilename || 'restored_document');
            }
        });

        // 8. Simulate Single-Bit Tampering
        btnTamperSim.addEventListener('click', async () => {
            const cipherPayload = state.cipherFile || state.cipherBlob;
            const padPayload = state.padFile || state.padBlob;

            if (!cipherPayload || !padPayload) {
                alert("Please provide both ciphertext and pad before simulating tampering.");
                return;
            }

            btnTamperSim.disabled = true;
            btnTamperSim.innerHTML = '<span class="hud-bracket">[</span> INJECTING BIT FLIP... <span class="hud-bracket">]</span>';

            const formData = new FormData();
            formData.append('ciphertext_file', cipherPayload, `${state.originalFilename || 'document'}.enc`);
            formData.append('pad_file', padPayload, `${state.originalFilename || 'document'}.pad`);
            formData.append('expected_hmac', (inputHmac.value || "").trim());

            try {
                const res = await fetch('/api/file/tamper-sim', {
                    method: 'POST',
                    body: formData,
                });

                const data = await res.json();
                verifyBanner.className = 'vault-banner violation';
                verifyBanner.innerHTML = '✕ INTEGRITY VIOLATION DETECTED — DECRYPTION REJECTED (SINGLE-BIT TAMPER INJECTED)';
                verifyBanner.classList.remove('hidden');
                docViewer.classList.add('hidden');
            } catch (err) {
                console.error(err);
                showIntegrityViolation(err.message);
            } finally {
                btnTamperSim.innerHTML = '<span class="hud-bracket">[</span> SIMULATE SINGLE-BIT TAMPERING <span class="hud-bracket">]</span>';
                btnTamperSim.disabled = false;
            }
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", setupVault);
    } else {
        setupVault();
    }
})();

