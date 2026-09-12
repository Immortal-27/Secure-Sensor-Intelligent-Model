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
import base64
import io
import hmac
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, UploadFile, File, Form, HTTPException
from fastapi.responses import JSONResponse, FileResponse, StreamingResponse
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
    HMAC_KEY,
)
from crypto_core import (
    process_frame,
    process_frame_tampered,
    EntropyAnalyzer,
    quantize_vector,
    quantize_value,
)
from serial_bridge import SensorBridge, sensor_stream, list_available_ports
from geo_weather import geo_weather_provider
from entropy_engine import generate_file_pad, xor_bytes, compute_file_hmac, feed_hardware_entropy

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
    asyncio.create_task(geo_weather_provider.start_background_loop())
    asyncio.create_task(telemetry_loop())


@app.on_event("shutdown")
async def shutdown_event():
    """Clean up resources."""
    global bridge
    geo_weather_provider.stop()
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

            # Real-time regular API telemetry: Ensure CH 8 (GPS Lat) & CH 9 (Atmos Pressure)
            # strictly reflect live real-time API telemetry on every frame
            live_lat, live_lon, live_pressure = geo_weather_provider.get_realtime_readings()
            if len(raw_values) >= 10:
                raw_values[8] = round(live_lat, 4)
                raw_values[9] = round(live_pressure, 2)

            # Timestamp generated at transmission time and bound into cryptographic HMAC signature
            frame_timestamp = datetime.now(timezone.utc).isoformat()

            # Handle ESP32 disconnected state: do NOT show mock data; emit nulls and flat graph
            if not bridge.is_hardware or raw_values[0] is None:
                packet_count += 1
                channel_labels = bridge.get_channel_labels()
                channel_units = bridge.get_channel_units()

                # Quantize CH 8 & 9 (live regular API readings)
                q_ch8 = quantize_value(raw_values[8], HARDWARE_THRESHOLDS[8])
                q_ch9 = quantize_value(raw_values[9], HARDWARE_THRESHOLDS[9])
                quantized = [None] * 8 + [q_ch8, q_ch9]

                payload = {
                    "timestamp": frame_timestamp,
                    "signed_timestamp": frame_timestamp,
                    "timestamp_bound": False,
                    "signature_algo": "HMAC-SHA256(Quantized||Timestamp)",
                    "packet_id": pid,
                    "source": bridge.source,
                    "is_hardware": False,
                    "scenario": "NO_HARDWARE",
                    "raw_values": raw_values,
                    "quantized": quantized,
                    "pad_used": [None] * NUM_CHANNELS,
                    "ciphertext": [None] * NUM_CHANNELS,
                    "decrypted": [None] * NUM_CHANNELS,
                    "hmac_original": "",
                    "hmac_recomputed": "",
                    "integrity": "DISCONNECTED",
                    "entropy_metrics": {
                        "shannon": None,
                        "chi_squared": None,
                        "min_entropy": None,
                        "window_size": 0,
                    },
                    "channel_labels": channel_labels,
                    "channel_units": channel_units,
                    "geo_weather": geo_weather_provider.get_data(),
                    "hardware_status": bridge.get_hardware_info(),
                    "uptime_seconds": round(time.time() - start_time, 1),
                    "disclaimer": DISCLAIMER,
                }
                latest_frame = payload
                frame_log.append(payload)
                if len(frame_log) > MAX_LOG_FRAMES:
                    frame_log = frame_log[-MAX_LOG_FRAMES:]

                # Broadcast to connected WebSocket clients
                disconnected_clients = []
                for client in connected_clients:
                    try:
                        await client.send_text(json.dumps(payload))
                    except Exception:
                        disconnected_clients.append(client)
                for client in disconnected_clients:
                    connected_clients.remove(client)

                await asyncio.sleep(interval)
                continue

            # Run crypto pipeline with physical hardware quantization thresholds
            active_thresholds = HARDWARE_THRESHOLDS
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
            if pad:
                feed_hardware_entropy(bytes(pad))

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
                "geo_weather": geo_weather_provider.get_data(),
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


