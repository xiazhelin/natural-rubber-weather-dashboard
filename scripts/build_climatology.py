#!/usr/bin/env python3
"""构建各代表网格点的降雨气候态（季节基准），供 update_weather.py 计算距平。

数据：Open-Meteo Historical Weather API 的 ERA5 再分析日降雨（0.25°网格，非地面站）。
基准期：默认 2001–2025 年（可在 config/locations.json 的 climatology 段调整）。

对每个点位、每个窗口长度 n（7/14/30 日）和每个“窗口起始日”（一年中的第 1–365 天），
把基准期内所有年份、起始日前后 ±3 天的 n 日累计降雨合成样本池（25年×7天=175个样本），
计算 均值、p10、p33、p67、p90。

- 未来7日距平：用“D0 当天”为起始日的 7 日统计；
- 过去 n 日距平：用“D0 前 n 天”为起始日的 n 日统计。

结果写入 data/climatology/precip-era5-<起>-<止>.json（不发布到网页，只供更新脚本读取）。
脚本可断点续跑：已完成且坐标、基准期未变的点位会跳过；每完成一批就写盘一次。

用法：
    python3 scripts/build_climatology.py                 # 补齐缺失点位
    python3 scripts/build_climatology.py --max-minutes 40
    python3 scripts/build_climatology.py --rebuild       # 全部重建
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HISTORICAL_API_URL = "https://archive-api.open-meteo.com/v1/archive"
WINDOWS = (7, 14, 30)
STATS = ("mean", "p10", "p33", "p67", "p90")
DEFAULTS = {
    "start_year": 2001,
    "end_year": 2025,
    "pool_half_width_days": 3,
    "batch_size": 4,
    "pause_seconds": 20,
}
SOURCE = {
    "source_id": "HIST_OPEN_METEO_ERA5_01",
    "source_name": "Open-Meteo Historical Weather API",
    "endpoint": HISTORICAL_API_URL,
    "documentation": "https://open-meteo.com/en/docs/historical-weather-api",
    "upstream_model": "ERA5 reanalysis",
    "data_nature": "0.25°再分析网格估算，不是地面雨量站实测",
    "access": "免费非商业公开接口，无需API Key；数据许可CC BY 4.0",
}


def settings_from(config: dict) -> dict:
    return {**DEFAULTS, **(config.get("climatology") or {})}


def default_output(settings: dict) -> Path:
    return ROOT / "data" / "climatology" / f"precip-era5-{settings['start_year']}-{settings['end_year']}.json"


def day_of_year(day: date) -> int:
    """1–365；2月29日按2月28日计（返回59），3月1日起闰年减1，使各年同一日历日对齐。"""
    doy = day.timetuple().tm_yday
    if _is_leap(day.year) and doy >= 60:
        doy -= 1
    return doy


def _is_leap(year: int) -> bool:
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)


def date_from_doy(year: int, doy: int) -> date:
    """day_of_year 的反函数（不返回2月29日）。"""
    day = date(year, 1, 1) + timedelta(days=doy - 1)
    if _is_leap(year) and doy >= 60:
        day += timedelta(days=1)
    return day


def _quantile(sorted_values, q):
    if not sorted_values:
        return None
    pos = (len(sorted_values) - 1) * q
    lo = int(pos)
    hi = min(lo + 1, len(sorted_values) - 1)
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * (pos - lo)


def climatology_from_daily(daily: dict, start_year: int, end_year: int, half_width: int = 3,
                           windows=WINDOWS, min_samples: int = 30) -> dict:
    """daily: {'YYYY-MM-DD': mm 或 None}。返回 {str(n): [[mean,p10,p33,p67,p90] 或 None] * 365}。

    含缺失日的窗口不计入样本；样本数不足 min_samples 时该日为 None。
    """
    values = {}
    for key, value in daily.items():
        if value is not None:
            values[date.fromisoformat(key)] = float(value)
    result = {}
    for n in windows:
        # 先算每个起始日的 n 日累计
        sums = {}
        for year in range(start_year, end_year + 1):
            for doy in range(1, 366):
                start = date_from_doy(year, doy)
                total = 0.0
                ok = True
                for offset in range(n):
                    v = values.get(start + timedelta(days=offset))
                    if v is None:
                        ok = False
                        break
                    total += v
                if ok:
                    sums[(year, doy)] = total
        table = []
        for doy in range(1, 366):
            pool = []
            for year in range(start_year, end_year + 1):
                for k in range(-half_width, half_width + 1):
                    d = doy + k
                    y = year
                    if d < 1:
                        d += 365
                        y -= 1
                    elif d > 365:
                        d -= 365
                        y += 1
                    if start_year <= y <= end_year and (y, d) in sums:
                        pool.append(sums[(y, d)])
            if len(pool) < min_samples:
                table.append(None)
                continue
            pool.sort()
            table.append([
                round(statistics.fmean(pool), 1),
                round(_quantile(pool, 0.10), 1),
                round(_quantile(pool, 1 / 3), 1),
                round(_quantile(pool, 2 / 3), 1),
                round(_quantile(pool, 0.90), 1),
            ])
        result[str(n)] = table
    return result


def fetch_daily(locations, start: date, end: date, timeout=180, retries=4):
    params = {
        "latitude": ",".join(str(item["latitude"]) for item in locations),
        "longitude": ",".join(str(item["longitude"]) for item in locations),
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "daily": "precipitation_sum",
        "timezone": "auto",
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
            if len(payloads) != len(locations):
                raise ValueError(f"historical response count {len(payloads)} != {len(locations)}")
            out = []
            for payload in payloads:
                daily = payload.get("daily") or {}
                out.append(dict(zip(daily.get("time") or [], daily.get("precipitation_sum") or [])))
            return out
        except Exception:
            if attempt + 1 == retries:
                raise
            time.sleep(30 * (attempt + 1))


def atomic_json(path: Path, payload, indent=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=indent, separators=None if indent else (",", ":"))
        handle.write("\n")
        temporary = Path(handle.name)
    os.replace(temporary, path)


def empty_dataset(settings: dict) -> dict:
    return {
        "schema_version": 1,
        "dataset_id": "NR_PRECIP_CLIMATOLOGY_ERA5_V1",
        "data_type": "ESTIMATE",
        "baseline": {"start_year": settings["start_year"], "end_year": settings["end_year"]},
        "windows_days": list(WINDOWS),
        "stats": list(STATS),
        "pool_half_width_days": settings["pool_half_width_days"],
        "unit": "mm",
        "day_index": "窗口起始日在一年中的序号1–365（当地日期；2月29日并入2月28日）",
        "method": "基准期内各年、起始日±3天的n日累计降雨合成样本池；含缺失日的窗口不计入；样本少于30个时为空。",
        "source": SOURCE,
        "stations": {},
    }


def needs_build(entry, location, settings) -> bool:
    if not entry or entry.get("quality_status") == "MISSING":
        return True
    return (
        entry.get("latitude") != location["latitude"]
        or entry.get("longitude") != location["longitude"]
    )


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=ROOT / "config" / "locations.json")
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--max-minutes", type=float, default=50)
    parser.add_argument("--rebuild", action="store_true")
    args = parser.parse_args(argv)

    config = json.loads(args.config.read_text(encoding="utf-8"))
    settings = settings_from(config)
    output = args.output or default_output(settings)
    dataset = empty_dataset(settings)
    if output.exists() and not args.rebuild:
        old = json.loads(output.read_text(encoding="utf-8"))
        if old.get("baseline") == dataset["baseline"]:
            dataset["stations"] = old.get("stations") or {}

    todo = [loc for loc in config["locations"]
            if needs_build(dataset["stations"].get(loc["station_id"]), loc, settings)]
    print(f"climatology: {len(todo)} of {len(config['locations'])} stations to build", file=sys.stderr)
    start = date(settings["start_year"] - 1, 12, 1)  # 前后各留缓冲，覆盖跨年窗口
    end = date(settings["end_year"] + 1, 2, 1)
    deadline = time.monotonic() + args.max_minutes * 60
    size = max(1, int(settings["batch_size"]))
    for i in range(0, len(todo), size):
        if time.monotonic() > deadline:
            print("climatology: time budget reached; rerun to continue", file=sys.stderr)
            break
        batch = todo[i:i + size]
        try:
            series = fetch_daily(batch, start, end)
        except Exception as exc:  # 单批失败不影响已完成部分
            print(f"climatology batch failed ({[b['station_id'] for b in batch]}): {exc}", file=sys.stderr)
            time.sleep(settings["pause_seconds"])
            continue
        built_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        for loc, daily in zip(batch, series):
            table = climatology_from_daily(daily, settings["start_year"], settings["end_year"],
                                           settings["pool_half_width_days"])
            filled = sum(v is not None for v in table["7"])
            dataset["stations"][loc["station_id"]] = {
                "latitude": loc["latitude"],
                "longitude": loc["longitude"],
                "built_at_utc": built_at,
                "quality_status": "PASS" if filled == 365 else ("WARNING" if filled else "MISSING"),
                "windows": table,
            }
        dataset["generated_at_utc"] = built_at
        atomic_json(output, dataset)
        print(f"climatology: built {[b['station_id'] for b in batch]}", file=sys.stderr)
        if i + size < len(todo):
            time.sleep(settings["pause_seconds"])
    missing = [loc["station_id"] for loc in config["locations"]
               if needs_build(dataset["stations"].get(loc["station_id"]), loc, settings)]
    print(f"climatology: {len(missing)} stations still missing", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
