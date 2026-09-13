#!/usr/bin/env python3
"""Fetch the next seven days of weather for configured rubber regions."""

from __future__ import annotations

import argparse
import base64
import json
import math
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, time as datetime_time, timedelta, timezone
from pathlib import Path
from statistics import fmean
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
API_URL = "https://api.open-meteo.com/v1/forecast"
HISTORICAL_API_URL = "https://archive-api.open-meteo.com/v1/archive"
DAILY_FIELDS = (
    "weather_code",
    "temperature_2m_max",
    "temperature_2m_min",
    "precipitation_sum",
    "precipitation_probability_max",
    "wind_gusts_10m_max",
    "et0_fao_evapotranspiration",
)
HOURLY_FIELDS = (
    "precipitation",
    "precipitation_probability",
    "soil_moisture_9_to_27cm",
    "soil_moisture_27_to_81cm",
)
SOURCE = {
    "source_id": "WX_OPEN_METEO_01",
    "source_name": "Open-Meteo Weather Forecast API",
    "endpoint": API_URL,
    "documentation": "https://open-meteo.com/en/docs",
    "upstream_models": "Open-Meteo Best Match（按地点自动选择可用数值天气模式）",
    "data_nature": "数值天气模式网格数据，不是地面气象站观测",
    "access": "免费非商业公开接口，无需API Key；数据许可CC BY 4.0",
}
THAILAND_WEEKLY_SOURCE = {
    "source_id": "HIST_OPEN_METEO_ERA5_01",
    "source_name": "Open-Meteo Historical Weather API",
    "endpoint": HISTORICAL_API_URL,
    "documentation": "https://open-meteo.com/en/docs/historical-weather-api",
    "upstream_model": "ERA5 reanalysis",
    "data_nature": "0.25°再分析网格估算，不是地面雨量站实测",
    "availability": "日度更新，通常约滞后5天",
    "access": "免费非商业公开接口，无需API Key；数据许可CC BY 4.0",
}
IMERG_BASE_URL = "https://jsimpsonhttps.pps.eosdis.nasa.gov/imerg/gis"
IMERG_DATES_URL = "https://pmmpublisher.pps.eosdis.nasa.gov/img/imerg_v2/dates_3d.txt"
IMERG_VERSION = "V07C"
IMERG_SOURCE = {
    "source_id": "OBS_NASA_IMERG_LATE_GIS",
    "source_name": "NASA GPM IMERG Late Run GIS",
    "documentation": "https://gpm.nasa.gov/data/imerg",
    "data_nature": "卫星与多源融合的近实时降水估算，不是地面雨量站实测",
    "spatial_resolution": "0.1°×0.1°",
    "periods": "过去24小时/72小时，截止同一UTC日23:59",
    "access": "NASA PPS HTTPS；GitHub Actions使用仓库密钥NASA_PPS_EMAIL",
}
CLIMATE_ASSET_DIR = ROOT / "site" / "assets" / "climate"
BOM_INDEXES = (
    (
        "https://reg.bom.gov.au/clim_data/IDCK000072/rnino_3.4.txt",
        "rnino34-weekly.svg",
        "Relative Niño3.4 index",
        -3,
        3,
        -0.8,
        0.8,
    ),
    (
        "https://reg.bom.gov.au/clim_data/IDCK000072/iod_1.txt",
        "iod-weekly.svg",
        "Indian Ocean Dipole index",
        -2,
        2,
        -0.4,
        0.4,
    ),
)
NOAA_RONI_OUTLOOK_URL = (
    "https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/enso/roni/outlook/"
)


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


def _hourly_value(hourly, field, index):
    values = hourly.get(field) or []
    return values[index] if index < len(values) else None


