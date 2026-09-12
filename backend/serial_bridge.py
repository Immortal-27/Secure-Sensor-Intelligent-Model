"""
serial_bridge.py — ESP32 auto-detection and unified sensor stream provider.

Scans all available serial ports for an ESP32 device. If found, reads
JSON telemetry frames from the hardware over USB Serial. If no ESP32 is
detected, seamlessly falls back to the internal VirtualSensorGenerator.

Provides a unified async generator `sensor_stream()` consumed by the
FastAPI WebSocket and REST endpoints.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import AsyncGenerator, Optional

from config import SERIAL_BAUD, SERIAL_TIMEOUT, N, NUM_CHANNELS
from simulator import VirtualSensorGenerator

logger = logging.getLogger("serial_bridge")
logger.setLevel(logging.INFO)

# ═══════════════════════════════════════════════════════════════════════════
# ESP32 HARDWARE DETECTION
# ═══════════════════════════════════════════════════════════════════════════

def detect_esp32() -> Optional[str]:
    """
    Scan all available serial ports and attempt to identify an ESP32 device.

    Looks for common ESP32 USB-to-Serial chip identifiers in the port
    description or hardware ID (CP210x, CH340, FTDI, etc.).

    Returns
    -------
    str or None
        The serial port name (e.g., 'COM3', '/dev/ttyUSB0') if an ESP32
        is detected, or None if no compatible device is found.
    """
    try:
        import serial.tools.list_ports
    except ImportError:
        logger.warning("pyserial not installed — cannot scan for ESP32 hardware")
        return None

    esp32_identifiers = [
        "CP210",     # Silicon Labs CP2102/CP2104
        "CH340",     # WCH CH340
        "CH910",     # WCH CH9102
        "FTDI",      # FTDI chips
        "USB Serial",
        "USB-SERIAL",
        "ESP32",
        "SLAB_USBtoUART",
    ]

    ports = serial.tools.list_ports.comports()
    for port in ports:
        port_info = f"{port.description} {port.hwid}".upper()
        for ident in esp32_identifiers:
            if ident.upper() in port_info:
                logger.info(
                    f"ESP32 detected on {port.device} "
                    f"({port.description}, HWID: {port.hwid})"
                )
                return port.device

    logger.info(
        f"No ESP32 detected among {len(ports)} port(s): "
        f"{[p.device for p in ports]}"
    )
    return None


# ═══════════════════════════════════════════════════════════════════════════
# HARDWARE SERIAL READER
# ═══════════════════════════════════════════════════════════════════════════

class HardwareSerialReader:
    """
    Reads JSON telemetry frames from an ESP32 over USB Serial.

    Expected JSON format per line:
        {"v":[f0,...,f7], "pad":[k0,...,k7], "pid": N}
    """

    def __init__(self, port: str, baud: int = SERIAL_BAUD):
        self._port = port
        self._baud = baud
        self._serial = None

    def connect(self) -> bool:
        """Open the serial port. Returns True on success."""
        try:
            import serial as pyserial
            self._serial = pyserial.Serial(
                self._port,
                self._baud,
                timeout=SERIAL_TIMEOUT,
            )
            # Flush any startup junk
            self._serial.reset_input_buffer()
            logger.info(f"Serial port {self._port} opened at {self._baud} baud")
            return True
        except Exception as exc:
            logger.error(f"Failed to open serial port {self._port}: {exc}")
            self._serial = None
            return False

    def read_frame(self) -> Optional[dict]:
        """
        Read one JSON frame from the serial port.

        Skips comment lines (starting with '#') and blank lines.
        Returns None if no valid frame is available.
        """
        if self._serial is None:
            return None

        try:
            line = self._serial.readline().decode("utf-8", errors="replace").strip()
            if not line or line.startswith("#"):
                return None
            frame = json.loads(line)
            # Validate structure
            if "v" in frame and "pad" in frame and "pid" in frame:
                if (
                    len(frame["v"]) == NUM_CHANNELS
                    and len(frame["pad"]) == NUM_CHANNELS
                ):
                    return frame
            logger.warning(f"Malformed frame: {line[:80]}")
            return None
        except json.JSONDecodeError:
            return None
        except Exception as exc:
            logger.error(f"Serial read error: {exc}")
            return None

    def close(self) -> None:
        """Close the serial port."""
        if self._serial and self._serial.is_open:
            self._serial.close()
            logger.info(f"Serial port {self._port} closed")


# ═══════════════════════════════════════════════════════════════════════════
# UNIFIED SENSOR STREAM
# ═══════════════════════════════════════════════════════════════════════════

class SensorBridge:
    """
    Unified sensor data provider that auto-detects ESP32 hardware and
    falls back to the virtual sensor simulator.

    Attributes
    ----------
    source : str
        "HARDWARE/TRNG" if reading from ESP32, "SIMULATOR/CSPRNG" otherwise.
    """

    def __init__(self):
        self.source: str = "SIMULATOR/CSPRNG"
        self._hardware: Optional[HardwareSerialReader] = None
        self._simulator: Optional[VirtualSensorGenerator] = None
        self._detect_and_connect()

    def _detect_and_connect(self) -> None:
        """Try to detect and connect to ESP32 hardware."""
        port = detect_esp32()
        if port:
            reader = HardwareSerialReader(port)
            if reader.connect():
                self._hardware = reader
                self.source = "HARDWARE/TRNG"
                logger.info("✓ Using HARDWARE source (ESP32 TRNG)")
                return
            else:
                logger.warning("ESP32 detected but connection failed — falling back to simulator")

        self._simulator = VirtualSensorGenerator()
        self.source = "SIMULATOR/CSPRNG"
        logger.info("✓ Using SIMULATOR source (CSPRNG entropy)")

    def read_frame(self) -> Optional[dict]:
        """
        Read one sensor frame from the active source (hardware or simulator).

        Returns
        -------
        dict or None
            Sensor frame: {"v": [...], "pad": [...], "pid": int}
        """
        if self._hardware:
            frame = self._hardware.read_frame()
            if frame:
                return frame
            # Hardware read failed — check if port is still alive
            logger.warning("Hardware read returned None — may be disconnected")
            return None

        if self._simulator:
            return self._simulator.generate_reading()

        return None

    def close(self) -> None:
        """Clean up resources."""
        if self._hardware:
            self._hardware.close()


async def sensor_stream(bridge: SensorBridge) -> AsyncGenerator[dict, None]:
    """
    Async generator that yields sensor frames at the configured interval.

    This is the primary data source consumed by the FastAPI WebSocket
    endpoint and the background telemetry loop.

    Parameters
    ----------
    bridge : SensorBridge
        The initialized sensor bridge (hardware or simulator).

    Yields
    ------
    dict
        Sensor frame with keys: v, pad, pid
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


# ═══════════════════════════════════════════════════════════════════════════
# STANDALONE TEST
# ═══════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    import time
    from config import SENSOR_LABELS

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    )

    print("=" * 60)
    print("  SERIAL BRIDGE — STANDALONE TEST")
    print("=" * 60)

    bridge = SensorBridge()
    print(f"\nSource: {bridge.source}\n")

    for i in range(5):
        frame = bridge.read_frame()
        if frame:
            print(f"Frame #{frame['pid']}:")
            for ch in range(NUM_CHANNELS):
                print(
                    f"  {SENSOR_LABELS[ch]:>12s}: "
                    f"val={frame['v'][ch]:>10.2f}  "
                    f"pad={frame['pad'][ch]:>3d}"
                )
        time.sleep(1)

    bridge.close()
    print("\n✓ Serial bridge test complete.")
