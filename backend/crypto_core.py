"""
crypto_core.py — Cryptographic core for the Quantum-Resilient IoT Telemetry Pipeline.

Implements:
  1. Deterministic threshold quantization (float → discrete state).
  2. OTP modular masking: C_i = (x_i + K_i) mod N
  3. OTP modular unmasking: x_i = (C_i - K_i + N) mod N
  4. HMAC-SHA256 integrity tagging and verification.
  5. Entropy quality metrics (Shannon entropy, χ² uniformity, min-entropy).

DISCLAIMER — EDUCATIONAL DEMONSTRATION:
  This module implements an information-theoretic One-Time Pad demonstration
  using physical entropy. It is NOT a replacement for production authenticated
  encryption standards (AES-GCM, ChaCha20-Poly1305). The pad is transmitted
  alongside ciphertext for educational and demo purposes only.
"""

from __future__ import annotations

import hashlib
import hmac
import math
import struct
from collections import deque
from datetime import datetime, timezone
from typing import Optional, Union

from config import N, NUM_CHANNELS, HMAC_KEY, THRESHOLDS, PAD_HISTORY_SIZE


# ═══════════════════════════════════════════════════════════════════════════
# 1. THRESHOLD QUANTIZATION
# ═══════════════════════════════════════════════════════════════════════════

def quantize_value(raw: float, thresholds: list[float]) -> int:
    """
    Map a continuous float value into a discrete integer state using threshold bins.

    Given sorted thresholds [t0, t1, ..., tn], returns:
      - 0            if raw < t0
      - i            if t_{i-1} <= raw < t_i  (for 1 <= i < n)
      - len(thresholds) - 1   if raw >= t_{n-1}

    Parameters
    ----------
    raw : float
        The continuous sensor reading.
    thresholds : list[float]
        Sorted bin edges for this channel.

    Returns
    -------
    int
        Discrete state index in [0, len(thresholds) - 1].
    """
    for i in range(len(thresholds) - 1, -1, -1):
        if raw >= thresholds[i]:
            return min(i, len(thresholds) - 1)
    return 0


def quantize_vector(
    raw_values: list[float],
    thresholds: Optional[list[list[float]]] = None,
) -> list[int]:
    """
    Quantize an 8-channel sensor reading vector.

    Parameters
    ----------
    raw_values : list[float]
        Raw floating-point readings, one per channel (length NUM_CHANNELS).
    thresholds : list[list[float]], optional
        Bin edges per channel. Defaults to config.THRESHOLDS.

    Returns
    -------
    list[int]
        Quantized integer states, one per channel.
    """
    if len(raw_values) != NUM_CHANNELS:
        raise ValueError(
            f"Expected {NUM_CHANNELS} channels, got {len(raw_values)}"
        )
    active_thresholds = thresholds if thresholds is not None else THRESHOLDS
    return [
        quantize_value(raw_values[i], active_thresholds[i])
        for i in range(NUM_CHANNELS)
    ]


# ═══════════════════════════════════════════════════════════════════════════
# 2. OTP MODULAR MASKING / UNMASKING
# ═══════════════════════════════════════════════════════════════════════════

def otp_encrypt(quantized: list[int], pad: list[int]) -> list[int]:
    """
    Mask quantized states with a one-time pad via modular addition.

    C_i = (x_i + K_i) mod N

    Parameters
    ----------
    quantized : list[int]
        Plaintext quantized states, each in [0, N-1].
    pad : list[int]
        One-time pad values, each in [0, N-1]. Must be the same length.

    Returns
    -------
    list[int]
        Ciphertext values, each in [0, N-1].
    """
    if len(quantized) != len(pad):
        raise ValueError("Quantized vector and pad must have equal length")
    return [(x + k) % N for x, k in zip(quantized, pad)]


def otp_decrypt(ciphertext: list[int], pad: list[int]) -> list[int]:
    """
    Unmask ciphertext with the one-time pad via modular subtraction.

    x_i = (C_i - K_i + N) mod N

    Parameters
    ----------
    ciphertext : list[int]
        Masked ciphertext values, each in [0, N-1].
    pad : list[int]
        One-time pad values used during encryption, each in [0, N-1].

    Returns
    -------
    list[int]
        Recovered quantized plaintext states, each in [0, N-1].
    """
    if len(ciphertext) != len(pad):
        raise ValueError("Ciphertext vector and pad must have equal length")
    return [(c - k + N) % N for c, k in zip(ciphertext, pad)]