def tapping_window_by_date(hourly, dates, settings):
    """Aggregate hourly forecast rain inside the configured local-time research window."""
    start_hour = settings["start_hour_local"]
    end_hour = settings["end_hour_local"]
    threshold = settings["rain_hour_threshold_mm"]
    buckets = {day: {"rain": [], "probability": []} for day in dates}
    for index, stamp in enumerate(hourly.get("time") or []):
        moment = datetime.fromisoformat(stamp)
        day = moment.date().isoformat()
        if day not in buckets or not start_hour <= moment.hour < end_hour:
            continue
        buckets[day]["rain"].append(_hourly_value(hourly, "precipitation", index))
        buckets[day]["probability"].append(
            _hourly_value(hourly, "precipitation_probability", index)
        )

    result = {}
    expected_hours = end_hour - start_hour
    for day, values in buckets.items():
        rain = _finite(values["rain"])
        probability = _finite(values["probability"])
        complete = len(rain) == expected_hours
        result[day] = {
            "precipitation_mm": round(sum(rain), 1) if complete else None,
            "rain_hours": sum(value >= threshold for value in rain) if complete else None,
            "precipitation_probability_max": round(max(probability), 1)
            if len(probability) == expected_hours
            else None,
        }
    return result


def utc_daily_forecast(hourly, timezone_name):
    """Build complete UTC-day forecast totals for later no-lookahead verification."""
    try:
        local_timezone = ZoneInfo(timezone_name)
    except (KeyError, TypeError):
        return []
    buckets = {}
    for index, stamp in enumerate(hourly.get("time") or []):
        value = _hourly_value(hourly, "precipitation", index)
        local = datetime.fromisoformat(stamp).replace(tzinfo=local_timezone)
        day = local.astimezone(timezone.utc).date().isoformat()
        buckets.setdefault(day, []).append(value)
    return [
        {"date_utc": day, "precipitation_mm": round(sum(_finite(values)), 1)}
        for day, values in sorted(buckets.items())
        if len(values) == 24 and len(_finite(values)) == 24
    ]


def utc_six_hour_forecast(hourly, timezone_name, start_at_utc, periods=28):
    """Aggregate hourly precipitation into aligned six-hour UTC periods."""
    try:
        local_timezone = ZoneInfo(timezone_name)
    except (KeyError, TypeError):
        return []
    buckets = {}
    for index, stamp in enumerate(hourly.get("time") or []):
        local = datetime.fromisoformat(stamp).replace(tzinfo=local_timezone)
        moment = local.astimezone(timezone.utc)
        bucket = moment.replace(hour=moment.hour // 6 * 6, minute=0, second=0, microsecond=0)
        buckets.setdefault(bucket, []).append(_hourly_value(hourly, "precipitation", index))

    start = start_at_utc.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
    if start_at_utc.minute or start_at_utc.second or start_at_utc.microsecond or start.hour % 6:
        start += timedelta(hours=6 - start.hour % 6)
    return [
        {
            "start_at_utc": bucket.isoformat().replace("+00:00", "Z"),
            "end_at_utc": (bucket + timedelta(hours=6)).isoformat().replace("+00:00", "Z"),
            "precipitation_mm": round(sum(_finite(values)), 1)
            if len(values) == 6 and len(_finite(values)) == 6
            else None,
        }
        for bucket in (start + timedelta(hours=6 * index) for index in range(periods))
        for values in [buckets.get(bucket, [])]
    ]


def sample_imerg_pixel(image, latitude, longitude):
    """Read one IMERG accumulation pixel; product values are stored in 0.1 mm."""
    width, height = image.size
    column = min(width - 1, max(0, math.floor((longitude + 180) / 360 * width)))
    row = min(height - 1, max(0, math.floor((90 - latitude) / 180 * height)))
    value = image.getpixel((column, row))
    if isinstance(value, tuple):
        value = value[0]
    return None if value is None or value >= 29999 else round(float(value) / 10, 1)


def _authenticated_request(url, email, timeout=60):
    token = base64.b64encode(f"{email}:{email}".encode()).decode()
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Basic {token}",
            "User-Agent": "natural-rubber-weather-dashboard/1.0",
        },
    )
    return urllib.request.urlopen(request, timeout=timeout)


def _imerg_candidate_dates(payload, today, maximum=7):
    dates = []
    for value in payload.split():
        try:
            parsed = datetime.strptime(value, "%Y%m%d").date()
        except ValueError:
            continue
        if parsed <= today:
            dates.append(value)
    return sorted(set(dates), reverse=True)[:maximum]


