<p align="center">
  <img src="dashboard/favicon.svg" alt="Project Logo" width="80" height="80">
</p>

<h1 align="center">Quantum-Resilient IoT Telemetry Pipeline</h1>

<p align="center">
  <strong>Secure sensor data with physics, not algorithms.</strong><br>
  Information-theoretic One-Time Pad encryption powered by hardware true random number generation.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/python-3.10+-3776AB?logo=python&logoColor=white" alt="Python 3.10+">
  <img src="https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white" alt="FastAPI">
  <img src="https://img.shields.io/badge/ESP32-Hardware_TRNG-E7352C?logo=espressif&logoColor=white" alt="ESP32">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License">
</p>

---

## What is This?

Most encryption today relies on **math problems that are hard to solve** (like factoring large primes). Quantum computers threaten to break those problems.

This project takes a fundamentally different approach — it uses **physics instead of math** to secure IoT sensor data:

1. The ESP32 microcontroller generates **true random numbers** from physical noise (thermal + RF jitter).
2. Those random numbers are used as a **One-Time Pad (OTP)** to mask sensor readings.
3. Claude Shannon proved in 1949 that this method is **mathematically unbreakable** — even by quantum computers — as long as the pad is truly random and never reused.

The result is a full end-to-end pipeline: sensors → encryption → transmission → decryption → integrity verification, with a real-time dashboard to visualize every step.

> [!NOTE]
> **Educational Demonstration** — This project transmits the pad alongside the ciphertext for demonstration purposes. In a production deployment, pad material would be pre-shared or exchanged via a secure key establishment protocol.

---

## How It Works

```
  Sensor (ESP32)          Backend Server            Dashboard
  ──────────────          ──────────────            ─────────
       │                        │                       │
  Read analog data              │                       │
       │                        │                       │
  Generate random pad           │                       │
  (hardware TRNG)               │                       │
       │                        │                       │
  Send via USB Serial ─────►  Receive                   │
                               │                        │
                          Quantize floats               │
                          to discrete states            │
                               │                        │
                          Compute HMAC-SHA256            │
                          (integrity tag)               │
                               │                        │
                          OTP Encrypt:                   │
                          C = (data + pad) mod 257       │
                               │                        │
                          OTP Decrypt:                   │
                          data = (C - pad + 257) mod 257 │
                               │                        │
                          Verify HMAC ──────────────► Display live
                               │                    telemetry, charts,
                               │                    entropy metrics
```

### Why mod 257?

257 is a **prime number** just above 256 (the byte range). Using a prime modulus ensures the OTP arithmetic wraps uniformly across all possible values with no bias, which is essential for Shannon's perfect secrecy guarantee.

---

## Key Concepts

| Concept | What it Means | Where in the Code |
|---------|--------------|-------------------|
| **One-Time Pad (OTP)** | Each sensor reading is masked with a fresh random key, making ciphertext statistically independent of plaintext | `crypto_core.py` — `otp_encrypt()`, `otp_decrypt()` |
| **Shannon Entropy** | Measures how "random" the pad actually is. Max ≈ 8.006 bits means perfectly uniform | `crypto_core.py` — `EntropyAnalyzer.shannon_entropy()` |
| **HMAC-SHA256** | A keyed hash that detects any tampering with the data after encryption | `crypto_core.py` — `compute_hmac()`, `verify_hmac()` |
| **Threshold Quantization** | Converts continuous sensor floats (e.g., 25.3°C) into discrete integer states (e.g., state 2) for encryption | `crypto_core.py` — `quantize_value()` |
| **Hardware TRNG** | True Random Number Generator on the ESP32 chip — randomness from physical noise, not a software algorithm | `firmware/esp32_otp_sensor.ino` — `esp_random()` |

---

## Project Structure