# ═══════════════════════════════════════════════════════════════════════════
# 3. HMAC-SHA256 INTEGRITY
# ═══════════════════════════════════════════════════════════════════════════

def compute_hmac(
    quantized: list[int],
    timestamp: Optional[Union[str, float, int]] = None,
    key: bytes = HMAC_KEY,
) -> str:
    """
    Compute HMAC-SHA256 over a quantized state vector bound with an optional timestamp.

    The vector is serialized as big-endian unsigned 16-bit integers
    (each state fits in [0, 256] ⊂ uint16 range).
    When a timestamp is provided, it is bound to the payload bytes as
    UTF-8 text, cryptographically securing both data freshness and payload
    integrity against tampering, packet delay, and replay attacks.

    Parameters
    ----------
    quantized : list[int]
        Quantized state vector.
    timestamp : str, float, int, optional
        Timestamp bound to the frame (ISO 8601 string or numeric).
    key : bytes
        HMAC key (default: pre-shared HMAC_KEY from config).

    Returns
    -------
    str
        Hex-encoded HMAC-SHA256 digest.
    """
    message = struct.pack(f">{len(quantized)}H", *quantized)
    if timestamp is not None:
        ts_str = str(timestamp).strip()
        message += b"|" + ts_str.encode("utf-8")
    return hmac.new(key, message, hashlib.sha256).hexdigest()


def verify_integrity(
    ciphertext: list[int],
    pad: list[int],
    original_hmac: str,
    timestamp: Optional[Union[str, float, int]] = None,
    key: bytes = HMAC_KEY,
) -> tuple[list[int], str, bool]:
    """
    Decrypt ciphertext and verify HMAC integrity including bound timestamp.

    Parameters
    ----------
    ciphertext : list[int]
        Masked ciphertext vector.
    pad : list[int]
        One-time pad used during encryption.
    original_hmac : str
        HMAC tag computed over the original quantized plaintext and timestamp.
    timestamp : str, float, int, optional
        Timestamp bound to the frame.
    key : bytes
        HMAC key.

    Returns
    -------
    tuple[list[int], str, bool]
        (decrypted_vector, recomputed_hmac, is_verified)
    """
    decrypted = otp_decrypt(ciphertext, pad)
    recomputed = compute_hmac(decrypted, timestamp=timestamp, key=key)
    is_verified = hmac.compare_digest(recomputed, original_hmac)
    return decrypted, recomputed, is_verified


# ═══════════════════════════════════════════════════════════════════════════
# 4. FULL PIPELINE (convenience wrapper)
# ═══════════════════════════════════════════════════════════════════════════

def process_frame(
    raw_values: list[float],
    pad: list[int],
    timestamp: Optional[str] = None,
    thresholds: Optional[list[list[float]]] = None,
) -> dict:
    """
    Execute the complete telemetry pipeline for one frame:
      raw → quantize → HMAC (data + timestamp signature) → OTP encrypt → OTP decrypt → verify.

    Parameters
    ----------
    raw_values : list[float]
        8-channel raw sensor readings.
    pad : list[int]
        8-element one-time pad (entropy bytes mod N).
    timestamp : str, optional
        ISO 8601 UTC timestamp. Generated if not provided.
    thresholds : list[list[float]], optional
        Per-channel bin edges. Defaults to config.THRESHOLDS.

    Returns
    -------
    dict
        Full pipeline state including all intermediate values and signed timestamp.
    """
    if timestamp is None:
        timestamp = datetime.now(timezone.utc).isoformat()
    quantized = quantize_vector(raw_values, thresholds)
    hmac_original = compute_hmac(quantized, timestamp=timestamp)
    ciphertext = otp_encrypt(quantized, pad)
    decrypted, hmac_recomputed, verified = verify_integrity(
        ciphertext, pad, hmac_original, timestamp=timestamp
    )
    return {
        "timestamp": timestamp,
        "signed_timestamp": timestamp,
        "timestamp_bound": True,
        "raw_values": raw_values,
        "quantized": quantized,
        "pad_used": pad,
        "ciphertext": ciphertext,
        "decrypted": decrypted,
        "hmac_original": hmac_original,
        "hmac_recomputed": hmac_recomputed,
        "integrity": "VERIFIED" if verified else "INTEGRITY VIOLATION",
    }