def _imerg_urls(product_date):
    base = f"{IMERG_BASE_URL}/{product_date[:4]}/{product_date[4:6]}/"
    stem = (
        f"3B-HHR-L.MS.MRG.3IMERG.{product_date}-S233000-E235959.1410."
        f"{IMERG_VERSION}"
    )
    return {period: f"{base}{stem}.{period}.tif" for period in ("1day", "3day")}


def _available_imerg_dates(today):
    with urllib.request.urlopen(IMERG_DATES_URL, timeout=30) as response:
        payload = response.read().decode("utf-8", errors="replace")
    dates = _imerg_candidate_dates(payload, today)
    if not dates:
        raise RuntimeError("NASA IMERG date index has no usable dates")
    return dates


def fetch_imerg(locations, email, today=None):
    """Fetch the latest common IMERG Late 1-day and 3-day products and sample all points."""
    if not email:
        raise RuntimeError("NASA PPS credential is not configured")
    try:
        from PIL import Image
    except ImportError as exc:
        raise RuntimeError("Pillow is required to read IMERG GeoTIFF") from exc

    with tempfile.TemporaryDirectory() as directory:
        images = {}
        product_date = None
        for candidate in _available_imerg_dates(
            today or datetime.now(timezone.utc).date()
        ):
            urls = _imerg_urls(candidate)
            try:
                for period, url in urls.items():
                    path = Path(directory) / f"{period}.tif"
                    with _authenticated_request(url, email) as response, path.open("wb") as handle:
                        while chunk := response.read(1024 * 1024):
                            handle.write(chunk)
                    images[period] = Image.open(path)
                    images[period].load()
            except urllib.error.HTTPError as exc:
                for image in images.values():
                    image.close()
                images = {}
                if exc.code == 404:
                    continue
                raise
            product_date = candidate
            break
        if product_date is None:
            raise RuntimeError("No complete IMERG 1day/3day product pair is available")
        try:
            values = {
                item["station_id"]: {
                    "quality_status": "PASS",
                    "precipitation_24h_mm": sample_imerg_pixel(
                        images["1day"], item["latitude"], item["longitude"]
                    ),
                    "precipitation_72h_mm": sample_imerg_pixel(
                        images["3day"], item["latitude"], item["longitude"]
                    ),
                }
                for item in locations
            }
        finally:
            for image in images.values():
                image.close()
    for value in values.values():
        if value["precipitation_24h_mm"] is None or value["precipitation_72h_mm"] is None:
            value["quality_status"] = "MISSING"
    end_at = f"{datetime.strptime(product_date, '%Y%m%d').date().isoformat()}T23:59:59Z"
    return {
        **IMERG_SOURCE,
        "quality_status": "PASS"
        if all(item["quality_status"] == "PASS" for item in values.values())
        else "WARNING",
        "product_version": IMERG_VERSION,
        "end_at_utc": end_at,
    }, values


def missing_imerg(locations, reason):
    return {
        **IMERG_SOURCE,
        "quality_status": "MISSING",
        "end_at_utc": None,
        "availability_note": reason,
    }, {
        item["station_id"]: {
            "quality_status": "MISSING",
            "precipitation_24h_mm": None,
            "precipitation_72h_mm": None,
        }
        for item in locations
    }


