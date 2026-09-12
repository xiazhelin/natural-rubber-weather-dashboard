#!/usr/bin/env python3
"""Fetch the next seven days of weather for configured rubber regions."""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from statistics import fmean


ROOT = Path(__file__).resolve().parents[1]
API_URL = "https://api.open-meteo.com/v1/forecast"
DAILY_FIELDS = (
    "weather_code",
    "temperature_2m_max",
    "temperature_2m_min",
    "precipitation_sum",
    "precipitation_probability_max",
    "wind_gusts_10m_max",
    "et0_fao_evapotranspiration",
)
HOURLY_FIELDS = ("soil_moisture_9_to_27cm", "soil_moisture_27_to_81cm")
SOURCE = {
    "source_id": "WX_OPEN_METEO_01",
    "source_name": "Open-Meteo Weather Forecast API",
    "endpoint": API_URL,
    "documentation": "https://open-meteo.com/en/docs",
    "upstream_models": "Open-Meteo Best Match（按地点自动选择可用数值天气模式）",
    "data_nature": "数值天气模式网格数据，不是地面气象站观测",
    "access": "免费非商业公开接口，无需API Key；数据许可CC BY 4.0",
}


def _finite(values):
    return [float(value) for value in values if value is not None]


def _mean(values):
    values = _finite(values)
    return round(fmean(values), 3) if values else None


def _sum(values):
    values = _finite(values)
    return round(sum(values), 1) if values else None


def _max(values):
    values = _finite(values)
    return round(max(values), 1) if values else None


def _min(values):
    values = _finite(values)
    return round(min(values), 1) if values else None


def classify(summary, thresholds):
    """Return descriptive weather states; they are not supply conclusions."""
    states = []
    rain = summary.get("precipitation_7d_mm")
    hot = summary.get("temperature_max_7d_c")
    if rain is not None and rain >= thresholds["heavy_rain_total_7d_mm"]:
        states.append("HEAVY_RAIN")
    if rain is not None and rain < thresholds["dry_total_7d_mm"]:
        states.append("DRY")
    if hot is not None and hot >= thresholds["hot_day_max_c"]:
        states.append("HEAT")
    return states or ["NORMAL"]


def build_station(location, payload, thresholds):
    daily = payload.get("daily") or {}
    hourly = payload.get("hourly") or {}
    dates = daily.get("time") or []
    rows = []
    for index, date in enumerate(dates):
        row = {"date": date}
        for key in DAILY_FIELDS:
            values = daily.get(key) or []
            row[key] = values[index] if index < len(values) else None
        rows.append(row)

    rain = [row["precipitation_sum"] for row in rows]
    tmax = [row["temperature_2m_max"] for row in rows]
    tmin = [row["temperature_2m_min"] for row in rows]
    et0 = [row["et0_fao_evapotranspiration"] for row in rows]
    soil_shallow = (hourly.get("soil_moisture_9_to_27cm") or [])[: 24 * len(rows)]
    soil_deep = (hourly.get("soil_moisture_27_to_81cm") or [])[: 24 * len(rows)]
    summary = {
        "precipitation_7d_mm": _sum(rain),
        "rain_days_7d": sum(1 for value in rain if value is not None and value >= 1),
        "heavy_rain_days_7d": sum(
            1 for value in rain if value is not None and value >= thresholds["heavy_rain_day_mm"]
        ),
        "temperature_max_7d_c": _max(tmax),
        "temperature_min_7d_c": _min(tmin),
        "et0_7d_mm": _sum(et0),
        "soil_moisture_9_27cm_mean_7d": _mean(soil_shallow),
        "soil_moisture_27_81cm_mean_7d": _mean(soil_deep),
    }
    summary["weather_states"] = classify(summary, thresholds)
    core = [rain, tmax, tmin]
    complete = len(rows) == 7 and all(len(_finite(values)) == 7 for values in core)
    quality = "PASS" if complete else "WARNING"
    if not rows:
        quality = "MISSING"
    return {
        **location,
        "timezone": payload.get("timezone"),
        "elevation_m": payload.get("elevation"),
        "quality_status": quality,
        "summary": summary,
        "daily": rows,
    }


def fetch_batch(locations, timeout=45, retries=3):
    params = {
        "latitude": ",".join(str(item["latitude"]) for item in locations),
        "longitude": ",".join(str(item["longitude"]) for item in locations),
        "daily": ",".join(DAILY_FIELDS),
        "hourly": ",".join(HOURLY_FIELDS),
        "forecast_days": 7,
        "timezone": "auto",
        "cell_selection": "land",
    }
    url = API_URL + "?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(url, headers={"User-Agent": "natural-rubber-weather-dashboard/1.0"})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                data = json.load(response)
            payloads = data if isinstance(data, list) else [data]
            if len(payloads) != len(locations):
                raise ValueError(f"response count {len(payloads)} != request count {len(locations)}")
            return payloads
        except Exception:
            if attempt + 1 == retries:
                raise
            time.sleep(2**attempt)


def atomic_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        temporary = Path(handle.name)
    os.replace(temporary, path)


def history_entry(dataset):
    return {
        "generated_at_utc": dataset["generated_at_utc"],
        "stations": [
            {
                "station_id": station["station_id"],
                **station["summary"],
                "quality_status": station["quality_status"],
            }
            for station in dataset["stations"]
        ],
    }


def update_history(path, dataset, maximum=400):
    history = {"schema_version": 1, "snapshots": []}
    if path.exists():
        history = json.loads(path.read_text(encoding="utf-8"))
    snapshots = history.get("snapshots") or []
    snapshots = [item for item in snapshots if item.get("generated_at_utc") != dataset["generated_at_utc"]]
    snapshots.append(history_entry(dataset))
    history["snapshots"] = snapshots[-maximum:]
    atomic_json(path, history)


def collect(config_path):
    config = json.loads(config_path.read_text(encoding="utf-8"))
    locations = config["locations"]
    thresholds = config["thresholds"]
    stations = []
    for start in range(0, len(locations), 15):
        batch = locations[start : start + 15]
        payloads = fetch_batch(batch)
        stations.extend(build_station(location, payload, thresholds) for location, payload in zip(batch, payloads))
    now = datetime.now(timezone.utc).replace(microsecond=0)
    quality_counts = {status: sum(item["quality_status"] == status for item in stations) for status in ("PASS", "WARNING", "MISSING")}
    overall = "PASS" if quality_counts["PASS"] == len(stations) else "WARNING"
    return {
        "schema_version": 1,
        "dataset_id": "NR_PRODUCTION_REGION_WEATHER_FORECAST_V1",
        "generated_at_utc": now.isoformat().replace("+00:00", "Z"),
        "forecast_horizon": "D0-D6",
        "overall_quality_status": overall,
        "quality_counts": quality_counts,
        "thresholds": thresholds,
        "source": SOURCE,
        "scope_note": config["description"],
        "stations": stations,
    }


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=ROOT / "config" / "locations.json")
    parser.add_argument("--output", type=Path, default=ROOT / "site" / "data" / "weather.json")
    parser.add_argument("--history", type=Path, default=ROOT / "site" / "data" / "history.json")
    args = parser.parse_args(argv)
    dataset = collect(args.config)
    if not dataset["stations"]:
        raise RuntimeError("No station data returned; existing published data was not changed.")
    atomic_json(args.output, dataset)
    update_history(args.history, dataset)
    print(
        f"updated {len(dataset['stations'])} locations at {dataset['generated_at_utc']} "
        f"({dataset['overall_quality_status']})"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"weather update failed: {exc}", file=sys.stderr)
        raise