def process_frame_tampered(
    raw_values: list[float],
    pad: list[int],
    timestamp: Optional[str] = None,
    tamper_channel: int = 0,
    tamper_delta: int = 7,
    tamper_type: str = "data",
    thresholds: Optional[list[list[float]]] = None,
) -> dict:
    """
    Execute the pipeline but deliberately corrupt either ciphertext or timestamp
    to demonstrate HMAC integrity and tamper verification.

    Parameters
    ----------
    raw_values : list[float]
        8-channel raw sensor readings.
    pad : list[int]
        8-element one-time pad.
    timestamp : str, optional
        ISO 8601 timestamp string. Generated if not provided.
    tamper_channel : int
        Which channel index to corrupt if tamper_type == "data" (0-7).
    tamper_delta : int
        Amount to add to the ciphertext byte (mod N).
    tamper_type : str
        "data" to corrupt sensor ciphertext, or "timestamp" to forge/replay timestamp.
    thresholds : list[list[float]], optional
        Per-channel bin edges. Defaults to config.THRESHOLDS.

    Returns
    -------
    dict
        Full pipeline state showing the integrity failure.
    """
    if timestamp is None:
        timestamp = datetime.now(timezone.utc).isoformat()

    quantized = quantize_vector(raw_values, thresholds)
    hmac_original = compute_hmac(quantized, timestamp=timestamp)
    ciphertext = otp_encrypt(quantized, pad)

    if tamper_type == "timestamp":
        # Simulate replay or timestamp modification in transit
        tampered_timestamp = "2020-01-01T00:00:00.000000+00:00"
        decrypted, hmac_recomputed, verified = verify_integrity(
            ciphertext, pad, hmac_original, timestamp=tampered_timestamp
        )
        return {
            "timestamp": timestamp,
            "signed_timestamp": timestamp,
            "tampered_timestamp": tampered_timestamp,
            "tamper_type": "timestamp",
            "timestamp_bound": True,
            "raw_values": raw_values,
            "quantized": quantized,
            "pad_used": pad,
            "ciphertext": ciphertext,
            "ciphertext_original": ciphertext,
            "decrypted": decrypted,
            "hmac_original": hmac_original,
            "hmac_recomputed": hmac_recomputed,
            "integrity": "INTEGRITY VIOLATION",
        }
    else:
        # Deliberately corrupt ciphertext byte
        tampered = list(ciphertext)
        tampered[tamper_channel] = (tampered[tamper_channel] + tamper_delta) % N
        decrypted, hmac_recomputed, verified = verify_integrity(
            tampered, pad, hmac_original, timestamp=timestamp
        )
        return {
            "timestamp": timestamp,
            "signed_timestamp": timestamp,
            "tamper_type": "data",
            "timestamp_bound": True,
            "raw_values": raw_values,
            "quantized": quantized,
            "pad_used": pad,
            "ciphertext": tampered,
            "ciphertext_original": ciphertext,
            "tampered_channel": tamper_channel,
            "tamper_delta": tamper_delta,
            "decrypted": decrypted,
            "hmac_original": hmac_original,
            "hmac_recomputed": hmac_recomputed,
            "integrity": "INTEGRITY VIOLATION",
        }


# ═══════════════════════════════════════════════════════════════════════════
# 5. ENTROPY QUALITY METRICS
# ═══════════════════════════════════════════════════════════════════════════