def _parse_utc(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def matched_forecast(snapshots, station_id, target_dates):
    """Return the latest forecast that existed before the verification period began."""
    cutoff = datetime.combine(min(target_dates), datetime_time.min, tzinfo=timezone.utc)
    for snapshot in sorted(
        snapshots, key=lambda item: item.get("generated_at_utc", ""), reverse=True
    ):
        try:
            if _parse_utc(snapshot["generated_at_utc"]) > cutoff:
                continue
        except (KeyError, TypeError, ValueError):
            continue
        station = next(
            (
                item
                for item in snapshot.get("stations") or []
                if item.get("station_id") == station_id
            ),
            None,
        )
        by_date = {
            item.get("date_utc"): item.get("precipitation_mm")
            for item in (station or {}).get("forecast_utc_daily") or []
        }
        if all(day.isoformat() in by_date and by_date[day.isoformat()] is not None for day in target_dates):
            return round(sum(float(by_date[day.isoformat()]) for day in target_dates), 1), snapshot[
                "generated_at_utc"
            ]
    return None, None


def _verification_period(observed, forecast, generated_at):
    if observed is None:
        return {
            "status": "OBSERVATION_MISSING",
            "forecast_mm": forecast,
            "observed_mm": None,
            "realization_pct": None,
            "forecast_error_mm": None,
            "forecast_generated_at_utc": generated_at,
        }
    if forecast is None:
        return {
            "status": "NO_MATCHED_FORECAST",
            "forecast_mm": None,
            "observed_mm": observed,
            "realization_pct": None,
            "forecast_error_mm": None,
            "forecast_generated_at_utc": None,
        }
    return {
        "status": "PASS" if forecast >= 1 else "LOW_FORECAST_BASE",
        "forecast_mm": forecast,
        "observed_mm": observed,
        "realization_pct": round(observed / forecast * 100, 1) if forecast >= 1 else None,
        "forecast_error_mm": round(forecast - observed, 1),
        "forecast_generated_at_utc": generated_at,
    }


def attach_verification(dataset, history):
    end_at = dataset.get("observation_source", {}).get("end_at_utc")
    end_date = _parse_utc(end_at).date() if end_at else None
    snapshots = history.get("snapshots") or []
    for station in dataset["stations"]:
        observed = station.get("imerg") or {}
        periods = {}
        for hours, days in ((24, 1), (72, 3)):
            targets = [end_date - timedelta(days=offset) for offset in range(days - 1, -1, -1)] if end_date else []
            forecast, generated_at = matched_forecast(
                snapshots, station["station_id"], targets
            ) if targets else (None, None)
            periods[f"{hours}h"] = _verification_period(
                observed.get(f"precipitation_{hours}h_mm"), forecast, generated_at
            )
        statuses = [item["status"] for item in periods.values()]
        station["verification"] = {
            "quality_status": "PASS"
            if all(status == "PASS" for status in statuses)
            else "MISSING"
            if all(status in {"OBSERVATION_MISSING", "NO_MATCHED_FORECAST"} for status in statuses)
            else "WARNING",
            **periods,
        }
    dataset["verification_definition"] = {
        "metric": "realization_pct = IMERG observed precipitation / prior Open-Meteo forecast precipitation × 100",
        "alignment": "按完整UTC日严格对齐；只使用验证期开始前已生成的历史预报",
        "forecast_error": "forecast_mm - observed_mm；正值表示预报偏多",
        "minimum_forecast_mm_for_ratio": 1.0,
        "note": "兑现率是降水量实现比，不是预报准确率；首次运行需等待可对齐的历史预报样本。",
    }


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


def build_station(location, payload, thresholds, tapping_window, forecast_start_utc):
    daily = payload.get("daily") or {}
    hourly = payload.get("hourly") or {}
    dates = (daily.get("time") or [])[:7]
    tapping = tapping_window_by_date(hourly, dates, tapping_window)
    rows = []
    for index, date in enumerate(dates):
        row = {"date": date}
        for key in DAILY_FIELDS:
            values = daily.get(key) or []
            row[key] = values[index] if index < len(values) else None
        window = tapping.get(date) or {}
        row["tapping_window_precipitation_mm"] = window.get("precipitation_mm")
        row["tapping_window_rain_hours"] = window.get("rain_hours")
        row["tapping_window_precipitation_probability_max"] = window.get(
            "precipitation_probability_max"
        )
        rows.append(row)

    rain = [row["precipitation_sum"] for row in rows]
    tmax = [row["temperature_2m_max"] for row in rows]
    tmin = [row["temperature_2m_min"] for row in rows]
    et0 = [row["et0_fao_evapotranspiration"] for row in rows]
    soil_shallow = (hourly.get("soil_moisture_9_to_27cm") or [])[: 24 * len(rows)]
    soil_deep = (hourly.get("soil_moisture_27_to_81cm") or [])[: 24 * len(rows)]
    tapping_rain = [row["tapping_window_precipitation_mm"] for row in rows]
    tapping_hours = [row["tapping_window_rain_hours"] for row in rows]
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
        "tapping_window_precipitation_7d_mm": _sum(tapping_rain),
        "tapping_window_rain_hours_7d": int(sum(_finite(tapping_hours)))
        if _finite(tapping_hours)
        else None,
        "tapping_window_rain_days_7d": sum(
            value >= tapping_window["rain_hour_threshold_mm"] for value in _finite(tapping_rain)
        )
        if _finite(tapping_rain)
        else None,
        "tapping_window_probability_max_7d": _max(
            [row["tapping_window_precipitation_probability_max"] for row in rows]
        ),
    }
    summary["weather_states"] = classify(summary, thresholds)
    core = [rain, tmax, tmin]
    complete = (
        len(rows) == 7
        and all(len(_finite(values)) == 7 for values in core)
        and len(_finite(tapping_rain)) == 7
    )
    six_hour_forecast = utc_six_hour_forecast(
        hourly, payload.get("timezone"), forecast_start_utc
    )
    complete = complete and len(six_hour_forecast) == 28 and all(
        item["precipitation_mm"] is not None for item in six_hour_forecast
    )
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
        "forecast_utc_daily": utc_daily_forecast(hourly, payload.get("timezone")),
        "forecast_utc_6h": six_hour_forecast,
    }


