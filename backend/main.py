"""
main.py — FastAPI backend for the Quantum-Resilient IoT Telemetry Pipeline.

Serves:
  - REST API endpoints for status, config, latest telemetry, entropy metrics,
    and tamper testing.
  - WebSocket endpoint for real-time streaming of full pipeline frames.
  - Static file serving for the dashboard frontend.

Run:
    cd backend
    python main.py
    # or: uvicorn main:app --host 0.0.0.0 --port 8000 --reload

DISCLAIMER:
  This is an information-theoretic OTP demonstration using physical entropy.
  It is NOT a replacement for production authenticated encryption (AES-GCM,
  ChaCha20-Poly1305). The pad is transmitted alongside ciphertext for
  educational purposes only.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

# Ensure the backend directory is on the Python path
sys.path.insert(0, str(Path(__file__).parent))

from config import (
    N,
    NUM_CHANNELS,
    SENSOR_LABELS,
    HARDWARE_LABELS,
    HARDWARE_UNITS,
    SIMULATOR_UNITS,
    THRESHOLDS,
    HARDWARE_THRESHOLDS,
    HOST,
    PORT,
    FRAME_INTERVAL_MS,
    MAX_LOG_FRAMES,
)
from crypto_core import (
    process_frame,
    process_frame_tampered,
    EntropyAnalyzer,
    quantize_vector,
)
from serial_bridge import SensorBridge, sensor_stream, list_available_ports

# ═══════════════════════════════════════════════════════════════════════════
# LOGGING
# ═══════════════════════════════════════════════════════════════════════════

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("main")

# ═══════════════════════════════════════════════════════════════════════════
# APPLICATION STATE
# ═══════════════════════════════════════════════════════════════════════════

DISCLAIMER = (
    "This is an information-theoretic One-Time Pad (OTP) demonstration "
    "using physical entropy from ESP32 hardware TRNG. It is NOT a "
    "replacement for production authenticated encryption standards "
    "(AES-GCM, ChaCha20-Poly1305). The pad is transmitted alongside "
    "ciphertext for educational and demonstration purposes only."
)

app = FastAPI(
    title="Quantum-Resilient IoT Telemetry Pipeline",
    description=DISCLAIMER,
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global state
bridge: Optional[SensorBridge] = None
entropy_analyzer = EntropyAnalyzer()
latest_frame: Optional[dict] = None
frame_log: list[dict] = []
start_time = time.time()
packet_count = 0
connected_clients: set[WebSocket] = set()
tamper_next: bool = False
tamper_mode: str = "data"


# ═══════════════════════════════════════════════════════════════════════════
# STARTUP & SHUTDOWN
# ═══════════════════════════════════════════════════════════════════════════

@app.on_event("startup")
async def startup_event():
    """Initialize the sensor bridge and start the background telemetry loop."""
    global bridge
    bridge = SensorBridge()
    logger.info(f"╔══════════════════════════════════════════════════════╗")
    logger.info(f"║  Quantum-Resilient IoT Telemetry Pipeline           ║")
    logger.info(f"║  Source: {bridge.source:<43s} ║")
    logger.info(f"║  Modulus N: {N:<41d} ║")
    logger.info(f"║  Channels: {NUM_CHANNELS:<41d} ║")
    logger.info(f"╚══════════════════════════════════════════════════════╝")
    asyncio.create_task(telemetry_loop())


@app.on_event("shutdown")
async def shutdown_event():
    """Clean up resources."""
    global bridge
    if bridge:
        bridge.close()
    logger.info("Server shutdown — resources cleaned up")


# ═══════════════════════════════════════════════════════════════════════════
# BACKGROUND TELEMETRY LOOP
# ═══════════════════════════════════════════════════════════════════════════

async def telemetry_loop():
    """
    Background task: reads sensor frames, runs the full crypto pipeline,
    and broadcasts results to all connected WebSocket clients.
    """
    global latest_frame, frame_log, packet_count, tamper_next, tamper_mode, bridge

    interval = FRAME_INTERVAL_MS / 1000.0

    while True:
        try:
            if bridge is None:
                await asyncio.sleep(interval)
                continue

            # Read sensor frame (runs in executor to avoid blocking)
            raw_frame = await asyncio.get_event_loop().run_in_executor(
                None, bridge.read_frame
            )

            if raw_frame is None:
                await asyncio.sleep(interval)
                continue

            raw_values = raw_frame["v"]
            pad = raw_frame["pad"]
            pid = raw_frame.get("pid", packet_count + 1)
            scenario = raw_frame.get("scenario", "UNKNOWN")

            # Timestamp generated at transmission time and bound into cryptographic HMAC signature
            frame_timestamp = datetime.now(timezone.utc).isoformat()

            # Run crypto pipeline with appropriate quantization thresholds
            active_thresholds = HARDWARE_THRESHOLDS if bridge.is_hardware else THRESHOLDS
            if tamper_next:
                result = process_frame_tampered(
                    raw_values,
                    pad,
                    timestamp=frame_timestamp,
                    tamper_type=tamper_mode,
                    thresholds=active_thresholds,
                )
                tamper_next = False
            else:
                result = process_frame(
                    raw_values,
                    pad,
                    timestamp=frame_timestamp,
                    thresholds=active_thresholds,
                )

            # Record entropy
            entropy_analyzer.record(pad)

            # Dynamic sensor labels and units
            channel_labels = bridge.get_channel_labels()
            channel_units = bridge.get_channel_units()

            # Build full telemetry payload
            packet_count += 1
            payload = {
                "timestamp": result["timestamp"],
                "signed_timestamp": result.get("signed_timestamp", result["timestamp"]),
                "timestamp_bound": True,
                "signature_algo": "HMAC-SHA256(Quantized||Timestamp)",
                "packet_id": pid,
                "source": bridge.source,
                "is_hardware": bridge.is_hardware,
                "scenario": scenario,
                "raw_values": result["raw_values"],
                "quantized": result["quantized"],
                "pad_used": result["pad_used"],
                "ciphertext": result["ciphertext"],
                "decrypted": result["decrypted"],
                "hmac_original": result["hmac_original"],
                "hmac_recomputed": result["hmac_recomputed"],
                "integrity": result["integrity"],
                "entropy_metrics": entropy_analyzer.get_metrics(),
                "channel_labels": channel_labels,
                "channel_units": channel_units,
                "hardware_status": bridge.get_hardware_info(),
                "uptime_seconds": round(time.time() - start_time, 1),
                "disclaimer": DISCLAIMER,
            }

            # Add tamper info if present
            if "tamper_type" in result:
                payload["tamper_type"] = result["tamper_type"]
            if "tampered_channel" in result:
                payload["tampered_channel"] = result["tampered_channel"]
            if "tampered_timestamp" in result:
                payload["tampered_timestamp"] = result["tampered_timestamp"]
            if "ciphertext_original" in result:
                payload["ciphertext_original"] = result.get("ciphertext_original")

            latest_frame = payload

            # Maintain frame log
            frame_log.append(payload)
            if len(frame_log) > MAX_LOG_FRAMES:
                frame_log = frame_log[-MAX_LOG_FRAMES:]

            # Broadcast to WebSocket clients
            message = json.dumps(payload)
            disconnected = set()
            for ws in connected_clients:
                try:
                    await ws.send_text(message)
                except Exception:
                    disconnected.add(ws)
            connected_clients.difference_update(disconnected)

        except Exception as exc:
            logger.error(f"Telemetry loop error: {exc}", exc_info=True)

        await asyncio.sleep(interval)


# ═══════════════════════════════════════════════════════════════════════════
# REST API ENDPOINTS
# ═══════════════════════════════════════════════════════════════════════════

@app.get("/api/status")
async def get_status():
    """System status: source mode, uptime, packet count."""
    return JSONResponse({
        "status": "online",
        "source": bridge.source if bridge else "INITIALIZING",
        "uptime_seconds": round(time.time() - start_time, 1),
        "packet_count": packet_count,
        "connected_clients": len(connected_clients),
        "modulus_N": N,
        "num_channels": NUM_CHANNELS,
        "disclaimer": DISCLAIMER,
    })


@app.get("/api/config")
async def get_config():
    """Public crypto and channel configuration."""
    return JSONResponse({
        "modulus_N": N,
        "num_channels": NUM_CHANNELS,
        "sensor_labels": SENSOR_LABELS,
        "thresholds": THRESHOLDS,
        "frame_interval_ms": FRAME_INTERVAL_MS,
        "disclaimer": DISCLAIMER,
    })


@app.get("/api/latest")
async def get_latest():
    """Latest full pipeline snapshot."""
    if latest_frame is None:
        return JSONResponse(
            {"error": "No telemetry data available yet"},
            status_code=503,
        )
    return JSONResponse(latest_frame)


@app.get("/api/entropy")
async def get_entropy():
    """Entropy quality metrics and byte distribution histogram."""
    return JSONResponse({
        "metrics": entropy_analyzer.get_metrics(),
        "distribution": entropy_analyzer.get_distribution(),
    })


@app.get("/api/log")
async def get_log():
    """Return the last N telemetry frames."""
    return JSONResponse({"frames": frame_log})


@app.post("/api/tamper")
async def trigger_tamper(request: Request = None):
    """
    Flag the next frame for deliberate corruption (ciphertext or timestamp) to
    demonstrate HMAC integrity failure and verify tamper in real-time.
    Accepts JSON body: {"type": "data"} or {"type": "timestamp"}.
    """
    global tamper_next, tamper_mode
    tamper_mode = "data"
    if request:
        try:
            body = await request.json()
            if isinstance(body, dict) and body.get("type") in ("timestamp", "data"):
                tamper_mode = body.get("type")
        except Exception:
            pass

    tamper_next = True
    logger.warning(f"[TAMPER TEST] Next frame will be tampered (mode={tamper_mode})")
    return JSONResponse({
        "status": "tamper_armed",
        "tamper_mode": tamper_mode,
        "message": f"Next telemetry frame will have corrupted {tamper_mode} to demonstrate HMAC signature integrity failure.",
    })


@app.get("/api/ports")
async def get_ports():
    """Scan and return all available serial COM ports."""
    ports = list_available_ports()
    return JSONResponse({"ports": ports})


@app.post("/api/connect_esp")
async def connect_esp(request_data: Optional[dict] = None):
    """
    Connect to a specific serial port or auto-detect an ESP32.
    Accepts JSON: {"port": "COM3", "baud": 115200}
    """
    global bridge
    if bridge is None:
        bridge = SensorBridge()

    port = None
    baud = 115200
    if request_data:
        port = request_data.get("port")
        try:
            baud = int(request_data.get("baud", 115200))
        except (ValueError, TypeError):
            baud = 115200

    if port:
        success, msg = bridge.connect_port(port, baud)
    else:
        success, msg = bridge.auto_connect()

    return JSONResponse({
        "success": success,
        "message": msg,
        "info": bridge.get_hardware_info(),
    })


@app.post("/api/disconnect_esp")
async def disconnect_esp():
    """Disconnect physical hardware and switch back to simulator."""
    global bridge
    if bridge:
        success, msg = bridge.disconnect()
        return JSONResponse({
            "success": success,
            "message": msg,
            "info": bridge.get_hardware_info(),
        })
    return JSONResponse({"success": True, "message": "Simulator active", "info": {}})


@app.get("/api/hardware_status")
async def get_hardware_status():
    """Return live ESP32 connection state and port details."""
    if bridge:
        return JSONResponse(bridge.get_hardware_info())
    return JSONResponse({"connected": False, "source": "INITIALIZING"})


# ═══════════════════════════════════════════════════════════════════════════
# WEBSOCKET ENDPOINT
# ═══════════════════════════════════════════════════════════════════════════

@app.websocket("/ws/telemetry")
async def websocket_telemetry(ws: WebSocket):
    """
    Real-time WebSocket endpoint for streaming telemetry pipeline output.

    Clients connect and receive JSON frames automatically from the
    background telemetry loop. No messages need to be sent by the client.
    """
    await ws.accept()
    connected_clients.add(ws)
    logger.info(f"WebSocket client connected (total: {len(connected_clients)})")

    try:
        # Send the latest frame immediately if available
        if latest_frame:
            await ws.send_text(json.dumps(latest_frame))

        # Keep the connection alive — frames are pushed by telemetry_loop
        while True:
            # Wait for client messages (ping/pong or disconnect)
            try:
                data = await asyncio.wait_for(ws.receive_text(), timeout=30.0)
            except asyncio.TimeoutError:
                # Send a keepalive ping
                try:
                    await ws.send_text(json.dumps({"type": "ping"}))
                except Exception:
                    break
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.warning(f"WebSocket error: {exc}")
    finally:
        connected_clients.discard(ws)
        logger.info(f"WebSocket client disconnected (total: {len(connected_clients)})")


# ═══════════════════════════════════════════════════════════════════════════
# STATIC FILE SERVING (Dashboard)
# ═══════════════════════════════════════════════════════════════════════════

# Resolve the dashboard directory relative to this file
DASHBOARD_DIR = Path(__file__).parent.parent / "dashboard"

if DASHBOARD_DIR.exists():
    @app.get("/")
    async def serve_dashboard():
        """Serve the main dashboard HTML file."""
        index_path = DASHBOARD_DIR / "index.html"
        if index_path.exists():
            return FileResponse(str(index_path))
        return JSONResponse({"error": "Dashboard not found"}, status_code=404)

    app.mount(
        "/static",
        StaticFiles(directory=str(DASHBOARD_DIR)),
        name="dashboard",
    )
    logger.info(f"Dashboard served from: {DASHBOARD_DIR}")
else:
    logger.warning(f"Dashboard directory not found: {DASHBOARD_DIR}")


# ═══════════════════════════════════════════════════════════════════════════
# ENTRY POINT
# ═══════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    import uvicorn

    logger.info(f"Starting server on {HOST}:{PORT}")
    uvicorn.run(
        "main:app",
        host=HOST,
        port=PORT,
        reload=False,
        log_level="info",
    )
