#!/usr/bin/env python3
"""气象站逐日实测：按产量权重选站，下载 NOAA NCEI GHCNh（全球小时观测），汇总为逐日值供网页使用。

为什么用 GHCNh：NOAA 已于 2025-08 停止更新 GSOD/ISD，GHCNh 是官方接替产品，每天更新。
  站点清单 https://www.ncei.noaa.gov/oa/global-historical-climatology-network/hourly/doc/ghcnh-station-list.txt
  观测量清单 https://www.ncei.noaa.gov/oa/global-historical-climatology-network/hourly/doc/ghcnh-inventory.txt
  数据 https://www.ncei.noaa.gov/oa/global-historical-climatology-network/hourly/access/by-year/<年>/psv/GHCNh_<站号>_<年>.psv

选站规则（第一次运行或 --reselect 时执行，结果固定写入 data/stations/selection.json）：
  - 泰国：按府产量占比从高到低，直到累计覆盖全国 ≥70%；
  - 印尼：全部已加权的省；越南、中国、科特迪瓦：全部代表点；
  - 每个目标取 2015 年已有观测、近 3 个月仍在报的最近站点（同址多个站号时取观测量多的），
    ≤75 km 为正常，75–120 km 标记 FAR，>120 km 不选；多个目标共用一个站时合并。

逐日汇总（UTC 日，若该站24小时降水固定在某个时次上报，则按该时次截止）：
  降水：用各时次上报的 1/3/6/12/24 小时累计量拼满 24 小时（优先长时段，互不重叠）；
        拼满 24 小时为完整值，拼到 12–23 小时记为“部分时段”（P），不足 12 小时为缺测；微量（T）记 0。
  气温：当日逐时气温 ≥4 次时取平均、最高、最低；不足为缺测。
输出：
  data/stations/ghcnh/<站号>/<年>.json   每站每年逐日数据（往年写入后不再改写；当年每次更新覆盖）
  site/data/stations/history.json        各站往年逐日数据（只在往年内容变化时改写）
  site/data/stations/current.json        各站当年逐日数据与站点信息（每天更新）
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
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GHCNH = "https://www.ncei.noaa.gov/oa/global-historical-climatology-network/hourly"
STATION_LIST_URL = f"{GHCNH}/doc/ghcnh-station-list.txt"
INVENTORY_URL = f"{GHCNH}/doc/ghcnh-inventory.txt"
DATA_URL = GHCNH + "/access/by-year/{year}/psv/GHCNh_{station}_{year}.psv"
STATION_CONFIG = ROOT / "data" / "stations" / "selection.json"
ARCHIVE_DIR = ROOT / "data" / "stations" / "ghcnh"
SITE_DIR = ROOT / "site" / "data" / "stations"
FIRST_YEAR = 2016
FIPS = {"泰国": "TH", "印度尼西亚": "ID", "越南": "VM", "中国": "CH", "科特迪瓦": "IV"}
THAILAND_COVERAGE_PCT = 70.0
NEAR_KM, MAX_KM = 75.0, 120.0
SAME_SITE_KM = 5.0
MIN_OBS_FIRST_YEAR = 1000   # 2015 年观测条数下限（每天约 3 次以上）
MIN_OBS_RECENT = 270        # 最近 3 个月观测条数下限
ACCUM_HOURS = (24, 21, 18, 15, 12, 9, 6, 3, 1)
PRCP_SANITY_MM = {1: 200, 3: 300, 6: 400, 9: 450, 12: 500, 15: 550, 18: 600, 21: 650, 24: 700}
BACKFILL_SECONDS = 20 * 60  # 单次运行回填往年的时间上限；剩余的下次继续
SOURCE = {
    "source_name": "NOAA NCEI Global Historical Climatology Network - hourly (GHCNh)",
    "documentation": "https://www.ncei.noaa.gov/products/global-historical-climatology-network-hourly",
    "data_nature": "地面气象站逐时/定时观测（含GTS上报的SYNOP、METAR），本面板按固定规则汇总为逐日值；是站点实测，部分时段缺报时降水可能偏少",
    "access": "NOAA NCEI 公开数据，无需密钥",
}


def km(lat1, lon1, lat2, lon2):
    p = math.pi / 180
    a = math.sin((lat2 - lat1) * p / 2) ** 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(a))


def http_get(url, timeout=120, retries=3):
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


def parse_station_list(text):
    """ghcnh-station-list.txt 定宽格式：ID 1-11, LAT 13-20, LON 22-30, 名称 42-71, WMO 81-。"""
    rows = []
    for line in text.splitlines():
        if len(line) < 40:
            continue
        sid = line[0:11].strip()
        try:
            lat, lon = float(line[12:20]), float(line[21:30])
        except ValueError:
            continue
        if not sid or lat < -90 or lat > 90 or (lat == 0 and lon == 0):
            continue
        rows.append({"id": sid, "ctry": sid[:2], "lat": lat, "lon": lon, "name": line[41:71].strip(),
                     "wmo": line[80:].strip() or None})
    return rows


MONTHS = ("JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC")


def parse_inventory(text):
    """ghcnh-inventory.txt：每行 站号 年份 1–12月观测条数（首行为表头）→ {id: {year: [12个月]}}。"""
    out = defaultdict(dict)
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 14 or not parts[1].isdigit():
            continue
        try:
            out[parts[0]][int(parts[1])] = [int(x) for x in parts[2:14]]
        except ValueError:
            continue
    return dict(out)


def recent_count(months_by_year, today):
    """最近 3 个完整月的观测条数（上月往前数 3 个月）。"""
    total = 0
    y, m = today.year, today.month
    for _ in range(3):
        m -= 1
        if m == 0:
            y, m = y - 1, 12
        total += (months_by_year.get(y) or [0] * 12)[m - 1]
    return total


def choose_stations(targets, station_rows, inventory, today=None):
    today = today or datetime.now(timezone.utc).date()
    candidates = []
    for r in station_rows:
        inv = inventory.get(r["id"])
        if not inv or "AGROMET" in r["name"].upper():
            continue
        if sum(inv.get(FIRST_YEAR - 1) or []) < MIN_OBS_FIRST_YEAR:
            continue
        recent = recent_count(inv, today)
        if recent < MIN_OBS_RECENT:
            continue
        candidates.append({**r, "recent_obs": recent})
    stations = {}
    unmatched = []
    for t in targets:
        pool = [r for r in candidates if r["ctry"] == FIPS[t["country"]]]
        ranked = sorted(pool, key=lambda r: km(t["latitude"], t["longitude"], r["lat"], r["lon"]))
        best = None
        if ranked:
            d0 = km(t["latitude"], t["longitude"], ranked[0]["lat"], ranked[0]["lon"])
            # 同一地点常有 WMO 与 ICAO 两个站号，取观测更多的那个
            close = [r for r in ranked if km(t["latitude"], t["longitude"], r["lat"], r["lon"]) <= d0 + SAME_SITE_KM]
            best = max(close, key=lambda r: r["recent_obs"])
        distance = km(t["latitude"], t["longitude"], best["lat"], best["lon"]) if best else None
        if best is None or distance > MAX_KM:
            unmatched.append({"station_id": t["station_id"], "place": t["place"], "country": t["country"],
                              "nearest_km": round(distance) if distance else None})
            continue
        entry = stations.setdefault(best["id"], {
            "station_code": best["id"], "name": best["name"], "wmo_id": best["wmo"], "country": t["country"],
            "latitude": best["lat"], "longitude": best["lon"], "targets": []})
        entry["targets"].append({"station_id": t["station_id"], "place": t["place"], "region": t.get("region"),
                                 "share_of_country_pct": t.get("share_of_country_pct"), "distance_km": round(distance, 1),
                                 "proximity": "NEAR" if distance <= NEAR_KM else "FAR"})
    for entry in stations.values():
        shares = [x["share_of_country_pct"] for x in entry["targets"] if x["share_of_country_pct"] is not None]
        entry["represented_share_pct"] = round(sum(shares), 2) if shares else None
        entry["proximity"] = "NEAR" if any(x["proximity"] == "NEAR" for x in entry["targets"]) else "FAR"
    ordered = sorted(stations.values(), key=lambda s: (list(FIPS).index(s["country"]), -(s["represented_share_pct"] or 0), s["name"]))
    return ordered, unmatched


# ---------- GHCNh 解析与逐日汇总 ----------

def _num(text):
    text = (text or "").strip()
    if text.upper() == "T":
        return 0.0
    try:
        value = float(text)
    except ValueError:
        return None
    return value if math.isfinite(value) else None


def _obs_time(row, idx):
    if "date" in idx:
        raw = row[idx["date"]].strip().replace("Z", "")
        try:
            t = datetime.fromisoformat(raw[:19])
        except ValueError:
            return None
    else:
        try:
            t = datetime(int(row[idx["year"]]), int(row[idx["month"]]), int(row[idx["day"]]),
                         int(row[idx["hour"]]), int(float(row[idx["minute"]] or 0)) if "minute" in idx else 0)
        except (KeyError, ValueError, IndexError):
            return None
    # 取最近整点（METAR 常在 :30/:50 报）
    return (t + timedelta(minutes=30)).replace(minute=0, second=0, microsecond=0)


def parse_ghcnh_psv(text):
    """GHCNh psv → (temps {整点: ℃}, accums {(截止整点, 小时数): mm})。同一时次多个来源取第一个有效值。"""
    reader = csv.reader(io.StringIO(text), delimiter="|")
    header = next(reader, None)
    if not header:
        return {}, {}
    idx = {name.strip().lower(): i for i, name in enumerate(header)}
    prcp_cols = {}
    for n in ACCUM_HOURS:
        col = "precipitation" if n == 1 else f"precipitation_{n}_hour"
        if col in idx:
            prcp_cols[n] = idx[col]
    t_col = idx.get("temperature")
    temps, accums = {}, {}
    for row in reader:
        if len(row) < len(header) // 2:
            continue
        t = _obs_time(row, idx)
        if t is None:
            continue
        if t_col is not None and t not in temps:
            v = _num(row[t_col])
            if v is not None and -40 <= v <= 60:
                temps[t] = v
        for n, col in prcp_cols.items():
            if (t, n) in accums:
                continue
            v = _num(row[col])
            if v is not None and 0 <= v <= PRCP_SANITY_MM[n]:
                accums[(t, n)] = v
    return temps, accums


def day_cutoff_hour(accums):
    """若站点固定在某时次上报24小时降水，逐日按该时次截止；否则按 UTC 0 时。返回相对 UTC 0 时的偏移小时。"""
    hours = Counter(t.hour for (t, n) in accums if n == 24)
    if not hours:
        return 0
    h = hours.most_common(1)[0][0]
    return h if h <= 12 else h - 24


def daily_from_obs(temps, accums, year):
    """→ {日期: {prcp_mm, prcp_flag, tmean_c, tmax_c, tmin_c}}，prcp_flag 'P' 表示只拼到部分时段。"""
    offset = day_cutoff_hour(accums)
    by_end = defaultdict(list)
    for (t, n), v in accums.items():
        by_end[t].append((n, v))
    temps_by_day = defaultdict(list)
    for t, v in temps.items():
        temps_by_day[t.date()].append(v)
    out = {}
    d = date(year, 1, 1)
    while d.year == year:
        w1 = datetime(d.year, d.month, d.day) + timedelta(days=1, hours=offset)
        w0 = w1 - timedelta(hours=24)
        pieces = []
        for k in range(1, 25):
            for n, v in by_end.get(w0 + timedelta(hours=k), ()):
                if k - n >= 0:
                    pieces.append((n, k, v))
        covered = set()
        total = 0.0
        for n, k, v in sorted(pieces, key=lambda p: (-p[0], p[1])):
            span = set(range(k - n + 1, k + 1))
            if span & covered:
                continue
            covered |= span
            total += v
        if len(covered) >= 24:
            prcp, flag = round(total, 1), None
        elif len(covered) >= 12:
            prcp, flag = round(total, 1), "P"
        else:
            prcp, flag = None, None
        tv = temps_by_day.get(d, [])
        rec = {"prcp_mm": prcp, "prcp_flag": flag,
               "tmean_c": round(sum(tv) / len(tv), 1) if len(tv) >= 4 else None,
               "tmax_c": round(max(tv), 1) if len(tv) >= 4 else None,
               "tmin_c": round(min(tv), 1) if len(tv) >= 4 else None}
        if prcp is not None or tv:
            out[d.isoformat()] = rec
        d += timedelta(days=1)
    return out


def year_arrays(daily, year):
    """按一年的日序展开为数组（含2月29日；缺日为 None）。"""
    start = date(year, 1, 1)
    n = (date(year + 1, 1, 1) - start).days
    days = [(start + timedelta(days=i)).isoformat() for i in range(n)]
    pick = lambda key: [(daily.get(d) or {}).get(key) for d in days]
    prcp = pick("prcp_mm")
    flags = [(daily.get(d) or {}).get("prcp_flag") for d in days]
    return {
        "year": year, "start": start.isoformat(), "days": n,
        "prcp_mm": prcp, "tmean_c": pick("tmean_c"), "tmax_c": pick("tmax_c"), "tmin_c": pick("tmin_c"),
        "prcp_reported_days": sum(v is not None for v in prcp),
        "prcp_partial_days": sum(1 for v, f in zip(prcp, flags) if v is not None and f == "P"),
        "last_date": max((d for d in days if d in daily), default=None),
    }


def _write(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        handle.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
        temporary = Path(handle.name)
    os.replace(temporary, path)


def _write_text(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text + "\n", encoding="utf-8")


def update_archive(stations, today, fetch=http_get, archive_dir=ARCHIVE_DIR, budget_seconds=BACKFILL_SECONDS, clock=time.monotonic):
    """先更新各站当年，再由近及远回填往年（往年写入后不再下载；单次运行超过时间上限则留到下次）。
    返回 ({站号: {年: arrays}}, 本次未完成回填的站年数)。"""
    result = {st["station_code"]: {} for st in stations}
    jobs = [(st["station_code"], today.year) for st in stations]
    jobs += [(st["station_code"], y) for y in range(today.year - 1, FIRST_YEAR - 1, -1) for st in stations]
    started = clock()
    pending = 0
    for sid, year in jobs:
        path = archive_dir / sid / f"{year}.json"
        if year < today.year and path.exists():
            cached = json.loads(path.read_text(encoding="utf-8"))
            # 去年作为“当年”写入的文件不完整（缺12月底），跨年后重下一次并标记为终版
            if cached.get("final") or cached.get("missing"):
                if not cached.get("missing"):
                    result[sid][year] = cached
                continue
        if year < today.year and clock() - started > budget_seconds:
            pending += 1
            continue
        try:
            text = fetch(DATA_URL.format(year=year, station=sid))
        except Exception as exc:  # 单个文件失败不影响其他站
            print(f"  {sid} {year}: {exc}", file=sys.stderr)
            continue
        if text is None:  # 该年无文件；往年记下缺失标记，避免重复请求
            if year < today.year:
                _write(path, {"year": year, "missing": True})
            continue
        temps, accums = parse_ghcnh_psv(text)
        if year == today.year and not (archive_dir / "psv-header.txt").exists():
            _write_text(archive_dir / "psv-header.txt", text.splitlines()[0] if text else "")
        arrays = year_arrays(daily_from_obs(temps, accums, year), year)
        arrays["obs_counts"] = {"temperature": len(temps), **{f"prcp_{n}h": sum(1 for (_, k) in accums if k == n) for n in ACCUM_HOURS}}
        if year < today.year:
            arrays["final"] = True
        _write(path, arrays)
        result[sid][year] = arrays
    return result, pending


def build_site_files(stations, unmatched, archive, today, thai_coverage, site_dir=SITE_DIR, pending=0):
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    meta = []
    for st in stations:
        years = archive.get(st["station_code"], {})
        cur = years.get(today.year) or {}
        meta.append({**{k: st.get(k) for k in ("station_code", "name", "wmo_id", "country", "latitude", "longitude", "targets",
                                                "represented_share_pct", "proximity")},
                     "years": sorted(years), "last_date": cur.get("last_date"),
                     "current_prcp_reported_days": cur.get("prcp_reported_days"),
                     "current_prcp_partial_days": cur.get("prcp_partial_days"),
                     "current_obs_counts": cur.get("obs_counts"),
                     "quality_status": "PASS" if cur.get("last_date") and cur["last_date"] >= (today - timedelta(days=7)).isoformat()
                     else ("WARNING" if years else "MISSING")})
    keep = ("start", "days", "prcp_mm", "tmean_c", "tmax_c", "tmin_c", "prcp_reported_days", "prcp_partial_days")
    history = {sid: {str(y): {k: v[k] for k in keep} for y, v in ys.items() if y < today.year} for sid, ys in archive.items()}
    current = {sid: {k: ys[today.year][k] for k in keep + ("last_date",)} for sid, ys in archive.items() if today.year in ys}
    header = {"schema_version": 2, "generated_at_utc": now, "source": SOURCE, "first_year": FIRST_YEAR,
              "units": {"prcp": "mm", "temperature": "℃"}, "backfill_pending": pending,
              "selection": {"thailand_coverage_pct": thai_coverage, "near_km": NEAR_KM, "max_km": MAX_KM,
                            "rule": "泰国按府产量从高到低累计至≥70%，印尼全部已加权省，越南/中国/科特迪瓦全部代表点；每个目标取2015年已有观测、近3个月仍在报的最近站，≤75km为NEAR，75–120km为FAR，>120km不选。"},
              "daily_rule": "降水用各时次上报的1/3/6/12/24小时累计量拼满24小时（UTC日，若该站固定时次上报24小时量则按该时次截止）；拼到12–23小时记为部分时段，不足12小时为缺测。气温为当日逐时观测≥4次时的平均/最高/最低。",
              "stations": meta, "unmatched": unmatched}
    _write(site_dir / "current.json", {**header, "data": current})
    hist_path = site_dir / "history.json"
    old = json.loads(hist_path.read_text(encoding="utf-8")) if hist_path.exists() else {}
    # 往年数据只在内容变化（新年度、新站、回填）时改写，避免每天重写大文件
    if old.get("data") != history:
        _write(hist_path, {"schema_version": 2, "generated_at_utc": now, "source": SOURCE, "data": history})
    return meta


def select_and_save(targets, thai_coverage, today, fetch=http_get, config_path=STATION_CONFIG):
    station_text = fetch(STATION_LIST_URL)
    inventory_text = fetch(INVENTORY_URL)
    if not station_text or not inventory_text:
        raise RuntimeError("无法下载 GHCNh 站点清单或观测量清单")
    rows, inventory = parse_station_list(station_text), parse_inventory(inventory_text)
    stations, unmatched = choose_stations(targets, rows, inventory, today)
    print(f"station list {len(rows)} rows, inventory {len(inventory)} ids, selected {len(stations)}, unmatched {len(unmatched)}",
          file=sys.stderr)
    # 记录清单格式与解析结果，便于在仓库里直接排查（Actions 日志之外）
    _write(config_path.parent / "selection-diagnostics.json", {
        "checked_at": today.isoformat(), "station_list_rows": len(rows), "inventory_ids": len(inventory),
        "station_list_head": station_text.splitlines()[:5], "inventory_head": inventory_text.splitlines()[:5],
        "selected": len(stations), "unmatched": len(unmatched)})
    if not stations:
        raise RuntimeError("一个站点都没有选中，请检查 GHCNh 清单格式")
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps({"schema_version": 2, "source": "GHCNh", "selected_at": today.isoformat(),
                                       "thailand_coverage_pct": thai_coverage, "stations": stations, "unmatched": unmatched},
                                      ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return stations, unmatched


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--reselect", action="store_true", help="按当前代表点与权重重新选站")
    args = parser.parse_args(argv)
    today = datetime.now(timezone.utc).date()
    config = json.loads((ROOT / "config" / "locations.json").read_text(encoding="utf-8"))
    weights = json.loads((ROOT / "site" / "data" / "production-weights.json").read_text(encoding="utf-8")).get("stations") or {}
    targets, thai_coverage = select_targets(config["locations"], weights)
    saved = json.loads(STATION_CONFIG.read_text(encoding="utf-8")) if STATION_CONFIG.exists() else {}
    if saved.get("stations") and not args.reselect:
        stations, unmatched = saved["stations"], saved.get("unmatched", [])
    else:
        stations, unmatched = select_and_save(targets, thai_coverage, today)
    archive, pending = update_archive(stations, today)
    meta = build_site_files(stations, unmatched, archive, today, thai_coverage, pending=pending)
    status = Counter(s["quality_status"] for s in meta)
    print(f"station obs: {len(meta)} stations, unmatched {len(unmatched)}, status {dict(status)}, backfill pending {pending}",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
