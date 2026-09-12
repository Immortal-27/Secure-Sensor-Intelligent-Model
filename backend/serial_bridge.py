"""
serial_bridge.py — ESP32 auto-detection, robust dual-mode parser, and unified sensor stream.

Supports:
1. Physical ESP32 hardware streaming human-readable sensor lines from `firmware/esp32_otp_sensor.ino`:
   - MQ3 (Alcohol), MQ135 (Air Quality), MQ9 (CO/Gas), MQ5 (LPG)
   - HC-SR04 Ultrasonic Distance
   - DHT22 Humidity & Temperature
2. Physical ESP32 hardware streaming JSON telemetry frames:
   {"v": [v0..v7], "pad": [k0..k7], "pid": N}
3. Seamless fallback to VirtualSensorGenerator when no hardware is connected.
4. Dynamic port scanning, connect/disconnect controls via REST API and dashboard UI.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import sys
import time
from typing import AsyncGenerator, Optional

from config import (
    SERIAL_BAUD,
    SERIAL_TIMEOUT,
    N,
    NUM_CHANNELS,
    HARDWARE_LABELS,
    HARDWARE_UNITS,
    SENSOR_LABELS,
    SIMULATOR_UNITS,
)
from simulator import VirtualSensorGenerator

logger = logging.getLogger("serial_bridge")
logger.setLevel(logging.INFO)

# ═══════════════════════════════════════════════════════════════════════════
# ESP32 HARDWARE DETECTION & PORT SCANNING
# ═══════════════════════════════════════════════════════════════════════════

ESP32_IDENTIFIERS = [
    "CP210",        # Silicon Labs CP2102/CP2104
    "CH340",        # WCH CH340
    "CH910",        # WCH CH9102
    "FTDI",         # FTDI USB-UART
    "USB SERIAL",
    "USB-SERIAL",
    "ESP32",
    "SLAB_USBTOUART",
    "UART",
]


def list_available_ports() -> list[dict]:
    """
    Scan all available serial ports on the host system.

    Returns
    -------
    list[dict]
        List of dicts with keys: device, description, hwid, is_esp
    """
    try:
        import serial.tools.list_ports
        ports = serial.tools.list_ports.comports()
        result = []
        for port in ports:
            info_str = f"{port.description} {port.hwid}".upper()
            is_esp = any(ident in info_str for ident in ESP32_IDENTIFIERS)
            result.append({
                "device": port.device,
                "description": port.description or "Serial Device",
                "hwid": port.hwid or "",
                "is_esp": is_esp,
            })
        return result
    except ImportError:
        logger.warning("pyserial not installed — cannot scan serial ports")
        return []
    except Exception as exc:
        logger.error(f"Error scanning serial ports: {exc}")
        return []


def detect_esp32() -> Optional[str]:
    """
    Scan available ports and return the first device flagged as an ESP32.
    """
    ports = list_available_ports()
    for p in ports:
        if p["is_esp"]:
            logger.info(f"ESP32 candidate identified: {p['device']} ({p['description']})")
            return p["device"]
    if ports:
        logger.info(f"No explicitly branded ESP32 found; defaulting to first available port {ports[0]['device']}")
        return ports[0]["device"]
    return None


# ═══════════════════════════════════════════════════════════════════════════
# ROBUST HARDWARE SERIAL READER
# ═══════════════════════════════════════════════════════════════════════════

class HardwareSerialReader:
    """
    Reads and parses telemetry frames from ESP32 over USB Serial.

    Handles:
    - Text bursts from esp32_otp_sensor.ino
    - JSON frames {"v":[...], "pad":[...], "pid": N}
    - Noise, unprintable characters, and baud sync anomalies
    """

    def __init__(self, port: str, baud: int = SERIAL_BAUD):
        self.port = port
        self.baud = baud
        self._serial = None
        self.packets_read = 0
        self.last_seen = 0.0

        # Accumulated sensor state from esp32_otp_sensor.ino
        # Initialize with sentinel -999 so we never show stale defaults
        # as if they were real readings. -999 is replaced with 0.0 in
        # _build_hardware_frame until a real value arrives.
        self._accumulated = {
            "temp": -999.0,
            "hum": -999.0,
            "dist": -999.0,
            "mq3": -999.0,
            "mq135": -999.0,
            "mq9": -999.0,
            "mq5": -999.0,
            "bus": 3.30,     # ESP32 bus is always 3.3 V
        }
        self._dht_ok = False   # Track whether DHT22 is reporting valid data
        self._last_valid_frame: Optional[dict] = None
        self._packet_id = 0
        self._items_in_current_burst = 0

    @property
    def is_open(self) -> bool:
        return self._serial is not None and self._serial.is_open

    def connect(self) -> bool:
        """Open the serial port. Returns True on success."""
        try:
            import serial as pyserial
            self._serial = pyserial.Serial(
                self.port,
                self.baud,
                timeout=SERIAL_TIMEOUT,
            )
            # Flush startup garbage
            self._serial.reset_input_buffer()
            self.last_seen = time.time()
            logger.info(f"✓ HardwareSerialReader connected to {self.port} at {self.baud} baud")
            return True
        except Exception as exc:
            logger.error(f"Failed to open {self.port}: {exc}")
            self._serial = None
            return False

    def read_frame(self) -> Optional[dict]:
        """
        Read from serial port, parse lines, and assemble complete frames.
        Returns None if no full frame has formed yet or read timed out.
        """
        if not self.is_open:
            return None

        try:
            for _ in range(12):
                if not self.is_open or self._serial.in_waiting == 0:
                    break

                raw_bytes = self._serial.readline()
                if not raw_bytes:
                    break

                line = raw_bytes.decode("utf-8", errors="ignore").strip()
                if not line:
                    continue

                self.last_seen = time.time()

                # Case 1: JSON frame
                if line.startswith("{") and line.endswith("}"):
                    try:
                        data = json.loads(line)
                        if "v" in data and isinstance(data["v"], list) and len(data["v"]) >= NUM_CHANNELS:
                            raw_vals = [float(x) for x in data["v"][:NUM_CHANNELS]]
                            pad = data.get("pad")
                            if not pad or len(pad) < NUM_CHANNELS:
                                pad = [b % N for b in os.urandom(NUM_CHANNELS)]
                            else:
                                pad = [int(p) % N for p in pad[:NUM_CHANNELS]]

                            self._packet_id += 1
                            self.packets_read += 1
                            frame = {
                                "v": raw_vals,
                                "pad": pad,
                                "pid": data.get("pid", self._packet_id),
                                "scenario": "ESP32_JSON",
                            }
                            self._last_valid_frame = frame
                            return frame
                    except Exception as e:
                        logger.debug(f"JSON parse error on line: {line[:50]} ({e})")

                # Case 2: Human-readable text format from esp32_otp_sensor.ino
                matched = self._parse_text_line(line)
                if matched:
                    self._items_in_current_burst += 1

                # Delimiter line
                if "=========" in line or self._items_in_current_burst >= 6:
                    self._items_in_current_burst = 0
                    frame = self._build_hardware_frame()
                    if frame:
                        return frame

            return None

        except Exception as exc:
            logger.error(f"Serial port read exception on {self.port}: {exc}")
            self.close()
            return None

    def _parse_text_line(self, line: str) -> bool:
        """Parse individual sensor key-value line from esp32_otp_sensor.ino."""
        line_clean = line.replace("\t", " ").strip()

        # MQ3 (Alcohol): <val>
        m = re.search(r"MQ3\s*\(Alcohol\)\s*:\s*([\d\.]+)", line_clean, re.IGNORECASE)
        if m:
            val = float(m.group(1))
            if 0 <= val <= 4095:
                self._accumulated["mq3"] = val
            return True

        # MQ135 (Air Qlt): <val>
        m = re.search(r"MQ135\s*\(Air\s*Qlt\)\s*:\s*([\d\.]+)", line_clean, re.IGNORECASE)
        if m:
            val = float(m.group(1))
            if 0 <= val <= 4095:
                self._accumulated["mq135"] = val
            return True

        # MQ9 (CO/Gas): <val>
        m = re.search(r"MQ9\s*\(CO/Gas\)\s*:\s*([\d\.]+)", line_clean, re.IGNORECASE)
        if m:
            val = float(m.group(1))
            if 0 <= val <= 4095:
                self._accumulated["mq9"] = val
            return True

        # MQ5 (LPG): <val>
        m = re.search(r"MQ5\s*\(LPG\)\s*:\s*([\d\.]+)", line_clean, re.IGNORECASE)
        if m:
            val = float(m.group(1))
            if 0 <= val <= 4095:
                self._accumulated["mq5"] = val
            return True

        # Distance: <val> cm — accept 0.0 (HC-SR04 returns 0 when no echo)
        m = re.search(r"Distance\s*:\s*([\d\.]+)", line_clean, re.IGNORECASE)
        if m:
            val = float(m.group(1))
            if 0.0 <= val <= 500.0:
                self._accumulated["dist"] = val
            return True

        # Humidity: <val>%  |  Temp: <val> °C
        m = re.search(r"Humidity\s*:\s*([\d\.]+).*?Temp\s*:\s*([\d\.]+)", line_clean, re.IGNORECASE)
        if m:
            hum = float(m.group(1))
            temp = float(m.group(2))
            if 0.0 <= hum <= 100.0:
                self._accumulated["hum"] = hum
                self._dht_ok = True
            if -40.0 <= temp <= 125.0:
                self._accumulated["temp"] = temp
                self._dht_ok = True
            return True

        # DHT22 failure: "Failed to read from DHT sensor!"
        # Count this as a parsed item so burst timing stays correct
        if "failed to read from dht" in line_clean.lower():
            self._dht_ok = False
            logger.debug("DHT22 sensor read failure reported by ESP32")
            return True

        # Single Temp line
        m = re.search(r"Temp(?:erature)?\s*:\s*([\d\.]+)", line_clean, re.IGNORECASE)
        if m:
            temp = float(m.group(1))
            if -40.0 <= temp <= 125.0:
                self._accumulated["temp"] = temp
                self._dht_ok = True
            return True

        # Single Humidity line
        m = re.search(r"Humidity\s*:\s*([\d\.]+)", line_clean, re.IGNORECASE)
        if m:
            hum = float(m.group(1))
            if 0.0 <= hum <= 100.0:
                self._accumulated["hum"] = hum
                self._dht_ok = True
            return True

        return False

    def _build_hardware_frame(self) -> dict:
        """Assemble current accumulated sensor values into an 8-channel frame."""
        self._packet_id += 1
        self.packets_read += 1

        # Replace sentinel -999 with 0.0 ("no reading yet")
        def _safe(key, decimals=2):
            v = self._accumulated[key]
            return round(v, decimals) if v > -900 else 0.0

        values = [
            _safe("temp", 2),
            _safe("hum", 2),
            _safe("dist", 2),
            _safe("mq3", 1),
            _safe("mq135", 1),
            _safe("mq9", 1),
            _safe("mq5", 1),
            _safe("bus", 2),
        ]

        pad = [b % N for b in os.urandom(NUM_CHANNELS)]

        # Indicate DHT22 health in the scenario tag
        scenario = "ESP32_PHYSICAL"
        if not self._dht_ok:
            scenario = "ESP32_PHYSICAL (DHT22 FAIL)"

        frame = {
            "v": values,
            "pad": pad,
            "pid": self._packet_id,
            "scenario": scenario,
        }
        self._last_valid_frame = frame
        return frame

    def close(self) -> None:
        """Close the serial port."""
        if self._serial:
            try:
                self._serial.close()
            except Exception:
                pass
            self._serial = None
            logger.info(f"Serial port {self.port} closed")


# ═══════════════════════════════════════════════════════════════════════════
# UNIFIED SENSOR BRIDGE
# ═══════════════════════════════════════════════════════════════════════════

class SensorBridge:
    """
    Unified sensor data provider that connects to physical ESP32 hardware
    or smoothly falls back to the virtual sensor simulator.
    """

    def __init__(self):
        self.source: str = "SIMULATOR/CSPRNG"
        self._hardware: Optional[HardwareSerialReader] = None
        self._simulator: VirtualSensorGenerator = VirtualSensorGenerator()
        self.active_port: Optional[str] = None
        self.active_baud: int = SERIAL_BAUD
        self.last_status_msg: str = "Simulator active (CSPRNG entropy)"

        # Try to detect ESP32 on startup
        self.auto_connect()

    @property
    def is_hardware(self) -> bool:
        return self._hardware is not None and self._hardware.is_open

    def get_channel_labels(self) -> list[str]:
        return HARDWARE_LABELS if self.is_hardware else SENSOR_LABELS

    def get_channel_units(self) -> list[str]:
        return HARDWARE_UNITS if self.is_hardware else SIMULATOR_UNITS

    def auto_connect(self) -> tuple[bool, str]:
        """Attempt to find and connect to an ESP32 port automatically."""
        port = detect_esp32()
        if port:
            return self.connect_port(port, self.active_baud)
        self.source = "SIMULATOR/CSPRNG"
        self.last_status_msg = "No ESP32 detected - using Simulator"
        return False, self.last_status_msg

    def connect_port(self, port: str, baud: int = SERIAL_BAUD) -> tuple[bool, str]:
        """Connect to a specific serial COM port."""
        self.disconnect()

        reader = HardwareSerialReader(port, baud)
        if reader.connect():
            self._hardware = reader
            self.active_port = port
            self.active_baud = baud
            self.source = f"HARDWARE ({port})"
            self.last_status_msg = f"Connected to ESP32 on {port} @ {baud} baud"
            logger.info(f"✓ {self.last_status_msg}")
            return True, self.last_status_msg
        else:
            self.source = "SIMULATOR/CSPRNG"
            self.last_status_msg = f"Failed to connect to {port}"
            return False, self.last_status_msg

    def disconnect(self) -> tuple[bool, str]:
        """Disconnect physical hardware and revert to simulator."""
        if self._hardware:
            self._hardware.close()
            self._hardware = None
        self.active_port = None
        self.source = "SIMULATOR/CSPRNG"
        self.last_status_msg = "Disconnected from hardware - Simulator active"
        logger.info("Switched to Simulator source")
        return True, self.last_status_msg

    def get_hardware_info(self) -> dict:
        """Return diagnostic status of the hardware connection."""
        available = list_available_ports()
        hw_connected = self.is_hardware
        return {
            "connected": hw_connected,
            "port": self.active_port,
            "baud": self.active_baud,
            "source": self.source,
            "status_message": self.last_status_msg,
            "packets_read": self._hardware.packets_read if hw_connected else 0,
            "last_seen": round(self._hardware.last_seen, 2) if hw_connected else 0,
            "available_ports": available,
        }

    def read_frame(self) -> Optional[dict]:
        """
        Read one sensor frame from the active source (hardware or simulator).
        """
        if self.is_hardware:
            frame = self._hardware.read_frame()
            if frame:
                return frame
            # If hardware was disconnected or timed out for > 8 seconds
            if time.time() - self._hardware.last_seen > 8.0:
                logger.warning(f"No data received from {self.active_port} for 8s — falling back to simulator")
                self.disconnect()
                return self._simulator.generate_reading()

            if self._hardware._last_valid_frame:
                return self._hardware._last_valid_frame

        return self._simulator.generate_reading()

    def close(self) -> None:
        """Clean up hardware connection."""
        self.disconnect()


async def sensor_stream(bridge: SensorBridge) -> AsyncGenerator[dict, None]:
    """
    Async generator yielding sensor frames at the configured interval.
    """
    from config import FRAME_INTERVAL_MS
    interval = FRAME_INTERVAL_MS / 1000.0

    while True:
        frame = await asyncio.get_event_loop().run_in_executor(
            None, bridge.read_frame
        )
        if frame:
            yield frame
        await asyncio.sleep(interval)