def fetch_batch(locations, timeout=45, retries=3):
    params = {
        "latitude": ",".join(str(item["latitude"]) for item in locations),
        "longitude": ",".join(str(item["longitude"]) for item in locations),
        "daily": ",".join(DAILY_FIELDS),
        "hourly": ",".join(HOURLY_FIELDS),
        "forecast_days": 9,
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


def weekly_region_value(point_days, point_ids, week_start):
    """Return the equal-weight mean of complete seven-day point totals."""
    totals = []
    for point_id in point_ids:
        values = [
            point_days.get(point_id, {}).get((week_start + timedelta(days=offset)).isoformat())
            for offset in range(7)
        ]
        if len(_finite(values)) != 7:
            return None
        totals.append(sum(_finite(values)))
    return round(fmean(totals), 1) if totals else None


def fetch_thailand_weekly_rain(config, today=None, timeout=90, retries=3):
    """Fetch ERA5 daily rain and aggregate complete local Monday–Sunday weeks."""
    settings = config["thailand_weekly_rain"]
    points = settings["points"]
    today = today or datetime.now(timezone.utc).date()
    available_through = today - timedelta(days=settings["availability_lag_days"])
    end = available_through - timedelta(days=(available_through.weekday() + 1) % 7)
    start = datetime.fromisoformat(settings["start_date"]).date()
    if end < start:
        raise ValueError("Thailand weekly rain has no complete week to request")
    params = {
        "latitude": ",".join(str(item["latitude"]) for item in points),
        "longitude": ",".join(str(item["longitude"]) for item in points),
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "daily": "precipitation_sum",
        "timezone": settings["timezone"],
        "models": "era5",
        "cell_selection": "land",
    }
    request = urllib.request.Request(
        HISTORICAL_API_URL + "?" + urllib.parse.urlencode(params),
        headers={"User-Agent": "natural-rubber-weather-dashboard/1.0"},
    )
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                data = json.load(response)
            payloads = data if isinstance(data, list) else [data]
            if len(payloads) != len(points):
                raise ValueError(f"historical response count {len(payloads)} != {len(points)}")
            break
        except Exception:
            if attempt + 1 == retries:
                raise
            time.sleep(2**attempt)

    point_days = {}
    for point, payload in zip(points, payloads):
        daily = payload.get("daily") or {}
        point_days[point["point_id"]] = dict(
            zip(daily.get("time") or [], daily.get("precipitation_sum") or [])
        )

    weeks = []
    cursor = start
    while cursor <= end:
        weeks.append(cursor)
        cursor += timedelta(days=7)
    regions = []
    for region in settings["regions"]:
        weekly = []
        for week_start in weeks:
            iso_year, iso_week, _ = week_start.isocalendar()
            weekly.append(
                {
                    "week_start": week_start.isoformat(),
                    "week_end": (week_start + timedelta(days=6)).isoformat(),
                    "iso_year": iso_year,
                    "iso_week": iso_week,
                    "precipitation_mm": weekly_region_value(
                        point_days, region["point_ids"], week_start
                    ),
                }
            )
        values = [item["precipitation_mm"] for item in weekly]
        regions.append(
            {
                **region,
                "point_count": len(region["point_ids"]),
                "quality_status": "PASS"
                if len(_finite(values)) == len(weekly)
                else ("WARNING" if _finite(values) else "MISSING"),
                "weekly": weekly,
            }
        )
    statuses = [region["quality_status"] for region in regions]
    return {
        "schema_version": 1,
        "dataset_id": "THAILAND_WEEKLY_RAIN_ERA5_V1",
        "generated_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "period": {
            "start_date": start.isoformat(),
            "end_date": end.isoformat(),
            "week_definition": "Monday–Sunday, Asia/Bangkok local date",
            "unit": "mm",
        },
        "overall_quality_status": "PASS"
        if statuses and set(statuses) == {"PASS"}
        else ("MISSING" if statuses and set(statuses) == {"MISSING"} else "WARNING"),
        "source": THAILAND_WEEKLY_SOURCE,
        "aggregation": settings["description"],
        "points": points,
        "regions": regions,
    }