@app.get("/api/geo_weather")
async def get_geo_weather():
    """Live Geolocation and Atmospheric Pressure from regular API calls."""
    return JSONResponse(geo_weather_provider.get_data())


@app.post("/api/geo_weather/refresh")
async def refresh_geo_weather(request: Request = None):
    """Trigger an immediate live API refresh for geo & weather."""
    reset_gps = False
    if request:
        try:
            body = await request.json()
            reset_gps = body.get("reset_gps", False)
        except Exception:
            pass
    if reset_gps:
        geo_weather_provider.reset_gps_lock()
    else:
        await asyncio.get_event_loop().run_in_executor(
            None, geo_weather_provider.fetch_sync
        )
    return JSONResponse({
        "success": True,
        "data": geo_weather_provider.get_data(),
    })


@app.post("/api/geo_weather/client_location")
async def update_client_location(request: Request):
    """Update coordinates using browser's high-precision GPS Geolocation API."""
    try:
        body = await request.json()
        lat = body.get("latitude")
        lon = body.get("longitude")
        acc = body.get("accuracy")
        if lat is not None and lon is not None:
            geo_weather_provider.update_from_client_gps(float(lat), float(lon), acc)
            return JSONResponse({
                "success": True,
                "message": f"Updated live GPS to ({lat}, {lon})",
                "data": geo_weather_provider.get_data(),
            })
    except Exception as e:
        logger.error(f"Failed to update client location: {e}")
    return JSONResponse({"success": False, "message": "Invalid request body"}, status_code=400)


@app.get("/api/entropy")
async def get_entropy():
    """Entropy quality metrics and byte distribution histogram."""
    if bridge and not bridge.is_hardware:
        return JSONResponse({
            "metrics": {
                "shannon": None,
                "chi_squared": None,
                "min_entropy": None,
                "window_size": 0,
            },
            "distribution": [0] * 256,
            "is_hardware": False,
        })
    return JSONResponse({
        "metrics": entropy_analyzer.get_metrics(),
        "distribution": entropy_analyzer.get_distribution(),
        "is_hardware": True if bridge and bridge.is_hardware else False,
    })


@app.get("/api/log")
async def get_log():
    """Return the last N telemetry frames."""
    return JSONResponse({"frames": frame_log})


# ═══════════════════════════════════════════════════════════════════════════
# ARBITRARY FILE ENTROPY VAULT (OTP & HMAC-SHA256)
# ═══════════════════════════════════════════════════════════════════════════

MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB
ALLOWED_FILE_EXTENSIONS = {".txt", ".pdf"}


@app.post("/api/file/encrypt")
async def encrypt_file(
    file: UploadFile = File(...),
    mouse_entropy: Optional[str] = Form(None),
    curve_metrics: Optional[str] = Form(None),
):
    """
    Encrypt an arbitrary binary file (.txt, .pdf) using Information-Theoretic One-Time Pad (OTP)
    masking and compute an HMAC-SHA256 integrity digest.
    Accepts optional human kinetic mouse trajectory curve entropy seed and metrics.
    """
    filename = file.filename or "document.bin"
    ext = Path(filename).suffix.lower()
    if ext not in ALLOWED_FILE_EXTENSIONS:
        return JSONResponse(
            status_code=400,
            content={"error": f"Unsupported file type '{ext}'. Allowed extensions: {', '.join(sorted(ALLOWED_FILE_EXTENSIONS))}"}
        )

    # Ingest in-memory using BytesIO buffer
    buffer = io.BytesIO()
    while chunk := await file.read(65536):
        buffer.write(chunk)
        if buffer.tell() > MAX_FILE_SIZE:
            return JSONResponse(
                status_code=413,
                content={"error": f"File exceeds maximum allowed size of {MAX_FILE_SIZE // (1024 * 1024)} MB"}
            )

    content = buffer.getvalue()
    size_bytes = len(content)

    # Compute HMAC-SHA256 over original plaintext bytes
    original_hmac = compute_file_hmac(content, HMAC_KEY)

    # Parse kinetic mouse entropy if supplied
    kinetic_seed_bytes = None
    parsed_curve_metrics = None
    if mouse_entropy:
        try:
            kinetic_seed_bytes = bytes.fromhex(mouse_entropy)
        except Exception:
            kinetic_seed_bytes = mouse_entropy.encode("utf-8")

    if curve_metrics:
        try:
            parsed_curve_metrics = json.loads(curve_metrics)
        except Exception:
            parsed_curve_metrics = {"raw": curve_metrics}

    # Generate exact length one-time pad from physical/CSPRNG entropy mixed with kinetic mouse curve
    pad_bytes = generate_file_pad(size_bytes, kinetic_seed=kinetic_seed_bytes)

    # Fast bitwise XOR OTP masking: C = M ^ K
    cipher_bytes = xor_bytes(content, pad_bytes)

    preview_len = min(32, size_bytes)
    return JSONResponse({
        "filename": filename,
        "size_bytes": size_bytes,
        "original_hmac": original_hmac,
        "ciphertext_b64": base64.b64encode(cipher_bytes).decode("utf-8"),
        "pad_b64": base64.b64encode(pad_bytes).decode("utf-8"),
        "preview_original_hex": content[:preview_len].hex().upper(),
        "preview_pad_hex": pad_bytes[:preview_len].hex().upper(),
        "preview_cipher_hex": cipher_bytes[:preview_len].hex().upper(),
        "kinetic_injected": bool(kinetic_seed_bytes),
        "curve_metrics": parsed_curve_metrics,
    })


