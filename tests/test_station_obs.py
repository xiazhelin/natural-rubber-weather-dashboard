import csv
import importlib.util
import json
import tempfile
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("station_obs", ROOT / "scripts" / "update_station_obs.py")
OBS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(OBS)
FIX = ROOT / "tests" / "fixtures"


def ghcnh_lists_from_isd_sample():
    """用 ISD 名录样本（真实坐标）构造 GHCNh 站点清单（定宽）与观测量清单。"""
    lines, inv = [], ["GHCNh_ID    YEAR   JAN   FEB   MAR   APR   MAY   JUN   JUL   AUG   SEP   OCT   NOV   DEC"]
    with open(FIX / "isd-history-sample.csv", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            try:
                lat, lon, begin, end = float(row["LAT"]), float(row["LON"]), int(row["BEGIN"]), int(row["END"])
            except ValueError:
                continue
            sid = f"{row['CTRY']}M000{row['USAF'][:5]}"
            lines.append(f"{sid:<11} {lat:8.4f} {lon:9.4f} {0:6.1f} {'':2} {row['STATION NAME'][:30]:<30} {'':3} {'':3} {row['USAF'][:5]}")
            if begin <= 20150101:
                inv.append(f"{sid} 2015 " + " ".join(["240"] * 12))
            if end >= 20250801:  # ISD 冻结前仍在报 → 视为至今仍在报
                inv.append(f"{sid} 2026 " + " ".join(["240"] * 10 + ["0", "0"]))
    # 宋卡同址的 ICAO 站号，观测更多 → 应优先
    lines.append(f"{'THI0000VTSH':<11} {7.1866:8.4f} {100.6080:9.4f} {0:6.1f} {'':2} {'SONGKHLA AIRPORT':<30}")
    inv.append("THI0000VTSH 2015 " + " ".join(["700"] * 12))
    inv.append("THI0000VTSH 2026 " + " ".join(["700"] * 10 + ["0", "0"]))
    return "\n".join(lines), "\n".join(inv)


def psv(rows):
    header = ["STATION", "Station_name", "DATE", "Year", "Month", "Day", "Hour", "Minute", "Latitude", "Longitude",
              "temperature", "temperature_Quality_Code", "pres_wx_MW1", "pres_wx_AU1", "precipitation", "precipitation_3_hour",
              "precipitation_6_hour", "precipitation_12_hour", "precipitation_24_hour"]
    out = ["|".join(header)]
    for r in rows:
        t = r["t"]
        vals = {"STATION": "X", "Station_name": "X", "DATE": t.strftime("%Y-%m-%dT%H:%M:%S"), "Year": t.year, "Month": t.month, "Day": t.day, "Hour": t.hour,
                "Minute": t.minute, "Latitude": 7, "Longitude": 100, **{k: v for k, v in r.items() if k != "t"}}
        out.append("|".join(str(vals.get(h, "")) for h in header))
    return "\n".join(out) + "\n"


class StationSelectionTest(unittest.TestCase):
    def setUp(self):
        self.locations = json.loads((ROOT / "config" / "locations.json").read_text(encoding="utf-8"))["locations"]
        self.weights = json.loads((ROOT / "site" / "data" / "production-weights.json").read_text(encoding="utf-8"))["stations"]

    def test_targets_follow_production_weight(self):
        targets, covered = OBS.select_targets(self.locations, self.weights)
        thai = [t for t in targets if t["country"] == "泰国"]
        self.assertGreaterEqual(covered, 70)
        self.assertLess(covered - thai[-1]["share_of_country_pct"], 70)  # 刚好跨过70%即停止
        shares = [t["share_of_country_pct"] for t in thai]
        self.assertEqual(shares, sorted(shares, reverse=True))
        self.assertEqual(thai[0]["place"], "素叻他尼")
        self.assertTrue(all(t["share_of_country_pct"] for t in targets if t["country"] == "印度尼西亚"))
        self.assertEqual(sum(t["country"] == "越南" for t in targets), 4)

    def test_choose_nearest_active_station(self):
        targets, _ = OBS.select_targets(self.locations, self.weights)
        station_text, inv_text = ghcnh_lists_from_isd_sample()
        rows, inventory = OBS.parse_station_list(station_text), OBS.parse_inventory(inv_text)
        self.assertEqual(inventory["THI0000VTSH"][2026][0], 700)
        stations, unmatched = OBS.choose_stations(targets, rows, inventory, today=date(2026, 11, 2))
        by_target = {t["station_id"]: (s["name"], s, t) for s in stations for t in s["targets"]}
        self.assertEqual(by_target["th_south_songkhla"][1]["station_code"], "THI0000VTSH")  # 同址取观测多的站号
        self.assertEqual(by_target["id_sumatra_palembang"][0].split(" ")[0], "SULTAN")
        self.assertEqual(by_target["cn_yunnan_jinghong"][0], "JINGHONG")
        self.assertEqual(by_target["cn_yunnan_jinghong"][1]["wmo_id"], "56959")
        self.assertEqual(by_target["th_northeast_bueng_kan"][2]["proximity"], "FAR")   # 最近站约110 km
        ids = [s["station_code"] for s in stations]
        self.assertEqual(len(ids), len(set(ids)))  # 共用站点已合并
        danxian = next(s for s in stations if s["name"] == "DANXIAN")
        self.assertGreaterEqual(len(danxian["targets"]), 2)
        self.assertTrue(all(u["country"] == "科特迪瓦" for u in unmatched))  # 样本无科特迪瓦站 → 不硬配
        # 近期活跃以清单自身的截止月为准（清单可能滞后），截止月前3个月没有观测的站不选
        self.assertEqual(OBS.inventory_end(inventory), (2026, 10))
        for sid in ("THI0000VTSH", "THM00048568"):
            inventory[sid].pop(2026)
        stations = OBS.choose_stations(targets, rows, inventory, today=date(2027, 6, 1))[0]
        songkhla = next(s for s in stations for t in s["targets"] if t["station_id"] == "th_south_songkhla")
        self.assertNotIn(songkhla["station_code"], ("THI0000VTSH", "THM00048568"))

    def test_scorer_prefers_station_reporting_precipitation(self):
        targets, _ = OBS.select_targets(self.locations, self.weights)
        station_text, inv_text = ghcnh_lists_from_isd_sample()
        rows, inventory = OBS.parse_station_list(station_text), OBS.parse_inventory(inv_text)
        # 机场站号观测多但不报降水，同址 WMO 站号报降水 → 取 WMO 站号
        scores = {"THI0000VTSH": 0, "THM00048568": 300}
        stations, _ = OBS.choose_stations(targets, rows, inventory, date(2026, 11, 2), scorer=lambda sid: scores.get(sid, 100))
        songkhla = next(s for s in stations for t in s["targets"] if t["station_id"] == "th_south_songkhla")
        self.assertEqual(songkhla["station_code"], "THM00048568")
        self.assertEqual(songkhla["prcp_days_checked"], 300)


class DailyAggregationTest(unittest.TestCase):
    def test_24h_6h_partial_and_temperature(self):
        d = datetime(2026, 3, 1)
        rows = []
        # 3月1日：次日00Z报24小时量 12.4（另有6小时量，不应重复计入）
        rows.append({"t": d + timedelta(days=1), "precipitation_24_hour": "12.4", "precipitation_6_hour": "3.0", "temperature": "25.0"})
        rows.append({"t": d + timedelta(hours=6), "precipitation_6_hour": "4.0", "temperature": "30.0"})
        rows.append({"t": d + timedelta(hours=12), "precipitation_6_hour": "5.4", "temperature": "29.0"})
        rows.append({"t": d + timedelta(hours=18), "precipitation_6_hour": "0", "temperature": "27.0"})
        rows.append({"t": d, "temperature": "24.0"})
        # 3月2日：只有 06/12/18Z 三个6小时量 → 18小时，部分时段；含微量 T
        d2 = d + timedelta(days=1)
        for h, v in ((6, "1.0"), (12, "T"), (18, "2.0")):
            rows.append({"t": d2 + timedelta(hours=h), "precipitation_6_hour": v})
        # 3月3日：只有一个6小时量 → 缺测
        rows.append({"t": d + timedelta(days=2, hours=6), "precipitation_6_hour": "9.0"})
        # 3月4日：METAR 在 :50 报的逐时量，凑满24小时
        for h in range(24):
            rows.append({"t": d + timedelta(days=3, hours=h, minutes=50), "precipitation": "0.5"})
        temps, accums, info = OBS.parse_ghcnh_psv(psv(rows))
        daily = OBS.daily_from_obs(temps, accums, 2026)
        self.assertEqual(daily["2026-03-01"]["prcp_mm"], 12.4)
        self.assertIsNone(daily["2026-03-01"]["prcp_flag"])
        self.assertEqual(daily["2026-03-01"]["tmean_c"], 27.5)   # 24/30/29/27
        self.assertEqual(daily["2026-03-01"]["tmax_c"], 30.0)
        self.assertEqual(daily["2026-03-02"]["prcp_mm"], 3.0)
        self.assertEqual(daily["2026-03-02"]["prcp_flag"], "P")
        self.assertIsNone(daily["2026-03-02"]["tmean_c"])        # 气温不足4次
        self.assertNotIn("2026-03-03", {k for k, v in daily.items() if v["prcp_mm"] is not None})
        self.assertEqual(daily["2026-03-04"]["prcp_mm"], 12.0)
        arrays = OBS.year_arrays(daily, 2026)
        self.assertEqual(arrays["days"], 365)
        self.assertEqual(arrays["prcp_reported_days"], 3)
        self.assertEqual(arrays["prcp_partial_days"], 1)
        self.assertIsNone(arrays["prcp_mm"][100])                # 缺日不补0

    def test_station_with_12z_climatological_day(self):
        d = datetime(2026, 5, 1, 12)
        rows = [{"t": d + timedelta(days=i), "precipitation_24_hour": str(i + 1)} for i in range(3)]
        temps, accums, info = OBS.parse_ghcnh_psv(psv(rows))
        daily = OBS.daily_from_obs(temps, accums, 2026, info)
        # 12Z 上报的24小时量（覆盖前一日12Z至当日12Z）记在前一日
        self.assertEqual(daily["2026-04-30"]["prcp_mm"], 1.0)
        self.assertEqual(daily["2026-05-02"]["prcp_mm"], 3.0)


    def test_inferred_dry_day_and_shifted_24h(self):
        d = datetime(2026, 2, 1)
        rows = [{"t": d + timedelta(days=1), "precipitation_24_hour": "5.0", "temperature": "26"}]   # 2月1日有降水量
        for h in (0, 3, 6, 9, 12, 15, 18, 21):  # 2月2日：正常观测、无降水组、无降水现象 → 按0计
            rows.append({"t": d + timedelta(days=1, hours=h + 1), "temperature": "27"})
        for h in (3, 9, 15):                    # 2月3日：有观测但现在天气报阵雨（ww=80）→ 仍为缺测
            rows.append({"t": d + timedelta(days=2, hours=h), "temperature": "25", "pres_wx_MW1": "80:1"})
        for h in (6, 12, 18):                   # 2月4日：METAR 文本报 -RA → 缺测
            rows.append({"t": d + timedelta(days=3, hours=h), "temperature": "25", "pres_wx_AU1": "-RA"})
        rows.append({"t": d + timedelta(days=5, hours=2), "precipitation_24_hour": "7.5"})    # 2月5日：00Z 缺报，02Z 报24小时量
        rows.append({"t": d + timedelta(days=1, hours=0), "precipitation_24_hour": "5.0"})
        temps, accums, info = OBS.parse_ghcnh_psv(psv(rows))
        daily = OBS.daily_from_obs(temps, accums, 2026, info)
        self.assertEqual(daily["2026-02-01"]["prcp_mm"], 5.0)
        self.assertEqual((daily["2026-02-02"]["prcp_mm"], daily["2026-02-02"]["prcp_flag"]), (0.0, "Z"))
        self.assertIsNone(daily["2026-02-03"]["prcp_mm"])
        self.assertIsNone(daily["2026-02-04"]["prcp_mm"])
        self.assertEqual(daily["2026-02-05"]["prcp_mm"], 7.5)
        self.assertNotIn("2026-06-01", daily)                    # 远离任何降水报告、无观测的日子不推断
        arrays = OBS.year_arrays(daily, 2026)
        self.assertEqual(arrays["prcp_zero_inferred_days"], 1)

    def test_wet_weather_codes(self):
        self.assertTrue(OBS.is_wet_weather("pres_wx_mw1", "61:1"))
        self.assertTrue(OBS.is_wet_weather("pres_wx_mw1", "25"))
        self.assertFalse(OBS.is_wet_weather("pres_wx_mw1", "02:1"))
        self.assertFalse(OBS.is_wet_weather("pres_wx_mw1", "10"))
        self.assertTrue(OBS.is_wet_weather("pres_wx_aw1", "61"))
        self.assertFalse(OBS.is_wet_weather("pres_wx_aw1", "30"))
        self.assertTrue(OBS.is_wet_weather("pres_wx_au1", "TSRA"))
        self.assertFalse(OBS.is_wet_weather("pres_wx_au1", "HZ"))


class ArchiveTest(unittest.TestCase):
    def test_archive_backfill_budget_and_site_files(self):
        text = psv([{"t": datetime(2024, 1, 2), "precipitation_24_hour": "8.0"}])
        calls = []

        def fake_fetch(url, **_):
            calls.append(url)
            return text if "/2024/" in url else None

        stations = [{"station_code": "THM00048568", "name": "SONGKHLA", "country": "泰国", "latitude": 7.2, "longitude": 100.6,
                     "targets": [{"station_id": "th_south_songkhla", "place": "宋卡", "share_of_country_pct": 8.6,
                                  "distance_km": 2, "proximity": "NEAR"}], "represented_share_pct": 8.6, "proximity": "NEAR"}]
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            today = date(2025, 3, 1)
            # 时间预算为0：只下载当年，往年留到下次
            archive, pending = OBS.update_archive(stations, today, fetch=fake_fetch, archive_dir=d / "a", budget_seconds=-1)
            self.assertEqual(len(calls), 1)
            self.assertEqual(pending, 2025 - OBS.FIRST_YEAR)
            archive, pending = OBS.update_archive(stations, today, fetch=fake_fetch, archive_dir=d / "a")
            self.assertEqual(pending, 0)
            self.assertEqual(archive["THM00048568"][2024]["prcp_mm"][0], 8.0)
            n = len(calls)
            OBS.update_archive(stations, today, fetch=fake_fetch, archive_dir=d / "a")
            self.assertEqual(len(calls) - n, 1)  # 往年（含缺失年份）不再请求，只重下当年
            self.assertTrue(json.loads((d / "a" / "THM00048568" / "2016.json").read_text(encoding="utf-8"))["missing"])
            # 跨年：去年作为“当年”写的文件（无 final）会重下一次
            (d / "a" / "THM00048568" / "2025.json").write_text(json.dumps({"year": 2025, "prcp_mm": []}), encoding="utf-8")
            n = len(calls)
            OBS.update_archive(stations, date(2026, 1, 2), fetch=fake_fetch, archive_dir=d / "a")
            self.assertIn("/2025/", "".join(calls[n:]))
            meta = OBS.build_site_files(stations, [], archive, today, 71.1, site_dir=d / "site")
            hist = json.loads((d / "site" / "history.json").read_text(encoding="utf-8"))
            cur = json.loads((d / "site" / "current.json").read_text(encoding="utf-8"))
            self.assertIn("2024", hist["data"]["THM00048568"])
            self.assertEqual(cur["stations"][0]["station_code"], "THM00048568")
            self.assertEqual(meta[0]["quality_status"], "WARNING")  # 当年无数据
            mtime = (d / "site" / "history.json").stat().st_mtime_ns
            OBS.build_site_files(stations, [], archive, today, 71.1, site_dir=d / "site")
            self.assertEqual((d / "site" / "history.json").stat().st_mtime_ns, mtime)  # 往年不变则不改写

    def test_select_and_save_refuses_empty_selection(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(RuntimeError):
                OBS.select_and_save([], 0, date(2026, 11, 2), fetch=lambda url, **_: "x", config_path=Path(d) / "s.json")


if __name__ == "__main__":
    unittest.main()
