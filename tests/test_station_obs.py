import importlib.util
import json
import tempfile
import unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("station_obs", ROOT / "scripts" / "update_station_obs.py")
OBS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(OBS)
FIX = ROOT / "tests" / "fixtures"


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

    def test_choose_nearest_long_record_station(self):
        targets, _ = OBS.select_targets(self.locations, self.weights)
        rows = OBS.parse_isd_history((FIX / "isd-history-sample.csv").read_text(encoding="utf-8"))
        stations, unmatched = OBS.choose_stations(targets, rows, today=date(2025, 9, 1))
        by_target = {t["station_id"]: (s["name"], t) for s in stations for t in s["targets"]}
        self.assertEqual(by_target["th_south_songkhla"][0], "SONGKHLA")
        self.assertEqual(by_target["id_sumatra_palembang"][0].split(" ")[0], "SULTAN")
        self.assertEqual(by_target["cn_yunnan_jinghong"][0], "JINGHONG")
        self.assertEqual(by_target["th_northeast_bueng_kan"][1]["proximity"], "FAR")   # 最近站约110 km
        self.assertEqual(by_target["vn_southeast_binh_phuoc"][1]["proximity"], "FAR")
        ids = [s["gsod_id"] for s in stations]
        self.assertEqual(len(ids), len(set(ids)))  # 共用站点已合并
        danxian = next(s for s in stations if s["name"] == "DANXIAN")
        self.assertGreaterEqual(len(danxian["targets"]), 2)
        self.assertTrue(all(len(s["gsod_id"]) == 11 for s in stations))
        # 科特迪瓦不在样本名录中 → 记为未匹配，不硬配
        self.assertTrue(all(u["country"] == "科特迪瓦" for u in unmatched))
        self.assertEqual(len(unmatched), 3)


class GsodParseTest(unittest.TestCase):
    def test_units_missing_and_flags(self):
        daily = OBS.parse_gsod_csv((FIX / "gsod-sample.csv").read_text(encoding="utf-8"))
        d1 = daily["2024-01-01"]
        self.assertEqual(d1["prcp_mm"], 30.5)          # 1.20 in
        self.assertEqual(d1["tmean_c"], 27.0)          # 80.6 F
        self.assertEqual(d1["tmax_c"], 32.0)
        self.assertIsNone(daily["2024-01-02"]["prcp_mm"])   # 标记 I：无降水报告
        self.assertIsNone(daily["2024-01-02"]["tmax_c"])    # 9999.9
        self.assertIsNone(daily["2024-01-03"]["prcp_mm"])   # 99.99
        self.assertIsNone(daily["2024-01-03"]["tmean_c"])
        arrays = OBS.year_arrays(daily, 2024)
        self.assertEqual(arrays["days"], 366)
        self.assertEqual(arrays["prcp_mm"][59], 12.7)       # 2月29日
        self.assertEqual(arrays["prcp_reported_days"], 2)
        self.assertEqual(arrays["prcp_partial_days"], 1)    # 标记 B
        self.assertIsNone(arrays["prcp_mm"][100])           # 缺日不补0
        self.assertEqual(arrays["last_date"], "2024-02-29")

    def test_archive_reuses_past_years_and_builds_site_files(self):
        csv_text = (FIX / "gsod-sample.csv").read_text(encoding="utf-8")
        calls = []

        def fake_fetch(url, **_):
            calls.append(url)
            return csv_text if "/2024/" in url else None

        stations = [{"gsod_id": "48568099999", "name": "SONGKHLA", "country": "泰国", "latitude": 7.2, "longitude": 100.6,
                     "targets": [{"station_id": "th_south_songkhla", "place": "宋卡", "share_of_country_pct": 8.6,
                                  "distance_km": 2, "proximity": "NEAR"}], "represented_share_pct": 8.6, "proximity": "NEAR"}]
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            today = date(2025, 3, 1)
            archive = OBS.update_archive(stations, today, fetch=fake_fetch, archive_dir=d / "a")
            self.assertIn(2024, archive["48568099999"])
            n = len(calls)
            OBS.update_archive(stations, today, fetch=fake_fetch, archive_dir=d / "a")
            self.assertEqual(len(calls) - n, 1)  # 往年（含缺失年份）不再请求，只重下当年
            self.assertTrue(json.loads((d / "a" / "48568099999" / "2016.json").read_text(encoding="utf-8"))["missing"])
            meta = OBS.build_site_files(stations, [], archive, today, 71.1, site_dir=d / "site")
            hist = json.loads((d / "site" / "history.json").read_text(encoding="utf-8"))
            cur = json.loads((d / "site" / "current.json").read_text(encoding="utf-8"))
            self.assertIn("2024", hist["data"]["48568099999"])
            self.assertEqual(cur["stations"][0]["gsod_id"], "48568099999")
            self.assertEqual(meta[0]["quality_status"], "WARNING")  # 当年无数据
            mtime = (d / "site" / "history.json").stat().st_mtime_ns
            OBS.build_site_files(stations, [], archive, today, 71.1, site_dir=d / "site")
            self.assertEqual((d / "site" / "history.json").stat().st_mtime_ns, mtime)  # 往年不变则不改写


if __name__ == "__main__":
    unittest.main()
