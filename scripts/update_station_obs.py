#!/usr/bin/env python3
"""气象站逐日实测：按产量权重选站，下载 NOAA NCEI GSOD（Global Summary of the Day），生成网页用的站点数据。

数据：GSOD 由各国气象站经 GTS 上报的逐时/天气报告汇总为逐日值（降水、平均/最高/最低气温），
      https://www.ncei.noaa.gov/data/global-summary-of-the-day/access/<年>/<站号>.csv
      站点名录 https://www.ncei.noaa.gov/pub/data/noaa/isd-history.csv

选站规则（第一次运行或 --reselect 时执行，结果固定写入 config/gsod-stations.json）：
  - 泰国：按府产量占比从高到低，直到累计覆盖全国 ≥70%；
  - 印尼：全部已加权的省；越南、中国、科特迪瓦：全部代表点；
  - 每个目标取 2015 年前开始观测、近 400 天内仍有记录的最近站点，≤75 km 为正常，
    75–120 km 标记 FAR（页面提示“站点离产区较远”），>120 km 不选；多个目标共用一个站时合并。

输出：
  data/stations/gsod/<站号>/<年>.json   每站每年逐日数据（往年写入后不再改写；当年每次更新覆盖）
  site/data/stations/history.json       各站往年（起始年至去年）逐日降水与气温，按年数组存储
  site/data/stations/current.json       各站当年逐日数据（每天更新，体积小）
单位：降水 mm（GSOD 英寸×25.4），气温 ℃（GSOD 华氏）；缺测保持为空，不补 0。
降水标记为 I（当日无降水报告）或值为 99.99 时视为缺测；A/B/C/E（只有部分时段报告）保留数值并计入“降水不完整”统计。
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import math
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ISD_HISTORY_URL = "https://www.ncei.noaa.gov/pub/data/noaa/isd-history.csv"
GSOD_URL = "https://www.ncei.noaa.gov/data/global-summary-of-the-day/access/{year}/{station}.csv"
STATION_CONFIG = ROOT / "config" / "gsod-stations.json"
ARCHIVE_DIR = ROOT / "data" / "stations" / "gsod"
SITE_DIR = ROOT / "site" / "data" / "stations"
FIRST_YEAR = 2016
FIPS = {"泰国": "TH", "印度尼西亚": "ID", "越南": "VM", "中国": "CH", "科特迪瓦": "IV"}
THAILAND_COVERAGE_PCT = 70.0
NEAR_KM, MAX_KM = 75.0, 120.0
PARTIAL_PRCP_FLAGS = {"A", "B", "C", "E"}
SOURCE = {
    "source_name": "NOAA NCEI Global Surface Summary of the Day (GSOD)",
    "documentation": "https://www.ncei.noaa.gov/metadata/geoportal/rest/metadata/item/gov.noaa.ncdc:C00516/html",
    "data_nature": "气象站经GTS上报的观测汇总为逐日值；是地面站实测，但降水可能因只有部分时段报告而偏少",
    "access": "NOAA NCEI 公开数据，无需密钥",
}


def km(lat1, lon1, lat2, lon2):
    p = math.pi / 180
    a = math.sin((lat2 - lat1) * p / 2) ** 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(a))


def http_get(url, timeout=60, retries=3):
    request = urllib.request.Request(url, headers={"User-Agent": "natural-rubber-weather-dashboard/1.0"})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            if attempt + 1 == retries:
                raise
        except Exception:
            if attempt + 1 == retries:
                raise
        time.sleep(2 ** attempt)


# ---------- 选站 ----------

def select_targets(locations, weights):
    """返回需要配站的代表点：泰国按产量累计到70%，其余国家全部（印尼仅已加权的省）。"""
    targets = []
    thai = sorted([loc for loc in locations if loc["country"] == "泰国"],
                  key=lambda loc: -((weights.get(loc["station_id"]) or {}).get("share_of_country_pct") or 0))
    covered = 0.0
    for loc in thai:
        if covered >= THAILAND_COVERAGE_PCT:
            break
        share = (weights.get(loc["station_id"]) or {}).get("share_of_country_pct")
        if share is None:
            continue
        covered += share
        targets.append({**loc, "share_of_country_pct": share})
    for loc in locations:
        if loc["country"] == "泰国" or loc["country"] not in FIPS:
            continue
        share = (weights.get(loc["station_id"]) or {}).get("share_of_country_pct")
        if loc["country"] == "印度尼西亚" and share is None:
            continue
        targets.append({**loc, "share_of_country_pct": share})
    return targets, round(covered, 2)


def parse_isd_history(text):
    rows = []
    for row in csv.DictReader(io.StringIO(text)):
        try:
            lat, lon = float(row["LAT"]), float(row["LON"])
            begin, end = int(row["BEGIN"]), int(row["END"])
        except (TypeError, ValueError, KeyError):
            continue
        if not (-90 <= lat <= 90) or (lat == 0 and lon == 0):
            continue
        rows.append({"usaf": row["USAF"], "wban": row["WBAN"], "name": (row.get("STATION NAME") or "").strip(),
                     "ctry": row.get("CTRY", ""), "lat": lat, "lon": lon, "begin": begin, "end": end})
    return rows


def choose_stations(targets, isd_rows, today=None):
    today = today or datetime.now(timezone.utc).date()
    recent = int((today - timedelta(days=400)).strftime("%Y%m%d"))
    candidates = [r for r in isd_rows if r["begin"] <= int(f"{FIRST_YEAR - 1}0101") and r["end"] >= recent
                  and "AGROMET" not in r["name"].upper()]
    stations = {}
    unmatched = []
    for t in targets:
        pool = [r for r in candidates if r["ctry"] == FIPS[t["country"]]]
        best = min(pool, key=lambda r: km(t["latitude"], t["longitude"], r["lat"], r["lon"]), default=None)
        distance = km(t["latitude"], t["longitude"], best["lat"], best["lon"]) if best else None
        if best is None or distance > MAX_KM:
            unmatched.append({"station_id": t["station_id"], "place": t["place"], "country": t["country"],
                              "nearest_km": round(distance) if distance else None})
            continue
        gsod_id = f"{best['usaf']}{best['wban']}"
        entry = stations.setdefault(gsod_id, {
            "gsod_id": gsod_id, "name": best["name"], "country": t["country"], "latitude": best["lat"],
            "longitude": best["lon"], "begin": best["begin"], "end": best["end"], "targets": []})
        entry["targets"].append({"station_id": t["station_id"], "place": t["place"], "region": t.get("region"),
                                 "share_of_country_pct": t.get("share_of_country_pct"), "distance_km": round(distance, 1),
                                 "proximity": "NEAR" if distance <= NEAR_KM else "FAR"})
    for entry in stations.values():
        shares = [x["share_of_country_pct"] for x in entry["targets"] if x["share_of_country_pct"] is not None]
        entry["represented_share_pct"] = round(sum(shares), 2) if shares else None
        entry["proximity"] = "NEAR" if any(x["proximity"] == "NEAR" for x in entry["targets"]) else "FAR"
    ordered = sorted(stations.values(), key=lambda s: (list(FIPS).index(s["country"]), -(s["represented_share_pct"] or 0), s["name"]))
    return ordered, unmatched


# ---------- GSOD 解析 ----------

def _num(text):
    try:
        return float(str(text).strip())
    except (TypeError, ValueError):
        return None


def f_to_c(value):
    return None if value is None or value >= 9999 else round((value - 32) * 5 / 9, 1)


def parse_gsod_csv(text):
    """GSOD CSV → {date: {prcp_mm, prcp_flag, tmean_c, tmax_c, tmin_c}}。缺测为 None。"""
    out = {}
    for row in csv.DictReader(io.StringIO(text)):
        day = (row.get("DATE") or "").strip()
        if len(day) != 10:
            continue
        prcp = _num(row.get("PRCP"))
        flag = (row.get("PRCP_ATTRIBUTES") or "").strip()
        prcp_mm = None if prcp is None or prcp >= 99.99 or flag == "I" else round(prcp * 25.4, 1)
        out[day] = {
            "prcp_mm": prcp_mm,
            "prcp_flag": flag or None,
            "tmean_c": f_to_c(_num(row.get("TEMP"))),
            "tmax_c": f_to_c(_num(row.get("MAX"))),
            "tmin_c": f_to_c(_num(row.get("MIN"))),
        }
    return out


def year_arrays(daily, year):
    """按一年的日序展开为数组（含2月29日；缺日为 None）。"""
    start = date(year, 1, 1)
    n = (date(year + 1, 1, 1) - start).days
    days = [(start + timedelta(days=i)).isoformat() for i in range(n)]
    pick = lambda key: [(daily.get(d) or {}).get(key) for d in days]
    prcp = pick("prcp_mm")
    flags = [(daily.get(d) or {}).get("prcp_flag") for d in days]
    reported = sum(v is not None for v in prcp)
    return {
        "year": year, "start": start.isoformat(), "days": n,
        "prcp_mm": prcp, "tmean_c": pick("tmean_c"), "tmax_c": pick("tmax_c"), "tmin_c": pick("tmin_c"),
        "prcp_reported_days": reported,
        "prcp_partial_days": sum(1 for v, f in zip(prcp, flags) if v is not None and f in PARTIAL_PRCP_FLAGS),
        "last_date": max((d for d in days if d in daily), default=None),
    }


def _write(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        handle.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
        temporary = Path(handle.name)
    os.replace(temporary, path)


def update_archive(stations, today, fetch=http_get, archive_dir=ARCHIVE_DIR):
    """往年缺失才下载；当年每次重下。返回 {gsod_id: {year: arrays}}。"""
    result = {}
    for st in stations:
        sid = st["gsod_id"]
        result[sid] = {}
        for year in range(FIRST_YEAR, today.year + 1):
            path = archive_dir / sid / f"{year}.json"
            if year < today.year and path.exists():
                cached = json.loads(path.read_text(encoding="utf-8"))
                if not cached.get("missing"):
                    result[sid][year] = cached
                continue
            text = fetch(GSOD_URL.format(year=year, station=sid))
            if text is None:  # 该年无文件；往年记下缺失标记，避免每次重复请求
                if year < today.year:
                    _write(path, {"year": year, "missing": True})
                continue
            arrays = year_arrays(parse_gsod_csv(text), year)
            _write(path, arrays)
            result[sid][year] = arrays
    return result


def build_site_files(stations, unmatched, archive, today, thai_coverage, site_dir=SITE_DIR):
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    meta = []
    for st in stations:
        years = archive.get(st["gsod_id"], {})
        cur = years.get(today.year) or {}
        meta.append({**{k: st[k] for k in ("gsod_id", "name", "country", "latitude", "longitude", "targets",
                                            "represented_share_pct", "proximity")},
                     "years": sorted(years), "last_date": cur.get("last_date"),
                     "current_prcp_reported_days": cur.get("prcp_reported_days"),
                     "current_prcp_partial_days": cur.get("prcp_partial_days"),
                     "quality_status": "PASS" if cur.get("last_date") and cur["last_date"] >= (today - timedelta(days=7)).isoformat()
                     else ("WARNING" if years else "MISSING")})
    keep = ("start", "days", "prcp_mm", "tmean_c", "tmax_c", "tmin_c", "prcp_reported_days", "prcp_partial_days")
    history = {sid: {str(y): {k: v[k] for k in keep} for y, v in ys.items() if y < today.year} for sid, ys in archive.items()}
    current = {sid: {k: ys[today.year][k] for k in keep + ("last_date",)} for sid, ys in archive.items() if today.year in ys}
    header = {"schema_version": 1, "generated_at_utc": now, "source": SOURCE, "first_year": FIRST_YEAR,
              "units": {"prcp": "mm", "temperature": "℃"},
              "selection": {"thailand_coverage_pct": thai_coverage, "near_km": NEAR_KM, "max_km": MAX_KM,
                            "rule": "泰国按府产量从高到低累计至≥70%，印尼全部已加权省，越南/中国/科特迪瓦全部代表点；每个目标取2015年前开始观测且近400天仍有记录的最近站，≤75km为NEAR，75–120km为FAR，>120km不选。"},
              "stations": meta, "unmatched": unmatched}
    _write(site_dir / "current.json", {**header, "data": current})
    hist_path = site_dir / "history.json"
    old = json.loads(hist_path.read_text(encoding="utf-8")) if hist_path.exists() else {}
    # 往年数据只在内容变化（新年度、新站）时改写，避免每天重写大文件
    if old.get("data") != history:
        _write(hist_path, {"schema_version": 1, "generated_at_utc": now, "source": SOURCE, "data": history})
    return meta


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--reselect", action="store_true", help="按当前代表点与权重重新选站")
    args = parser.parse_args(argv)
    today = datetime.now(timezone.utc).date()
    config = json.loads((ROOT / "config" / "locations.json").read_text(encoding="utf-8"))
    weights = json.loads((ROOT / "site" / "data" / "production-weights.json").read_text(encoding="utf-8")).get("stations") or {}
    targets, thai_coverage = select_targets(config["locations"], weights)
    if STATION_CONFIG.exists() and not args.reselect:
        saved = json.loads(STATION_CONFIG.read_text(encoding="utf-8"))
        stations, unmatched = saved["stations"], saved.get("unmatched", [])
    else:
        text = http_get(ISD_HISTORY_URL, timeout=120)
        if not text:
            raise RuntimeError("无法下载 isd-history.csv")
        stations, unmatched = choose_stations(targets, parse_isd_history(text), today)
        _write(STATION_CONFIG, {"schema_version": 1, "selected_at": today.isoformat(), "thailand_coverage_pct": thai_coverage,
                                "stations": stations, "unmatched": unmatched})
        STATION_CONFIG.write_text(json.dumps(json.loads(STATION_CONFIG.read_text(encoding="utf-8")), ensure_ascii=False, indent=1) + "\n",
                                  encoding="utf-8")
    archive = update_archive(stations, today)
    meta = build_site_files(stations, unmatched, archive, today, thai_coverage)
    status = {s["quality_status"] for s in meta}
    print(f"station obs: {len(meta)} stations, unmatched {len(unmatched)}, status {sorted(status)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