@app.post("/api/file/decrypt")
async def decrypt_file(
    ciphertext_file: Optional[UploadFile] = File(None),
    pad_file: Optional[UploadFile] = File(None),
    ciphertext_b64: Optional[str] = Form(None),
    pad_b64: Optional[str] = Form(None),
    expected_hmac: str = Form(...),
    filename: str = Form("restored_file.bin"),
):
    """
    Decrypt an arbitrary file using the OTP pad and verify HMAC-SHA256 integrity.
    Supports either file uploads or base64 form fields.
    """
    # 1. Ingest ciphertext bytes
    if ciphertext_file is not None:
        cipher_bytes = await ciphertext_file.read()
    elif ciphertext_b64:
        try:
            cipher_bytes = base64.b64decode(ciphertext_b64)
        except Exception as e:
            return JSONResponse(status_code=400, content={"error": f"Invalid ciphertext base64: {e}"})
    else:
        return JSONResponse(status_code=400, content={"error": "Missing ciphertext data."})

    # 2. Ingest pad bytes
    if pad_file is not None:
        pad_bytes = await pad_file.read()
    elif pad_b64:
        try:
            pad_bytes = base64.b64decode(pad_b64)
        except Exception as e:
            return JSONResponse(status_code=400, content={"error": f"Invalid pad base64: {e}"})
    else:
        return JSONResponse(status_code=400, content={"error": "Missing pad data."})

    if len(cipher_bytes) != len(pad_bytes):
        return JSONResponse(
            status_code=422,
            content={
                "status": "INTEGRITY_FAILED",
                "error": f"Length mismatch: Ciphertext is {len(cipher_bytes)} bytes, but Pad is {len(pad_bytes)} bytes."
            }
        )

    # 3. OTP Bitwise XOR unmasking: M = C ^ K
    restored_bytes = xor_bytes(cipher_bytes, pad_bytes)

    # 4. Recompute HMAC and verify with constant-time comparison
    recomputed_hmac = compute_file_hmac(restored_bytes, HMAC_KEY)
    clean_expected = expected_hmac.strip().lower()
    if not hmac.compare_digest(recomputed_hmac.lower(), clean_expected):
        return JSONResponse(
            status_code=422,
            content={
                "status": "INTEGRITY_FAILED",
                "error": "Integrity violation: Key pad mismatch or corrupted ciphertext.",
                "expected_hmac": clean_expected,
                "recomputed_hmac": recomputed_hmac,
            }
        )

    # 5. Determine restored filename and media type
    clean_name = Path(filename).name

    # Strip .enc or .pad extension if present
    if clean_name.lower().endswith(".enc"):
        clean_name = clean_name[:-4]
    elif clean_name.lower().endswith(".pad"):
        clean_name = clean_name[:-4]

    # Auto-detect file format from magic bytes or existing extension
    is_pdf = restored_bytes.startswith(b"%PDF") or clean_name.lower().endswith(".pdf")
    
    if is_pdf:
        media_type = "application/pdf"
        if not clean_name.lower().endswith(".pdf"):
            clean_name = f"{Path(clean_name).stem}.pdf"
    else:
        # Check if text
        try:
            restored_bytes.decode("utf-8")
            media_type = "text/plain; charset=utf-8"
            if not clean_name.lower().endswith(".txt"):
                clean_name = f"{Path(clean_name).stem}.txt"
        except UnicodeDecodeError:
            media_type = "application/octet-stream"

    if not clean_name.startswith("restored_"):
        clean_filename = f"restored_{clean_name}"
    else:
        clean_filename = clean_name

    headers = {
        "Content-Disposition": f'attachment; filename="{clean_filename}"',
        "X-Original-Filename": clean_filename,
        "X-Verified-HMAC": recomputed_hmac,
        "Access-Control-Expose-Headers": "Content-Disposition, X-Original-Filename, X-Verified-HMAC",
    }

    return StreamingResponse(
        io.BytesIO(restored_bytes),
        media_type=media_type,
        headers=headers,
    )