def atomic_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        temporary = Path(handle.name)
    os.replace(temporary, path)


def _atomic_write(path, payload, mode="w"):
    path.parent.mkdir(parents=True, exist_ok=True)
    options = {"dir": path.parent, "delete": False, "mode": mode}
    if "b" not in mode:
        options["encoding"] = "utf-8"
    with tempfile.NamedTemporaryFile(**options) as handle:
        handle.write(payload)
        temporary = Path(handle.name)
    os.replace(temporary, path)


def parse_bom_index(payload):
    """Parse BoM weekly rows: period start, period end, index value."""
    points = []
    for line in payload.splitlines():
        fields = [field.strip() for field in line.split(",")]
        if len(fields) < 3:
            continue
        try:
            date = datetime.strptime(fields[1], "%Y%m%d").date()
            value = float(fields[2])
        except ValueError:
            continue
        if math.isfinite(value):
            points.append((date, value))
    return sorted(set(points))


def render_bom_svg(points, title, y_min, y_max, negative_threshold, positive_threshold):
    """Render official weekly values as a dependency-free SVG."""
    if not points:
        raise ValueError("BoM index contains no usable observations")
    latest = points[-1][0]
    start = latest - timedelta(days=18 * 366)
    points = [point for point in points if point[0] >= start]
    width, height = 960, 430
    left, right, top, bottom = 62, 22, 54, 48
    plot_width = width - left - right
    plot_height = height - top - bottom
    first, last = points[0][0], points[-1][0]
    span = max(1, (last - first).days)

    def x(date):
        return left + (date - first).days / span * plot_width

    def y(value):
        return top + (y_max - value) / (y_max - y_min) * plot_height

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" role="img" aria-labelledby="title desc">',
        f'<title id="title">{title}</title>',
        f'<desc id="desc">Weekly observations through {latest.isoformat()}, climatology 1991–2020.</desc>',
        '<rect width="100%" height="100%" fill="#fff"/>',
        f'<rect x="{left}" y="{top}" width="{plot_width}" height="{y(positive_threshold) - top:.1f}" fill="#fde8e8"/>',
        f'<rect x="{left}" y="{y(negative_threshold):.1f}" width="{plot_width}" height="{top + plot_height - y(negative_threshold):.1f}" fill="#e8e9ff"/>',
        f'<text x="{width / 2}" y="27" text-anchor="middle" font-family="sans-serif" font-size="19" font-weight="700" fill="#294b55">{title}</text>',
        '<g font-family="sans-serif" font-size="11" fill="#586b70">',
    ]
    for value in range(math.ceil(y_min), math.floor(y_max) + 1):
        yy = y(value)
        parts.extend(
            (
                f'<line x1="{left}" y1="{yy:.1f}" x2="{left + plot_width}" y2="{yy:.1f}" stroke="#c9d2d4" stroke-dasharray="3 3"/>',
                f'<text x="{left - 10}" y="{yy + 4:.1f}" text-anchor="end">{value}</text>',
            )
        )
    first_tick_year = first.year + (first.year % 2)
    for year in range(first_tick_year, last.year + 1, 2):
        xx = x(datetime(year, 1, 1).date())
        parts.extend(
            (
                f'<line x1="{xx:.1f}" y1="{top}" x2="{xx:.1f}" y2="{top + plot_height}" stroke="#e0e6e7"/>',
                f'<text x="{xx:.1f}" y="{top + plot_height + 22}" text-anchor="middle">{year}</text>',
            )
        )
    parts.append('</g>')
    for threshold, color in ((negative_threshold, "#7980d9"), (positive_threshold, "#ec7777")):
        parts.append(
            f'<line x1="{left}" y1="{y(threshold):.1f}" x2="{left + plot_width}" y2="{y(threshold):.1f}" stroke="{color}" stroke-width="1.5" stroke-dasharray="7 5"/>'
        )
    segments, current = [], []
    previous = None
    for date, value in points:
        if previous and (date - previous).days > 21:
            segments.append(current)
            current = []
        current.append(f"{x(date):.1f},{y(value):.1f}")
        previous = date
    if current:
        segments.append(current)
    for segment in segments:
        if len(segment) > 1:
            coordinates = " ".join(segment)
            parts.append(
                f'<polyline points="{coordinates}" fill="none" stroke="#30383a" stroke-width="1.35" stroke-linejoin="round" stroke-linecap="round"/>'
            )
    parts.extend(
        (
            f'<text x="{left}" y="{height - 10}" font-family="sans-serif" font-size="10" fill="#6c7d80">Latest week ending {latest.isoformat()}</text>',
            f'<text x="{width - right}" y="{height - 10}" text-anchor="end" font-family="sans-serif" font-size="10" fill="#6c7d80">Climatology period 1991–2020</text>',
            "</svg>",
        )
    )
    return "\n".join(parts) + "\n"


