#!/usr/bin/env python3
"""计算“预报模式 vs ERA5”的降雨系统偏差比例，用于校正季节基准。

背景：网页的当前值（未来7日预报、过去7/14/30日 past_days）来自 Open-Meteo Best Match 预报模式，
季节基准来自 ERA5 再分析；两套系统在热带地区存在系统偏差。为让“较常年”可比，用两者都有数据的
重叠期，按点位、按月份求比例：

    ratio(点位, 月份 m) = 重叠期内 m-1、m、m+1 三个月 模式日降雨之和 / ERA5 日降雨之和

update_weather.py 计算距平时，把该月的 ERA5 基准（均值和各分位数）乘以 ratio，换算到模式口径再比较。

- 模式数据：Open-Meteo Historical Forecast API（Best Match 预报存档，与 past_days 同源）；
- ERA5：Open-Meteo Historical Weather API；
- 重叠期默认 2022–2025 年（config/locations.json 的 model_bias 段可调）；
- ERA5 三个月合计低于 min_reference_mm 时比例不可靠，保持为空（不校正）；
- 比例截断在 [0.5, 2.0]，超出视为异常并记 WARNING。

结果写入 data/climatology/model-bias-<起>-<止>.json；可断点续跑、失败批次自动重试。

--source imerg：改为计算“IMERG卫星日降水 / ERA5”的逐月比例，分子取自 data/observations/imerg-daily.json
（scripts/backfill_imerg.py 回填），ERA5 按 UTC 日请求；重叠期为存档覆盖期（截至约7天前，ERA5有滞后）。
每个三个月窗口至少需要60天配对数据，否则该月为空（不校正）。结果写入 data/climatology/imerg-bias.json，每次全量重算。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_climatology import HISTORICAL_API_URL, atomic_json, fetch_daily  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
HISTORICAL_FORECAST_API_URL = "https://historical-forecast-api.open-meteo.com/v1/forecast"
DEFAULTS = {
    "start_year": 2022,
    "end_year": 2025,
    "min_reference_mm": 30.0,
    "clip": [0.5, 2.0],
    "batch_size": 4,
    "pause_seconds": 20,
}


def settings_from(config: dict) -> dict:
    return {**DEFAULTS, **(config.get("model_bias") or {})}


def default_output(settings: dict) -> Path:
    return ROOT / "data" / "climatology" / f"model-bias-{settings['start_year']}-{settings['end_year']}.json"


def monthly_ratios(model_daily: dict, era5_daily: dict, min_reference_mm=30.0, clip=(0.5, 2.0), min_days=0):
    """返回 (ratios[12], details[12])。仅用两边都有值的日期；三个月滑动窗口。"""
    by_month = {m: [0.0, 0.0, 0] for m in range(1, 13)}  # model_sum, era5_sum, days
    for key, mv in model_daily.items():
        ev = era5_daily.get(key)
        if mv is None or ev is None:
            continue
        m = int(key[5:7])
        by_month[m][0] += float(mv)
        by_month[m][1] += float(ev)
        by_month[m][2] += 1
    ratios, details = [], []
    for m in range(1, 13):
        months = [((m - 2) % 12) + 1, m, (m % 12) + 1]
        model_sum = sum(by_month[x][0] for x in months)
        era5_sum = sum(by_month[x][1] for x in months)
        days = sum(by_month[x][2] for x in months)
        raw = model_sum / era5_sum if era5_sum >= min_reference_mm and days >= min_days else None
        ratio = None if raw is None else round(min(max(raw, clip[0]), clip[1]), 3)
        ratios.append(ratio)
        details.append({"model_mm": round(model_sum, 1), "era5_mm": round(era5_sum, 1), "days": days,
                        "raw_ratio": None if raw is None else round(raw, 3),
                        "clipped": raw is not None and not (clip[0] <= raw <= clip[1])})
    return ratios, details


def empty_dataset(settings: dict) -> dict:
    return {
        "schema_version": 1,
        "dataset_id": "NR_PRECIP_MODEL_BIAS_V1",
        "data_type": "ESTIMATE",
        "overlap": {"start_year": settings["start_year"], "end_year": settings["end_year"]},
        "method": "比例=重叠期内(m-1,m,m+1)三个月 Best Match 预报存档日降雨之和 / ERA5 日降雨之和；"
                  f"ERA5合计<{settings['min_reference_mm']}mm时为空（不校正）；截断到{settings['clip']}。",
        "use": "update_weather.py 计算距平时，用窗口中点所在月份的比例乘以ERA5基准（均值与分位数）。",
        "sources": {
            "model": {"name": "Open-Meteo Historical Forecast API (Best Match)", "endpoint": HISTORICAL_FORECAST_API_URL},
            "reference": {"name": "Open-Meteo Historical Weather API (ERA5)", "endpoint": HISTORICAL_API_URL},
        },
        "stations": {},
    }


def build_imerg_bias(args):
    config = json.loads(args.config.read_text(encoding="utf-8"))
    settings = settings_from(config)
    archive_path = ROOT / "data" / "observations" / "imerg-daily.json"
    if not archive_path.exists():
        print("imerg bias: 卫星存档不存在，请先运行 backfill_imerg.py", file=sys.stderr)
        return 1
    archive = json.loads(archive_path.read_text(encoding="utf-8"))
    obs = archive.get("stations") or {}
    dates = sorted({d for values in obs.values() for d in values})
    if not dates:
        print("imerg bias: 卫星存档为空", file=sys.stderr)
        return 1
    start = date.fromisoformat(dates[0])
    end = min(date.fromisoformat(dates[-1]), datetime.now(timezone.utc).date() - timedelta(days=7))
    output = args.output or ROOT / "data" / "climatology" / "imerg-bias.json"
    dataset = empty_dataset(settings)
    dataset["dataset_id"] = "NR_PRECIP_IMERG_BIAS_V1"
    dataset["overlap"] = {"start_date": start.isoformat(), "end_date": end.isoformat()}
    dataset["method"] = ("比例=重叠期内(m-1,m,m+1)三个月 IMERG Late 1日累计之和 / ERA5 日降雨之和（均按UTC日，仅用两边都有值的日期）；"
                         f"配对少于60天或ERA5合计<{settings['min_reference_mm']}mm时为空（不校正）；截断到{settings['clip']}。")
    dataset["use"] = "update_weather.py 计算“过去n日（卫星）”距平时，用窗口中点所在月份的比例乘以ERA5基准。"
    dataset["sources"]["model"] = {"name": "NASA GPM IMERG Late Run GIS 1day（本仓库点值存档）",
                                   "path": "data/observations/imerg-daily.json"}
    locs = [loc for loc in config["locations"] if obs.get(loc["station_id"])]
    deadline = time.monotonic() + args.max_minutes * 60
    size = max(1, int(settings["batch_size"]))
    pending = [locs[i:i + size] for i in range(0, len(locs), size)]
    for round_no in range(1, 5):
        failed = []
        for k, batch in enumerate(pending):
            if time.monotonic() > deadline:
                failed.extend(pending[k:])
                break
            try:
                era5 = fetch_daily(batch, start, end, url=HISTORICAL_API_URL, model="era5", tz="GMT")
            except Exception as exc:
                print(f"imerg bias batch failed ({[b['station_id'] for b in batch]}): {exc}", file=sys.stderr)
                failed.append(batch)
                time.sleep(settings["pause_seconds"])
                continue
            built_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
            for loc, ed in zip(batch, era5):
                ratios, details = monthly_ratios(obs[loc["station_id"]], ed, settings["min_reference_mm"],
                                                 settings["clip"], min_days=60)
                filled = sum(r is not None for r in ratios)
                clipped = sum(d["clipped"] for d in details)
                dataset["stations"][loc["station_id"]] = {
                    "latitude": loc["latitude"], "longitude": loc["longitude"], "built_at_utc": built_at,
                    "quality_status": "MISSING" if filled == 0 else ("WARNING" if clipped or filled < 12 else "PASS"),
                    "ratio_by_month": ratios, "details_by_month": details,
                }
            dataset["generated_at_utc"] = built_at
            atomic_json(output, dataset, indent=1)
            print(f"imerg bias: built {[b['station_id'] for b in batch]}", file=sys.stderr)
            time.sleep(settings["pause_seconds"])
        if not failed or time.monotonic() > deadline:
            break
        time.sleep(90)
        pending = failed
    done = len(dataset["stations"])
    print(f"imerg bias: {done} of {len(locs)} stations; overlap {start}..{end}", file=sys.stderr)
    return 0 if done == len(locs) else 1


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=ROOT / "config" / "locations.json")
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--max-minutes", type=float, default=30)
    parser.add_argument("--rebuild", action="store_true")
    parser.add_argument("--source", choices=("model", "imerg"), default="model")
    args = parser.parse_args(argv)
    if args.source == "imerg":
        return build_imerg_bias(args)

    config = json.loads(args.config.read_text(encoding="utf-8"))
    settings = settings_from(config)
    output = args.output or default_output(settings)
    dataset = empty_dataset(settings)
    if output.exists() and not args.rebuild:
        old = json.loads(output.read_text(encoding="utf-8"))
        if old.get("overlap") == dataset["overlap"]:
            dataset["stations"] = old.get("stations") or {}

    def needs(loc):
        entry = dataset["stations"].get(loc["station_id"])
        return (not entry or entry.get("quality_status") == "MISSING"
                or entry.get("latitude") != loc["latitude"] or entry.get("longitude") != loc["longitude"])

    todo = [loc for loc in config["locations"] if needs(loc)]
    print(f"model bias: {len(todo)} of {len(config['locations'])} stations to build", file=sys.stderr)
    start, end = date(settings["start_year"], 1, 1), date(settings["end_year"], 12, 31)
    deadline = time.monotonic() + args.max_minutes * 60
    size = max(1, int(settings["batch_size"]))
    pending = [todo[i:i + size] for i in range(0, len(todo), size)]
    for round_no in range(1, 5):
        failed = []
        for k, batch in enumerate(pending):
            if time.monotonic() > deadline:
                failed.extend(pending[k:])
                break
            try:
                model = fetch_daily(batch, start, end, url=HISTORICAL_FORECAST_API_URL, model=None)
                time.sleep(settings["pause_seconds"] / 2)
                era5 = fetch_daily(batch, start, end, url=HISTORICAL_API_URL, model="era5")
            except Exception as exc:
                print(f"model bias batch failed ({[b['station_id'] for b in batch]}): {exc}", file=sys.stderr)
                failed.append(batch)
                time.sleep(settings["pause_seconds"])
                continue
            built_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
            for loc, md, ed in zip(batch, model, era5):
                ratios, details = monthly_ratios(md, ed, settings["min_reference_mm"], settings["clip"])
                filled = sum(r is not None for r in ratios)
                clipped = sum(d["clipped"] for d in details)
                dataset["stations"][loc["station_id"]] = {
                    "latitude": loc["latitude"],
                    "longitude": loc["longitude"],
                    "built_at_utc": built_at,
                    "quality_status": "MISSING" if filled == 0 else ("WARNING" if clipped or filled < 12 else "PASS"),
                    "ratio_by_month": ratios,
                    "details_by_month": details,
                }
            dataset["generated_at_utc"] = built_at
            atomic_json(output, dataset, indent=1)
            print(f"model bias: built {[b['station_id'] for b in batch]}", file=sys.stderr)
            time.sleep(settings["pause_seconds"])
        if not failed or time.monotonic() > deadline:
            break
        print(f"model bias: retry round {round_no} for {len(failed)} batches after cooldown", file=sys.stderr)
        time.sleep(90)
        pending = failed
    missing = [loc["station_id"] for loc in config["locations"] if needs(loc)]
    print(f"model bias: {len(missing)} stations still missing {missing}", file=sys.stderr)
    return 1 if missing else 0


if __name__ == "__main__":
    raise SystemExit(main())