@app.post("/api/file/tamper-sim")
async def tamper_sim(
    request: Request,
    ciphertext_file: Optional[UploadFile] = File(None),
    pad_file: Optional[UploadFile] = File(None),
    ciphertext_b64: Optional[str] = Form(None),
    pad_b64: Optional[str] = Form(None),
    expected_hmac: Optional[str] = Form(None),
):
    """
    Deliberately flip 1 bit in the ciphertext or corrupt 1 byte in the pad,
    then attempt integrity verification to demonstrate tamper detection on demand.
    Supports either multipart file uploads or JSON payload.
    """
    cipher_bytes = b""
    pad_bytes = b""
    clean_expected = (expected_hmac or "").strip().lower()

    # 1. Check multipart file upload
    if ciphertext_file is not None:
        cipher_bytes = await ciphertext_file.read()
    elif ciphertext_b64:
        try:
            cipher_bytes = base64.b64decode(ciphertext_b64)
        except Exception:
            pass

    if pad_file is not None:
        pad_bytes = await pad_file.read()
    elif pad_b64:
        try:
            pad_bytes = base64.b64decode(pad_b64)
        except Exception:
            pass

    # 2. Fallback to JSON body if not multipart
    if not cipher_bytes or not pad_bytes:
        try:
            body = await request.json()
            cb64 = body.get("ciphertext_b64") or ""
            pb64 = body.get("pad_b64") or ""
            if cb64 and pb64:
                cipher_bytes = base64.b64decode(cb64)
                pad_bytes = base64.b64decode(pb64)
            if not clean_expected:
                clean_expected = (body.get("expected_hmac") or "").strip().lower()
        except Exception:
            pass

    if not cipher_bytes or not pad_bytes:
        return JSONResponse(status_code=400, content={"error": "Missing ciphertext or pad data in request."})

    # Deliberately flip 1 bit (XOR with 0x01) at byte 0
    tampered_cipher = bytearray(cipher_bytes)
    tampered_cipher[0] ^= 0x01

    # Unmask with tampered ciphertext
    corrupted_plaintext = xor_bytes(bytes(tampered_cipher), bytes(pad_bytes))
    tampered_hmac = compute_file_hmac(corrupted_plaintext, HMAC_KEY)

    return JSONResponse(
        status_code=422,
        content={
            "status": "INTEGRITY_FAILED",
            "tampered": True,
            "tamper_detail": "Deliberate single-bit flip injected at byte 0 (bit 0 inverted)",
            "expected_hmac": clean_expected,
            "recomputed_hmac": tampered_hmac,
            "error": "Integrity violation: Key pad mismatch or corrupted ciphertext.",
        }
    )


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