def _public_request(url, timeout=45):
    request = urllib.request.Request(
        url, headers={"User-Agent": "natural-rubber-weather-dashboard/1.0"}
    )
    return urllib.request.urlopen(request, timeout=timeout)


def update_climate_charts():
    """Refresh BoM weekly charts and the current NOAA CPC RONI outlook."""
    warnings = []
    for url, filename, title, y_min, y_max, low, high in BOM_INDEXES:
        try:
            with _public_request(url) as response:
                points = parse_bom_index(response.read().decode("utf-8", errors="replace"))
            _atomic_write(
                CLIMATE_ASSET_DIR / filename,
                render_bom_svg(points, title, y_min, y_max, low, high),
            )
        except Exception as exc:
            warnings.append(f"{title}: {exc}")
    try:
        with _public_request(NOAA_RONI_OUTLOOK_URL) as response:
            page = response.read().decode("utf-8", errors="replace")
        match = re.search(
            r'<img[^>]+src=["\']([^"\']*enso-roni-outlook-current\.png)["\']',
            page,
            re.IGNORECASE,
        )
        if not match:
            raise RuntimeError("current outlook image was not found")
        image_url = urllib.parse.urljoin(NOAA_RONI_OUTLOOK_URL, match.group(1))
        with _public_request(image_url) as response:
            _atomic_write(CLIMATE_ASSET_DIR / "roni-outlook.png", response.read(), "wb")
    except Exception as exc:
        warnings.append(f"NOAA CPC RONI outlook: {exc}")
    return warnings


