# Quantum-Resilient IoT Telemetry Pipeline

> **Information-Theoretic Security via Physical Entropy One-Time Pad (OTP)**

A production-grade hackathon prototype demonstrating a quantum-resilient, algorithm-free telemetry security pipeline. Instead of relying on computational complexity (which quantum algorithms can target), this system achieves **Shannon-perfect secrecy** through One-Time Pad masking with true physical entropy from the ESP32 hardware TRNG.

---

## ⚠️ Educational Disclaimer

This project is an **information-theoretic OTP demonstration** using physical entropy. It is **NOT** a replacement for production authenticated encryption standards (AES-GCM, ChaCha20-Poly1305). The pad is transmitted alongside ciphertext for educational and demonstration purposes only. In a real deployment, pad material would be pre-shared or exchanged via a secure key establishment protocol.

---

## Architecture

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  Sensor  │───▶│ Quantize │───▶│ HMAC Tag │───▶│ OTP Mask │───▶│ Transmit │───▶│OTP Unmask│───▶│  Verify  │
│  (ESP32) │    │ (float→Z)│    │ SHA-256  │    │ (x+K)%257│    │ (serial) │    │(C-K+257) │    │ HMAC cmp │
└──────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘
```

### Core Principles

1. **Information-Theoretic Security**: When the pad is truly random and used once, ciphertext yields zero statistical mutual information: `I(X; C) = 0`. Quantum algorithms (Shor's, Grover's) cannot break this.

2. **Deterministic Threshold Quantization**: Continuous float sensor values → discrete integer states (`x ∈ [0, M-1]`) via configurable threshold bins.

3. **Physical Entropy Keystream**: Fresh entropy bytes from ESP32 `esp_random()` (thermal noise + RF jitter), or `os.urandom()` CSPRNG fallback.

4. **Modular OTP Arithmetic** (N = 257, prime):
   - Encrypt: `C_i = (x_i + K_i) mod 257`
   - Decrypt: `x_i = (C_i - K_i + 257) mod 257`

5. **HMAC-SHA256 Integrity**: Computed over quantized plaintext before masking. Verified after unmasking.

---

## Project Structure

```
├── firmware/
│   └── esp32_otp_sensor.ino       # Arduino: TRNG entropy + sensor + JSON serial
├── backend/
│   ├── main.py                    # FastAPI app: REST + WebSocket + static serving
│   ├── crypto_core.py             # Quantization, OTP mask/unmask, HMAC, entropy analysis
│   ├── simulator.py               # Virtual sensor + CSPRNG entropy fallback
│   ├── serial_bridge.py           # pyserial ESP32 auto-detect + fallback
│   ├── config.py                  # All tunable parameters
│   └── requirements.txt           # Python dependencies
├── dashboard/
│   ├── index.html                 # Single-page real-time dashboard
│   ├── style.css                  # Dark glassmorphism premium styling
│   └── app.js                     # WebSocket client, canvas charts, live rendering
└── README.md
```

---

## Quick Start

### Prerequisites
- Python 3.10+
- pip

### 1. Install Dependencies

```bash
cd backend
pip install -r requirements.txt
```

### 2. Run Self-Tests

```bash
cd backend
python crypto_core.py
```

Expected output: `ALL SELF-TESTS PASSED ✓`

### 3. Start the Server

```bash
cd backend
python main.py
```

The server auto-detects ESP32 on USB. If none found, it falls back to the simulator.

### 4. Open the Dashboard

Navigate to **http://localhost:8000** in your browser.

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/status` | System status, source mode, uptime, packet count |
| `GET` | `/api/config` | Public crypto parameters (N, thresholds, labels) |
| `GET` | `/api/latest` | Latest full pipeline snapshot |
| `GET` | `/api/entropy` | Entropy quality metrics + byte distribution |
| `GET` | `/api/log` | Last 50 telemetry frames |
| `POST` | `/api/tamper` | Arm deliberate ciphertext corruption for next frame |
| `WS` | `/ws/telemetry` | Real-time streaming of full pipeline frames |

---

## ESP32 Firmware

Flash `firmware/esp32_otp_sensor.ino` using Arduino IDE or PlatformIO:

1. Select board: **ESP32 Dev Module**
2. Set baud rate: **115200**
3. Upload and open Serial Monitor to verify JSON output

The firmware auto-detects whether real analog sensors are wired. If not, it generates synthetic data using `esp_random()` for entropy and sinusoidal drift for sensor values.

---

## Dashboard Features

- **Dark glassmorphism** design with cyan/teal accent gradients
- **Animated pipeline visualization** showing data flow through all stages
- **8-channel live grid** with raw values, quantized states, pad bytes, ciphertext, and decrypted values
- **Canvas sparkline charts** per channel (no external libraries)
- **HMAC integrity panel** with side-by-side hash comparison
- **Tamper test button** for live HMAC failure demonstration
- **Entropy quality metrics**: Shannon entropy, χ² uniformity, min-entropy
- **Entropy histogram** showing pad byte distribution
- **Live math showcase** with real-time formula substitution
- **Scrolling packet log** of last 50 frames
- **WebSocket auto-reconnect** with exponential backoff

---

## Sensor Channels

| Channel | Label | Unit | Threshold Bins |
|---------|-------|------|----------------|
| 0 | Temperature | °C | 0, 15, 25, 35, 50, 70, 100 |
| 1 | Humidity | %RH | 0, 20, 40, 60, 80, 100 |
| 2 | Pressure | hPa | 950, 980, 1000, 1013, 1030, 1050 |
| 3 | Light | lux | 0, 50, 200, 500, 1000, 5000, 10000 |
| 4 | CO₂ | ppm | 0, 400, 600, 1000, 2000, 5000 |
| 5 | Vibration | g | 0, 0.5, 1.0, 2.0, 5.0 |
| 6 | Voltage | V | 0, 1.0, 2.5, 3.6, 5.0 |
| 7 | Current | A | 0, 0.5, 1.0, 2.0, 5.0 |

---

## License

MIT License — Educational and demonstration use.
