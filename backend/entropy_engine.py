"""
entropy_engine.py — Helper routines for arbitrary file entropy masking and integrity verification.

Implements Information-Theoretic One-Time Pad (OTP) masking and HMAC-SHA256 integrity tagging
for arbitrary binary files (.txt, .pdf, etc.).
"""

from __future__ import annotations

import hashlib
import hmac
import os
import threading
from typing import Optional

# Shared thread-safe hardware entropy buffer
_entropy_lock = threading.Lock()
_hardware_entropy_pool = bytearray()
MAX_POOL_SIZE = 65536


def feed_hardware_entropy(entropy_bytes: bytes) -> None:
    """Feed physical entropy bytes (e.g. from ESP32 TRNG) into the pool."""
    if not entropy_bytes:
        return
    with _entropy_lock:
        _hardware_entropy_pool.extend(entropy_bytes)
        if len(_hardware_entropy_pool) > MAX_POOL_SIZE:
            del _hardware_entropy_pool[:-MAX_POOL_SIZE]


def generate_file_pad(length: int) -> bytes:
    """
    Generate an OTP pad of exact `length` bytes.
    Pulls bytes from the hardware entropy buffer if available;
    falls back immediately to os.urandom(length) so file processing never blocks.
    """
    if length <= 0:
        return b""

    with _entropy_lock:
        avail = len(_hardware_entropy_pool)
        if avail >= length:
            pad = bytes(_hardware_entropy_pool[:length])
            del _hardware_entropy_pool[:length]
            return pad
        elif avail > 0:
            hw_part = bytes(_hardware_entropy_pool)
            _hardware_entropy_pool.clear()
            needed = length - len(hw_part)
            return hw_part + os.urandom(needed)

    # Fast fallback to cryptographically secure OS random source
    return os.urandom(length)


def xor_bytes(data: bytes, pad: bytes) -> bytes:
    """
    Fast bitwise XOR between data and pad bytes:
    C = M ^ K  or  M = C ^ K
    """
    return bytes(a ^ b for a, b in zip(data, pad))


def compute_file_hmac(data: bytes, secret: bytes) -> str:
    """
    Compute HMAC-SHA256 digest over arbitrary binary data.
    """
    return hmac.new(secret, data, hashlib.sha256).hexdigest()