def history_entry(dataset):
    return {
        "generated_at_utc": dataset["generated_at_utc"],
        "stations": [
            {
                "station_id": station["station_id"],
                **station["summary"],
                "quality_status": station["quality_status"],
                "forecast_utc_daily": station.get("forecast_utc_daily") or [],
            }
            for station in dataset["stations"]
        ],
    }


def update_history(path, dataset, maximum=400):
    history = {"schema_version": 2, "snapshots": []}
    if path.exists():
        history = json.loads(path.read_text(encoding="utf-8"))
    snapshots = history.get("snapshots") or []
    snapshots = [item for item in snapshots if item.get("generated_at_utc") != dataset["generated_at_utc"]]
    snapshots.append(history_entry(dataset))
    history["schema_version"] = 2
    history["snapshots"] = snapshots[-maximum:]
    atomic_json(path, history)


def collect(config_path):
    config = json.loads(config_path.read_text(encoding="utf-8"))
    locations = config["locations"]
    thresholds = config["thresholds"]
    tapping_window = config["tapping_window"]
    now = datetime.now(timezone.utc).replace(microsecond=0)
    stations = []
    for start in range(0, len(locations), 15):
        batch = locations[start : start + 15]
        payloads = fetch_batch(batch)
        stations.extend(
            build_station(location, payload, thresholds, tapping_window, now)
            for location, payload in zip(batch, payloads)
        )
    email = os.environ.get("NASA_PPS_EMAIL", "").strip()
    try:
        observation_source, imerg = fetch_imerg(locations, email)
    except Exception:
        reason = (
            "NASA PPS凭据未配置；请在GitHub Actions仓库密钥中设置NASA_PPS_EMAIL。"
            if not email
            else "NASA IMERG数据当前不可用；本次保持MISSING，不沿用旧值。"
        )
        observation_source, imerg = missing_imerg(locations, reason)
    for station in stations:
        station["imerg"] = imerg[station["station_id"]]
    quality_counts = {status: sum(item["quality_status"] == status for item in stations) for status in ("PASS", "WARNING", "MISSING")}
    overall = "PASS" if quality_counts["PASS"] == len(stations) else "WARNING"
    return {
        "schema_version": 3,
        "dataset_id": "NR_PRODUCTION_REGION_WEATHER_MONITOR_V2",
        "generated_at_utc": now.isoformat().replace("+00:00", "Z"),
        "forecast_horizon": "D0-D6",
        "forecast_6h_definition": {
            "metric": "Open-Meteo hourly precipitation summed into six-hour periods",
            "interval_hours": 6,
            "periods": 28,
            "timezone": "UTC",
            "unit": "mm",
            "note": "表头为时段起点；缺少任一小时则该6小时累计保持为空。",
        },
        "overall_quality_status": overall,
        "quality_counts": quality_counts,
        "thresholds": thresholds,
        "tapping_window": tapping_window,
        "source": SOURCE,
        "observation_source": observation_source,
        "scope_note": config["description"],
        "stations": stations,
    }


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=ROOT / "config" / "locations.json")
    parser.add_argument("--output", type=Path, default=ROOT / "site" / "data" / "weather.json")
    parser.add_argument("--history", type=Path, default=ROOT / "site" / "data" / "history.json")
    parser.add_argument(
        "--thailand-weekly-output",
        type=Path,
        default=ROOT / "site" / "data" / "thailand-weekly-rain.json",
    )
    args = parser.parse_args(argv)
    dataset = collect(args.config)
    if not dataset["stations"]:
        raise RuntimeError("No station data returned; existing published data was not changed.")
    history = {"schema_version": 2, "snapshots": []}
    if args.history.exists():
        history = json.loads(args.history.read_text(encoding="utf-8"))
    attach_verification(dataset, history)
    atomic_json(args.output, dataset)
    update_history(args.history, dataset)
    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
        atomic_json(args.thailand_weekly_output, fetch_thailand_weekly_rain(config))
    except Exception as exc:
        print(f"Thailand weekly rain warning: {exc}", file=sys.stderr)
    for warning in update_climate_charts():
        print(f"climate chart warning: {warning}", file=sys.stderr)
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