```
├── firmware/
│   └── esp32_otp_sensor.ino       # Arduino firmware: TRNG + sensor reading + JSON serial output
│
├── backend/
│   ├── main.py                    # FastAPI server: REST API + WebSocket + static file serving
│   ├── crypto_core.py             # Core cryptography: OTP, HMAC, quantization, entropy analysis
│   ├── simulator.py               # Virtual sensor + CSPRNG fallback (when no ESP32 is connected)
│   ├── serial_bridge.py           # Auto-detect ESP32 via USB serial + graceful fallback
│   ├── config.py                  # All tunable parameters (thresholds, channels, network)
│   └── requirements.txt           # Python dependencies
│
├── dashboard/
│   ├── index.html                 # Single-page real-time dashboard
│   ├── style.css                  # Dark glassmorphism UI styling
│   ├── app.js                     # WebSocket client, canvas charts, live rendering
│   ├── favicon.svg                # Custom SVG favicon (shield + entropy waveform + lock)
│   └── favicon.png                # PNG fallback favicon for older browsers
│
└── README.md
```

---

## Quick Start

### Prerequisites

- **Python 3.10+** with pip
- *(Optional)* ESP32 dev board connected via USB for hardware entropy

### 1. Install dependencies

```bash
cd backend
pip install -r requirements.txt
```

### 2. Verify the crypto module

```bash
cd backend
python crypto_core.py
```

You should see: `ALL SELF-TESTS PASSED ✓`

### 3. Start the server

```bash
cd backend
python main.py
```

> The server auto-detects an ESP32 on USB. If none is found, it automatically falls back to a software simulator with `os.urandom()` as the entropy source.

### 4. Open the dashboard

Navigate to **http://localhost:8000** in your browser.

---

## Dashboard

The real-time dashboard visualizes the entire encryption pipeline as it runs:

- **Live Pipeline Animation** — Watch data flow through each stage: Sensor → Quantize → HMAC → OTP Mask → Transmit → Unmask → Verify
- **8-Channel Sensor Grid** — Raw values, quantized states, pad bytes, ciphertext, and decrypted values side by side
- **Canvas Sparkline Charts** — Per-channel history rendered with zero external dependencies
- **HMAC Integrity Panel** — Side-by-side hash comparison with tamper detection
- **Tamper Test** — One-click button to deliberately corrupt a frame and watch HMAC catch it
- **Entropy Quality Metrics** — Live Shannon entropy, χ² uniformity score, and min-entropy
- **Entropy Histogram** — Visual distribution of pad bytes (should be near-uniform)
- **Live Math Showcase** — Real-time formula substitution with actual values
- **Packet Log** — Scrolling log of the last 50 telemetry frames

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/status` | System status, entropy source, uptime, packet count |
| `GET` | `/api/config` | Public crypto parameters (modulus, thresholds, labels) |
| `GET` | `/api/latest` | Latest full pipeline snapshot |
| `GET` | `/api/entropy` | Entropy quality metrics + byte distribution histogram |
| `GET` | `/api/log` | Last 50 telemetry frames |
| `POST` | `/api/tamper` | Arm deliberate ciphertext corruption for the next frame |
| `WS` | `/ws/telemetry` | Real-time WebSocket stream of full pipeline frames |

---

## Sensor Channels

| # | Sensor | Unit | Threshold Bins |
|---|--------|------|----------------|
| 0 | Temperature | °C | 0, 15, 25, 35, 50, 70, 100 |
| 1 | Humidity | %RH | 0, 20, 40, 60, 80, 100 |
| 2 | Pressure | hPa | 950, 980, 1000, 1013, 1030, 1050 |
| 3 | Light | lux | 0, 50, 200, 500, 1000, 5000, 10000 |
| 4 | CO₂ | ppm | 0, 400, 600, 1000, 2000, 5000 |
| 5 | Vibration | g | 0, 0.5, 1.0, 2.0, 5.0 |
| 6 | Voltage | V | 0, 1.0, 2.5, 3.6, 5.0 |
| 7 | Current | A | 0, 0.5, 1.0, 2.0, 5.0 |

---

## ESP32 Firmware

To use real hardware entropy instead of the software fallback:

1. Open `firmware/esp32_otp_sensor.ino` in **Arduino IDE** or **PlatformIO**
2. Select board: **ESP32 Dev Module**
3. Set baud rate: **115200**
4. Upload and verify JSON output in the Serial Monitor

The firmware auto-detects whether real analog sensors are wired. If not, it generates synthetic data with `esp_random()` for entropy and sinusoidal drift for sensor values.

---

## License

MIT License — See [LICENSE](LICENSE) for details.