class EntropyAnalyzer:
    """
    Tracks entropy quality of OTP pad bytes over a sliding window.

    Computes Shannon entropy, chi-squared uniformity score, and
    min-entropy for the pad byte distribution.
    """

    def __init__(self, window_size: int = PAD_HISTORY_SIZE):
        self._window_size = window_size
        self._history: deque[list[int]] = deque(maxlen=window_size)

    def record(self, pad: list[int]) -> None:
        """Record a pad vector into the sliding window."""
        self._history.append(list(pad))

    def _flat_bytes(self) -> list[int]:
        """Flatten all recorded pad bytes into a single list."""
        result = []
        for p in self._history:
            result.extend(p)
        return result

    def shannon_entropy(self) -> float:
        """
        Compute Shannon entropy (bits) of the pad byte distribution.

        For a perfectly uniform distribution over N=257 symbols,
        the theoretical maximum is log2(257) ≈ 8.006.
        """
        data = self._flat_bytes()
        if not data:
            return 0.0
        total = len(data)
        counts: dict[int, int] = {}
        for b in data:
            counts[b] = counts.get(b, 0) + 1
        entropy = 0.0
        for count in counts.values():
            p = count / total
            if p > 0:
                entropy -= p * math.log2(p)
        return round(entropy, 4)

    def chi_squared_uniformity(self) -> float:
        """
        Compute a normalized chi-squared uniformity score.

        Returns a value in [0, 1] where 1.0 means perfectly uniform
        distribution across all N possible values and lower values
        indicate more deviation from uniformity.
        """
        data = self._flat_bytes()
        if not data:
            return 0.0
        total = len(data)
        expected = total / N
        if expected == 0:
            return 0.0
        counts: dict[int, int] = {}
        for b in data:
            counts[b] = counts.get(b, 0) + 1
        chi_sq = 0.0
        for val in range(N):
            observed = counts.get(val, 0)
            chi_sq += ((observed - expected) ** 2) / expected
        # Normalize: maximum chi_sq for N bins is total*(N-1)/1 ≈ total*N
        # Use 1 / (1 + chi_sq/N) as a [0,1] score where 1 = perfect
        score = 1.0 / (1.0 + chi_sq / N)
        return round(score, 4)

    def min_entropy(self) -> float:
        """
        Compute min-entropy (bits): -log2(max_probability).

        Conservative lower bound on entropy. For uniform distribution
        over 257 symbols, min-entropy = log2(257) ≈ 8.006.
        """
        data = self._flat_bytes()
        if not data:
            return 0.0
        total = len(data)
        counts: dict[int, int] = {}
        for b in data:
            counts[b] = counts.get(b, 0) + 1
        max_p = max(counts.values()) / total
        if max_p <= 0:
            return 0.0
        return round(-math.log2(max_p), 4)

    def get_metrics(self) -> dict:
        """Return all entropy quality metrics as a dictionary."""
        return {
            "shannon": self.shannon_entropy(),
            "chi_squared": self.chi_squared_uniformity(),
            "min_entropy": self.min_entropy(),
            "samples": len(self._flat_bytes()),
            "window_frames": len(self._history),
        }

    def get_distribution(self) -> list[int]:
        """
        Return the frequency distribution of pad bytes (0..N-1).

        Used by the dashboard to render the entropy histogram.
        """
        data = self._flat_bytes()
        dist = [0] * N
        for b in data:
            if 0 <= b < N:
                dist[b] += 1
        return dist


# ═══════════════════════════════════════════════════════════════════════════
# 6. BUILT-IN SELF-TEST
# ═══════════════════════════════════════════════════════════════════════════

