"""
config.py — Centralized configuration for Quantum-Resilient IoT Telemetry Pipeline.

All tunable parameters for the OTP-based security demonstration:
modulus, channel keys, thresholds, HMAC key, sensor labels, serial settings.
"""

import os

# ---------------------------------------------------------------------------
# Modular Arithmetic
# ---------------------------------------------------------------------------
# Prime modulus. 257 is the smallest prime > 256, so every quantized state
# in [0, 256] lives in Z_257 and modular arithmetic is well-defined.
N: int = 257

# ---------------------------------------------------------------------------
# Channel Configuration
# ---------------------------------------------------------------------------
NUM_CHANNELS: int = 8

SENSOR_LABELS: list[str] = [
    "Temperature",   # °C
    "Humidity",       # %RH
    "Pressure",       # hPa
    "Light",          # lux
    "CO₂",            # ppm
    "Vibration",      # g
    "Voltage",        # V
    "Current",        # A
]

# Quantization threshold arrays — bin edges per channel.
# A reading in [thresholds[i], thresholds[i+1]) maps to state i.
# Readings below the first edge map to state 0; above the last to len-1.
THRESHOLDS: list[list[float]] = [
    # Temperature (°C): 7 bins → states 0..6
    [0.0, 15.0, 25.0, 35.0, 50.0, 70.0, 100.0],
    # Humidity (%RH): 6 bins → states 0..5
    [0.0, 20.0, 40.0, 60.0, 80.0, 100.0],
    # Pressure (hPa): 6 bins → states 0..5
    [950.0, 980.0, 1000.0, 1013.0, 1030.0, 1050.0],
    # Light (lux): 7 bins → states 0..6
    [0.0, 50.0, 200.0, 500.0, 1000.0, 5000.0, 10000.0],
    # CO₂ (ppm): 6 bins → states 0..5
    [0.0, 400.0, 600.0, 1000.0, 2000.0, 5000.0],
    # Vibration (g): 5 bins → states 0..4
    [0.0, 0.5, 1.0, 2.0, 5.0],
    # Voltage (V): 5 bins → states 0..4
    [0.0, 1.0, 2.5, 3.6, 5.0],
    # Current (A): 5 bins → states 0..4
    [0.0, 0.5, 1.0, 2.0, 5.0],
]

# ---------------------------------------------------------------------------
# HMAC Integrity Key (pre-shared, 32 bytes)
# ---------------------------------------------------------------------------
# In production, load from a secure vault. For this demo, a fixed hex key.
HMAC_KEY: bytes = bytes.fromhex(
    "4f5a9c3e7b1d0e8f2a6c4d5b3e7f1a9c"
    "0d2e4f6a8b1c3d5e7f9a0b2c4d6e8f1a"
)

# ---------------------------------------------------------------------------
# Serial / Hardware
# ---------------------------------------------------------------------------
SERIAL_BAUD: int = 115200
SERIAL_TIMEOUT: float = 1.0

# ---------------------------------------------------------------------------
# Entropy & Telemetry
# ---------------------------------------------------------------------------
PAD_HISTORY_SIZE: int = 100       # Sliding window for entropy quality metrics
FRAME_INTERVAL_MS: int = 1000     # Telemetry frame period (milliseconds)
MAX_LOG_FRAMES: int = 50          # Dashboard log depth

# ---------------------------------------------------------------------------
# Sensor value ranges (used by simulator for realistic data generation)
# ---------------------------------------------------------------------------
SENSOR_RANGES: list[tuple[float, float]] = [
    (10.0, 90.0),       # Temperature °C
    (10.0, 95.0),       # Humidity %RH
    (960.0, 1045.0),    # Pressure hPa
    (0.0, 8000.0),      # Light lux
    (300.0, 4500.0),    # CO₂ ppm
    (0.0, 4.0),         # Vibration g
    (0.0, 4.5),         # Voltage V
    (0.0, 4.0),         # Current A
]

# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------
HOST: str = "0.0.0.0"
PORT: int = 8000
