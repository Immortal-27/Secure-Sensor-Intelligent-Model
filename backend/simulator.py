"""
simulator.py — Virtual sensor and entropy simulator for offline/no-hardware testing.

Generates realistic 8-channel floating-point sensor data cycling through
three operational scenarios (Nominal, Warning, Critical) with smooth
sinusoidal drift and Gaussian noise. Also generates pad bytes via
os.urandom() (CSPRNG) as a fallback for ESP32 hardware TRNG.

The simulator ensures the demo never fails on stage when no ESP32 is connected.
"""

from __future__ import annotations

import math
import os
import random
import time
from typing import Generator

from config import (
    N,
    NUM_CHANNELS,
    SENSOR_LABELS,
    SENSOR_RANGES,
    FRAME_INTERVAL_MS,
)


# ═══════════════════════════════════════════════════════════════════════════
# SCENARIO DEFINITIONS
# ═══════════════════════════════════════════════════════════════════════════
# Each scenario defines center values and noise amplitude per channel.
# The simulator cycles through these to demonstrate different alert states.

class Scenario:
    """A named operational scenario with per-channel center + noise values."""

    def __init__(self, name: str, centers: list[float], noise_scales: list[float]):
        self.name = name
        self.centers = centers
        self.noise_scales = noise_scales


SCENARIOS = [
    Scenario(
        name="NOMINAL",
        centers=[22.0, 45.0, 1013.0, 350.0, 420.0, 0.2, 3.3, 0.5],
        noise_scales=[1.5, 3.0, 2.0, 30.0, 15.0, 0.05, 0.1, 0.05],
    ),
    Scenario(
        name="WARNING",
        centers=[38.0, 72.0, 995.0, 800.0, 950.0, 1.2, 3.8, 1.5],
        noise_scales=[3.0, 5.0, 4.0, 80.0, 50.0, 0.2, 0.15, 0.2],
    ),
    Scenario(
        name="CRITICAL",
        centers=[65.0, 90.0, 968.0, 6500.0, 3200.0, 3.5, 1.0, 3.8],
        noise_scales=[5.0, 4.0, 6.0, 500.0, 200.0, 0.5, 0.3, 0.3],
    ),
]

# Duration (seconds) for each scenario phase before transitioning
SCENARIO_DURATION = 15.0
# Duration of smooth transition between scenarios
TRANSITION_DURATION = 5.0


# ═══════════════════════════════════════════════════════════════════════════
# VIRTUAL SENSOR GENERATOR
# ═══════════════════════════════════════════════════════════════════════════

class VirtualSensorGenerator:
    """
    Generates realistic 8-channel sensor readings that cycle through
    Nominal → Warning → Critical scenarios with smooth sinusoidal
    transitions and Gaussian noise.
    """

    def __init__(self):
        self._start_time = time.time()
        self._packet_id = 0
        self._rng = random.Random(42)  # Seeded for reproducible demo transitions

    def _get_scenario_blend(self, elapsed: float) -> tuple[Scenario, Scenario, float]:
        """
        Determine which two scenarios to blend and the interpolation factor.

        Returns (scenario_a, scenario_b, blend_factor) where blend_factor
        is in [0, 1]. When blend_factor is 0, fully scenario_a; when 1,
        fully scenario_b.
        """
        cycle_time = len(SCENARIOS) * (SCENARIO_DURATION + TRANSITION_DURATION)
        t = elapsed % cycle_time

        accumulated = 0.0
        for i, scenario in enumerate(SCENARIOS):
            # Stable phase
            if t < accumulated + SCENARIO_DURATION:
                return scenario, scenario, 0.0
            accumulated += SCENARIO_DURATION

            # Transition phase
            if t < accumulated + TRANSITION_DURATION:
                next_scenario = SCENARIOS[(i + 1) % len(SCENARIOS)]
                blend = (t - accumulated) / TRANSITION_DURATION
                # Smooth ease-in-out
                blend = 0.5 - 0.5 * math.cos(math.pi * blend)
                return scenario, next_scenario, blend
            accumulated += TRANSITION_DURATION

        return SCENARIOS[0], SCENARIOS[0], 0.0

    def generate_reading(self) -> dict:
        """
        Generate one 8-channel sensor reading frame with entropy pad.

        Returns
        -------
        dict
            {
                "v": [float, ...],     # 8 raw sensor values
                "pad": [int, ...],     # 8 entropy pad bytes (CSPRNG)
                "pid": int,            # Packet ID
                "scenario": str,       # Current scenario name
            }
        """
        elapsed = time.time() - self._start_time
        scenario_a, scenario_b, blend = self._get_scenario_blend(elapsed)

        values: list[float] = []
        for ch in range(NUM_CHANNELS):
            # Interpolate center between scenarios
            center = (
                scenario_a.centers[ch] * (1.0 - blend)
                + scenario_b.centers[ch] * blend
            )
            noise_scale = (
                scenario_a.noise_scales[ch] * (1.0 - blend)
                + scenario_b.noise_scales[ch] * blend
            )

            # Sinusoidal drift unique per channel
            drift_freq = 0.1 + ch * 0.03  # Hz, staggered per channel
            drift_amp = noise_scale * 0.6
            drift = drift_amp * math.sin(2.0 * math.pi * drift_freq * elapsed + ch * 1.1)

            # Gaussian noise
            noise = self._rng.gauss(0.0, noise_scale * 0.4)

            # Clamp to sensor range
            lo, hi = SENSOR_RANGES[ch]
            value = max(lo, min(hi, center + drift + noise))
            values.append(round(value, 2))

        # Generate pad bytes via CSPRNG (os.urandom) — simulated entropy
        pad_bytes = list(os.urandom(NUM_CHANNELS))
        # Map each byte to [0, N-1] to match the modular arithmetic domain
        pad = [b % N for b in pad_bytes]

        self._packet_id += 1

        current_scenario = (
            scenario_a.name if blend < 0.5 else scenario_b.name
        )

        return {
            "v": values,
            "pad": pad,
            "pid": self._packet_id,
            "scenario": current_scenario,
        }


def sensor_stream_simulator() -> Generator[dict, None, None]:
    """
    Infinite generator yielding simulated sensor frames at the configured
    frame interval. Used as the fallback when no ESP32 hardware is detected.

    Yields
    ------
    dict
        Sensor frame with keys: v, pad, pid, scenario
    """
    gen = VirtualSensorGenerator()
    interval = FRAME_INTERVAL_MS / 1000.0

    while True:
        frame = gen.generate_reading()
        yield frame
        time.sleep(interval)


# ═══════════════════════════════════════════════════════════════════════════
# STANDALONE TEST
# ═══════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    print("=" * 60)
    print("  VIRTUAL SENSOR SIMULATOR — STANDALONE TEST")
    print("=" * 60)
    gen = VirtualSensorGenerator()
    for i in range(10):
        frame = gen.generate_reading()
        print(f"\n--- Frame {frame['pid']} [{frame['scenario']}] ---")
        for ch in range(NUM_CHANNELS):
            print(
                f"  {SENSOR_LABELS[ch]:>12s}: "
                f"raw={frame['v'][ch]:>10.2f}  "
                f"pad={frame['pad'][ch]:>3d}"
            )
        time.sleep(0.3)
    print("\n✓ Simulator test complete.")