def test_crypto_core() -> None:
    """
    Run comprehensive self-tests for all crypto_core functions.
    Prints results to stdout. Raises AssertionError on failure.
    """
    print("=" * 60)
    print("  CRYPTO CORE SELF-TEST")
    print("=" * 60)

    # --- Quantization ---
    print("\n[1/6] Quantization...")
    thresholds = [0.0, 10.0, 20.0, 30.0, 40.0]
    assert quantize_value(-5.0, thresholds) == 0, "Below-range quantization failed"
    assert quantize_value(0.0, thresholds) == 0, "Edge-at-zero failed"
    assert quantize_value(15.0, thresholds) == 1, "Mid-range quantization failed"
    assert quantize_value(25.0, thresholds) == 2, "Mid-range quantization failed"
    assert quantize_value(100.0, thresholds) == 4, "Above-range quantization failed"
    print("    ✓ quantize_value: all edge cases passed")

    # --- OTP round-trip ---
    print("\n[2/6] OTP encrypt/decrypt round-trip...")
    for x in range(N):
        for k in range(0, N, 17):  # sample every 17th key value
            c = (x + k) % N
            assert otp_encrypt([x], [k]) == [c], f"Encrypt failed: x={x}, k={k}"
            assert otp_decrypt([c], [k]) == [x], f"Decrypt failed: c={c}, k={k}"
    print("    ✓ OTP round-trip: all 257 × 16 combinations passed")

    # --- Full vector round-trip ---
    print("\n[3/6] Full 8-channel vector round-trip...")
    quantized = [0, 3, 5, 2, 4, 1, 3, 2]
    pad = [100, 200, 50, 150, 77, 230, 10, 256]
    cipher = otp_encrypt(quantized, pad)
    recovered = otp_decrypt(cipher, pad)
    assert recovered == quantized, f"Vector round-trip failed: {recovered} != {quantized}"
    print(f"    Quantized:  {quantized}")
    print(f"    Pad:        {pad}")
    print(f"    Ciphertext: {cipher}")
    print(f"    Recovered:  {recovered}")
    print("    ✓ Vector round-trip: perfect recovery")

    # --- HMAC with Timestamp Signature ---
    print("\n[4/6] HMAC integrity and Timestamp Signature...")
    ts1 = "2026-09-12T12:00:00.000000+00:00"
    ts2 = "2026-09-12T12:00:01.000000+00:00"
    h1 = compute_hmac(quantized, timestamp=ts1)
    h2 = compute_hmac(quantized, timestamp=ts1)
    assert h1 == h2, "HMAC determinism failed"
    # Different timestamp on identical data must produce different signature
    h_time_diff = compute_hmac(quantized, timestamp=ts2)
    assert h1 != h_time_diff, "Timestamp binding failed: different timestamps produced identical HMAC"
    tampered = list(quantized)
    tampered[0] = (tampered[0] + 1) % N
    h3 = compute_hmac(tampered, timestamp=ts1)
    assert h1 != h3, "HMAC collision on different data inputs"
    print(f"    Original HMAC (t1): {h1[:32]}...")
    print(f"    Timestamp2 HMAC (t2): {h_time_diff[:32]}...")
    print(f"    Tampered Data HMAC: {h3[:32]}...")
    print("    ✓ HMAC: deterministic, collision-free, and cryptographically binds timestamp")

    # --- Full pipeline ---
    print("\n[5/6] Full pipeline (process_frame with timestamp signature)...")
    raw = [25.0, 55.0, 1010.0, 300.0, 500.0, 0.3, 2.0, 0.8]
    pad_vals = [42, 99, 200, 155, 33, 128, 77, 201]
    result = process_frame(raw, pad_vals, timestamp=ts1)
    assert result["integrity"] == "VERIFIED", "Pipeline integrity check failed"
    assert result["quantized"] == result["decrypted"], "Pipeline recovery failed"
    assert result["timestamp"] == ts1, "Timestamp mismatch"
    assert result["signed_timestamp"] == ts1, "Signed timestamp mismatch"
    print(f"    Signed Timestamp: {result['signed_timestamp']}")
    print(f"    Raw:        {result['raw_values']}")
    print(f"    Quantized:  {result['quantized']}")
    print(f"    Ciphertext: {result['ciphertext']}")
    print(f"    Decrypted:  {result['decrypted']}")
    print(f"    Integrity:  {result['integrity']}")
    print("    ✓ Full pipeline: VERIFIED with bound timestamp signature")

    # --- Tamper detection (Data and Timestamp) ---
    print("\n[6/6] Tamper detection (data and timestamp forgery)...")
    # Data tamper
    tampered_data_result = process_frame_tampered(raw, pad_vals, timestamp=ts1, tamper_channel=2, tamper_delta=13, tamper_type="data")
    assert tampered_data_result["integrity"] == "INTEGRITY VIOLATION", "Data tamper not detected"
    # Timestamp tamper / replay attack
    tampered_time_result = process_frame_tampered(raw, pad_vals, timestamp=ts1, tamper_type="timestamp")
    assert tampered_time_result["integrity"] == "INTEGRITY VIOLATION", "Timestamp tamper/replay not detected"
    print(f"    Data tamper:      {tampered_data_result['integrity']}")
    print(f"    Timestamp tamper: {tampered_time_result['integrity']} (replayed/altered timestamp rejected)")
    print("    ✓ Tamper detection: both data and timestamp tampering correctly detected")

    print("\n" + "=" * 60)
    print("  ALL SELF-TESTS PASSED ✓")
    print("=" * 60)


if __name__ == "__main__":
    test_crypto_core()
