"""
geo_weather.py — Real-time API provider for Geolocation (Lat/Lon) and Atmospheric Pressure.

Fetches live real-world telemetry through regular API calls to public REST services:
  1. Geolocation: Dynamic IP Geolocation (ip-api.com, ipapi.co, ipwho.is) or Client Browser GPS
  2. Atmospheric Pressure: Real-time barometric pressure from Open-Meteo API (surface_pressure)
     with wttr.in fallback.

Maintains dynamic real-time telemetry values with sensor micro-fluctuations (acoustic/barometric
air pressure drift and GPS satellite micro-wander) so that live telemetry stream accurately reflects
real-time sensor telemetry at 4 Hz.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import random
import time
import urllib.request
from datetime import datetime, timezone
from typing import Optional, Tuple

logger = logging.getLogger("SSIM.GeoWeather")


class GeoWeatherProvider:
    """
    Provider that regularly fetches real-time Latitude, Longitude,
    and Atmospheric Pressure via live public REST APIs.
    """

    def __init__(self, refresh_interval: float = 20.0):
        self.refresh_interval = refresh_interval
        self._running = False

        # Dynamic state — initialized dynamically from live API requests (no hardcoded defaults)
        self.latitude: Optional[float] = None
        self.longitude: Optional[float] = None
        self.city: str = "Detecting..."
        self.region: str = ""
        self.country: str = ""
        self.country_code: str = ""
        self.ip_address: str = ""
        self.surface_pressure: Optional[float] = None  # hPa from live weather API
        self.pressure_msl: Optional[float] = None     # hPa mean sea level
        self.elevation: float = 0.0
        self.source_geo: str = "INITIALIZING"
        self.source_weather: str = "INITIALIZING"
        self.last_updated: str = ""
        self.status: str = "INITIALIZING"
        self.api_calls_count: int = 0
        self.last_latency_ms: float = 0.0
        self._client_gps_locked: bool = False

        # Micro-variation phase counters for 4 Hz real-time sensor fluctuation
        self._drift_phase = random.uniform(0, 100.0)

        # Trigger initial sync fetch immediately
        self.fetch_sync()

    def fetch_sync(self) -> bool:
        """Synchronously query live Geolocation and Atmospheric Pressure REST APIs."""
        t0 = time.time()
        geo_ok = False
        weather_ok = False

        # ── 1. Fetch Live Geolocation (only if not locked by client GPS) ───
        if not self._client_gps_locked:
            geo_services = [
                ("http://ip-api.com/json/?fields=status,message,country,countryCode,region,regionName,city,lat,lon,query", self._parse_ip_api),
                ("https://ipapi.co/json/", self._parse_ipapi_co),
                ("https://ipwho.is/", self._parse_ipwho_is),
            ]

            for url, parser in geo_services:
                try:
                    req = urllib.request.Request(
                        url,
                        headers={"User-Agent": "SSIM-Telemetry/2.0", "Accept": "application/json"}
                    )
                    with urllib.request.urlopen(req, timeout=3.5) as resp:
                        raw = resp.read().decode("utf-8")
                        data = json.loads(raw)
                        if parser(data):
                            geo_ok = True
                            break
                except Exception as e:
                    logger.debug(f"Geo service {url} error: {e}")
                    continue
        else:
            geo_ok = True

        # ── 2. Fetch Live Atmospheric Pressure (Open-Meteo) ────────────────
        if self.latitude is not None and self.longitude is not None:
            try:
                url_meteo = (
                    f"https://api.open-meteo.com/v1/forecast?"
                    f"latitude={self.latitude:.4f}&longitude={self.longitude:.4f}&"
                    f"current=surface_pressure,pressure_msl,temperature_2m,relative_humidity_2m"
                )
                req_m = urllib.request.Request(
                    url_meteo,
                    headers={"User-Agent": "SSIM-Telemetry/2.0", "Accept": "application/json"}
                )
                with urllib.request.urlopen(req_m, timeout=4.0) as resp_m:
                    wdata = json.loads(resp_m.read().decode("utf-8"))
                    current = wdata.get("current", {})
                    if "surface_pressure" in current and current["surface_pressure"] is not None:
                        self.surface_pressure = float(current["surface_pressure"])
                    if "pressure_msl" in current and current["pressure_msl"] is not None:
                        self.pressure_msl = float(current["pressure_msl"])
                    if "elevation" in wdata:
                        self.elevation = float(wdata["elevation"])
                    self.source_weather = "Open-Meteo API"
                    weather_ok = True
            except Exception as ew:
                logger.warning(f"Open-Meteo atmospheric pressure API error: {ew}")

        # Fallback to wttr.in if Open-Meteo failed
        if not weather_ok and self.city and self.city != "Detecting...":
            try:
                city_encoded = urllib.parse.quote(self.city)
                req_w = urllib.request.Request(
                    f"https://wttr.in/{city_encoded}?format=j1",
                    headers={"User-Agent": "curl/7.68.0"}
                )
                with urllib.request.urlopen(req_w, timeout=4.0) as resp_w:
                    wttr_data = json.loads(resp_w.read().decode("utf-8"))
                    cond = wttr_data.get("current_condition", [{}])[0]
                    if "pressure" in cond:
                        self.surface_pressure = float(cond["pressure"])
                        self.pressure_msl = self.surface_pressure
                        self.source_weather = "wttr.in API"
                        weather_ok = True
            except Exception as e_wttr:
                logger.warning(f"wttr.in API error: {e_wttr}")

        # Fallback if entirely offline
        if self.latitude is None or self.longitude is None:
            self.latitude = 0.0
            self.longitude = 0.0
            self.city = "Offline / GPS Acquiring"
            self.source_geo = "NO_GPS_LOCK"

        if self.surface_pressure is None:
            self.surface_pressure = 1013.25  # Standard international sea level pressure
            self.pressure_msl = 1013.25
            self.source_weather = "ISA Standard (Offline)"

        self.last_latency_ms = round((time.time() - t0) * 1000.0, 1)
        self.last_updated = datetime.now(timezone.utc).isoformat()
        self.api_calls_count += 1
        self.status = "ONLINE" if (geo_ok or weather_ok) else "DEGRADED"

        logger.info(
            f"✓ Realtime GeoWeather API: Lat={self.latitude:.4f}, Lon={self.longitude:.4f} "
            f"({self.city}, {self.country}), Surface Pressure={self.surface_pressure:.2f} hPa [{self.status}, {self.last_latency_ms}ms]"
        )
        return geo_ok or weather_ok

    def _parse_ip_api(self, data: dict) -> bool:
        if data.get("status") == "success":
            self.latitude = float(data["lat"])
            self.longitude = float(data["lon"])
            self.city = data.get("city", "Unknown")
            self.region = data.get("regionName", "")
            self.country = data.get("country", "")
            self.country_code = data.get("countryCode", "")
            self.ip_address = data.get("query", "")
            self.source_geo = "ip-api.com"
            return True
        return False

    def _parse_ipapi_co(self, data: dict) -> bool:
        if "latitude" in data and "longitude" in data:
            self.latitude = float(data["latitude"])
            self.longitude = float(data["longitude"])
            self.city = data.get("city", "Unknown")
            self.region = data.get("region", "")
            self.country = data.get("country_name", "")
            self.country_code = data.get("country_code", "")
            self.ip_address = data.get("ip", "")
            self.source_geo = "ipapi.co"
            return True
        return False

    def _parse_ipwho_is(self, data: dict) -> bool:
        if data.get("success"):
            self.latitude = float(data["latitude"])
            self.longitude = float(data["longitude"])
            self.city = data.get("city", "Unknown")
            self.region = data.get("region", "")
            self.country = data.get("country", "")
            self.country_code = data.get("country_code", "")
            self.ip_address = data.get("ip", "")
            self.source_geo = "ipwho.is"
            return True
        return False

    def update_from_client_gps(self, latitude: float, longitude: float, accuracy: Optional[float] = None) -> None:
        """
        Allows browser client to push true high-accuracy GPS coordinates
        from navigator.geolocation.
        """
        try:
            self._client_gps_locked = True
            self.latitude = round(float(latitude), 6)
            self.longitude = round(float(longitude), 6)
            self.city = f"GPS ({self.latitude:.3f}, {self.longitude:.3f})"
            self.source_geo = f"Device GPS (±{round(accuracy or 10.0, 1)}m)"
            self.status = "ONLINE"
            self.last_updated = datetime.now(timezone.utc).isoformat()
            logger.info(f"Updated coordinates from Client GPS: {self.latitude}, {self.longitude}")

            # Re-fetch atmospheric pressure for these exact coordinates
            self.fetch_sync()
        except Exception as e:
            logger.error(f"Failed to update from client GPS: {e}")

    def reset_gps_lock(self) -> None:
        """Unlock client GPS and re-query IP Geolocation services."""
        self._client_gps_locked = False
        self.fetch_sync()

    def get_realtime_readings(self) -> Tuple[float, float, float]:
        """
        Returns real-time (latitude, longitude, atmospheric_pressure) for telemetry channels
        based on the latest authoritative API and device GPS readings.
        """
        lat_base = self.latitude if self.latitude is not None else 0.0
        lon_base = self.longitude if self.longitude is not None else 0.0
        p_base = self.surface_pressure if self.surface_pressure is not None else 1013.25

        live_lat = round(lat_base, 4)
        live_lon = round(lon_base, 4)
        live_pressure = round(p_base, 2)

        return live_lat, live_lon, live_pressure

    async def start_background_loop(self):
        """Asynchronous background loop making regular API calls to refresh live data."""
        self._running = True
        logger.info(f"Starting GeoWeather background loop (interval: {self.refresh_interval}s)")

        while self._running:
            try:
                await asyncio.sleep(self.refresh_interval)
                await asyncio.get_event_loop().run_in_executor(None, self.fetch_sync)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in GeoWeather background loop: {e}")
                await asyncio.sleep(8.0)

    def stop(self):
        self._running = False

    def get_data(self) -> dict:
        """Return full current state snapshot."""
        lat = self.latitude if self.latitude is not None else 0.0
        lon = self.longitude if self.longitude is not None else 0.0
        lat_hemi = "N" if lat >= 0 else "S"
        lon_hemi = "E" if lon >= 0 else "W"

        # Get the live fluctuating channel values
        live_lat, live_lon, live_p = self.get_realtime_readings()

        return {
            "latitude": lat,
            "longitude": lon,
            "live_latitude": live_lat,
            "live_longitude": live_lon,
            "coordinates_formatted": f"{abs(live_lat):.4f}° {lat_hemi}, {abs(live_lon):.4f}° {lon_hemi}",
            "city": self.city,
            "region": self.region,
            "country": self.country,
            "country_code": self.country_code,
            "location_formatted": f"{self.city}, {self.country_code or self.country}".strip(", "),
            "surface_pressure_hpa": live_p,
            "base_surface_pressure_hpa": round(self.surface_pressure or 1013.25, 2),
            "pressure_msl_hpa": round(self.pressure_msl or (self.surface_pressure or 1013.25), 2),
            "elevation_m": round(self.elevation, 1),
            "source_geo": self.source_geo,
            "source_weather": self.source_weather,
            "status": self.status,
            "last_updated": self.last_updated,
            "api_calls_count": self.api_calls_count,
            "latency_ms": self.last_latency_ms,
        }


# Global singleton instance
geo_weather_provider = GeoWeatherProvider(refresh_interval=25.0)
