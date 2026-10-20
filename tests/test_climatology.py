import importlib.util
import unittest
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CLIM = _load("build_climatology")
import sys as _sys
_sys.path.insert(0, str(ROOT / "scripts"))
BIAS = _load("build_model_bias")
WX = _load("update_weather")


def _daily(start, end, fn):
    out = {}
    day = start
    while day <= end:
        out[day.isoformat()] = fn(day)
        day += timedelta(days=1)
    return out


class ClimatologyTest(unittest.TestCase):
    def test_day_of_year_aligns_leap_years(self):
        self.assertEqual(CLIM.day_of_year(date(2024, 2, 28)), 59)
        self.assertEqual(CLIM.day_of_year(date(2024, 2, 29)), 59)
        self.assertEqual(CLIM.day_of_year(date(2024, 3, 1)), 60)
        self.assertEqual(CLIM.day_of_year(date(2025, 3, 1)), 60)
        self.assertEqual(CLIM.day_of_year(date(2024, 12, 31)), 365)
        for year in (2023, 2024):
            for doy in range(1, 366):
                self.assertEqual(CLIM.day_of_year(CLIM.date_from_doy(year, doy)), doy)

    def test_update_script_uses_same_day_index(self):
        day = date(2023, 12, 25)
        for _ in range(800):
            self.assertEqual(WX._clim_day_of_year(day), CLIM.day_of_year(day))
            day += timedelta(days=1)

    def test_constant_rain_gives_constant_stats(self):
        daily = _daily(date(2009, 12, 1), date(2013, 2, 1), lambda d: 2.0)
        table = CLIM.climatology_from_daily(daily, 2010, 2012, half_width=3, min_samples=10)
        self.assertEqual(table["7"][0], [14.0, 14.0, 14.0, 14.0, 14.0])
        self.assertEqual(table["30"][200], [60.0, 60.0, 60.0, 60.0, 60.0])
        self.assertEqual(len(table["14"]), 365)

    def test_seasonal_signal_and_missing_days(self):
        def rain(d):
            return 10.0 if d.month == 7 else 0.0
        daily = _daily(date(2009, 12, 1), date(2013, 2, 1), rain)
        daily["2011-07-15"] = None  # 缺失日：含它的窗口不计入，不补0
        table = CLIM.climatology_from_daily(daily, 2010, 2012, half_width=3, min_samples=10)
        july10 = CLIM.day_of_year(date(2011, 7, 10)) - 1
        jan10 = CLIM.day_of_year(date(2011, 1, 10)) - 1
        self.assertEqual(table["7"][july10][0], 70.0)
        self.assertEqual(table["7"][jan10][0], 0.0)

    def test_too_few_samples_is_empty(self):
        daily = _daily(date(2011, 1, 1), date(2011, 1, 31), lambda d: 1.0)
        table = CLIM.climatology_from_daily(daily, 2010, 2012, half_width=3)
        self.assertIsNone(table["7"][100])


class ClimateContextTest(unittest.TestCase):
    def _clim(self):
        row = [20.0, 5.0, 12.0, 25.0, 40.0]
        return {"windows": {"7": [row] * 365, "14": [[40.0, 10, 30, 50, 80]] * 365,
                            "30": [[100.0, 30, 70, 120, 180]] * 365}}

    def test_categories_and_anomaly(self):
        d0 = date(2026, 10, 20)
        dates = [(d0 + timedelta(days=i)).isoformat() for i in range(7)]
        past = {(d0 - timedelta(days=i)).isoformat(): 1.0 for i in range(1, 31)}
        past[(d0 - timedelta(days=1)).isoformat()] = 50.0  # 近7日 = 56
        ctx = WX.build_climate_context(dates, 45.0, past, self._clim())
        self.assertEqual(ctx["quality_status"], "PASS")
        self.assertEqual(ctx["forecast_7d"]["category"], "ABOVE_P90")
        self.assertEqual(ctx["forecast_7d"]["anomaly_pct"], 125)
        self.assertEqual(ctx["past_7d"]["value_mm"], 56.0)
        self.assertEqual(ctx["past_7d"]["category"], "ABOVE_P90")
        self.assertEqual(ctx["past_14d"]["value_mm"], 63.0)
        self.assertEqual(ctx["past_14d"]["category"], "ABOVE_NORMAL")
        self.assertEqual(ctx["past_30d"]["value_mm"], 79.0)
        self.assertEqual(ctx["past_30d"]["category"], "NEAR_NORMAL")
        self.assertEqual(ctx["past_30d"]["window_start"], "2026-09-20")

    def test_missing_inputs_stay_empty(self):
        d0 = date(2026, 10, 20)
        dates = [(d0 + timedelta(days=i)).isoformat() for i in range(7)]
        ctx = WX.build_climate_context(dates, 10.0, {}, None)
        self.assertEqual(ctx["quality_status"], "MISSING")
        self.assertIsNone(ctx["past_7d"]["value_mm"])
        self.assertIsNone(ctx["forecast_7d"]["category"])
        partial = {(d0 - timedelta(days=i)).isoformat(): 1.0 for i in range(1, 8)}
        ctx = WX.build_climate_context(dates, 10.0, partial, self._clim())
        self.assertEqual(ctx["quality_status"], "WARNING")
        self.assertEqual(ctx["past_7d"]["category"], "BELOW_NORMAL")
        self.assertIsNone(ctx["past_30d"]["value_mm"])

    def test_tiny_normal_has_no_percentage(self):
        item = WX.classify_against_climatology(3.0, [0.5, 0, 0, 1, 2])
        self.assertIsNone(item["anomaly_pct"])
        self.assertEqual(item["category"], "ABOVE_P90")


class ModelBiasTest(unittest.TestCase):
    def test_monthly_ratio_uses_three_month_window_and_paired_days(self):
        era5 = _daily(date(2022, 1, 1), date(2025, 12, 31), lambda d: 4.0 if d.month in (6, 7, 8) else 1.0)
        model = {k: v * 1.5 for k, v in era5.items()}
        model["2023-07-10"] = None  # 只用两边都有值的日期
        ratios, details = BIAS.monthly_ratios(model, era5)
        self.assertEqual(ratios[6], 1.5)
        self.assertEqual(details[6]["days"], 4 * 92 - 1)
        self.assertTrue(all(r == 1.5 for r in ratios))

    def test_ratio_clipped_and_small_reference_empty(self):
        era5 = _daily(date(2022, 1, 1), date(2022, 12, 31), lambda d: 0.0 if d.month in (1, 2, 3) else 2.0)
        model = {k: (5.0 if k[5:7] in ("01", "02", "03") else 10.0) for k in era5}
        ratios, details = BIAS.monthly_ratios(model, era5, min_reference_mm=30.0, clip=(0.5, 2.0))
        self.assertIsNone(ratios[1])          # 1–3月 ERA5 合计为0，不可靠
        self.assertEqual(ratios[6], 2.0)      # 原始5.0，截断到2.0
        self.assertTrue(details[6]["clipped"])

    def test_context_scales_baseline_by_mid_window_month(self):
        d0 = date(2026, 10, 20)
        dates = [(d0 + timedelta(days=i)).isoformat() for i in range(7)]
        clim = {"windows": {"7": [[20.0, 5.0, 12.0, 25.0, 40.0]] * 365, "14": [[40.0, 10, 30, 50, 80]] * 365,
                            "30": [[100.0, 30, 70, 120, 180]] * 365}}
        bias = {"ratio_by_month": [1.0] * 8 + [0.5] + [2.0] + [1.0] * 2}  # 9月0.5，10月2.0
        past = {(d0 - timedelta(days=i)).isoformat(): 2.0 for i in range(1, 31)}
        ctx = WX.build_climate_context(dates, 45.0, past, clim, bias)
        # 未来7日中点在10月：基准均值 20×2=40，p90=80 → 45 属正常偏上
        self.assertEqual(ctx["forecast_7d"]["normal_mm"], 40.0)
        self.assertEqual(ctx["forecast_7d"]["category"], "NEAR_NORMAL")
        self.assertTrue(ctx["forecast_7d"]["bias_corrected"])
        # 过去30日 9/20–10/19，中点10/5 → 10月比例2.0
        self.assertEqual(ctx["past_30d"]["normal_mm"], 200.0)
        self.assertEqual(ctx["past_30d"]["bias_ratio"], 2.0)
        # 无校正文件时保持原基准
        raw = WX.build_climate_context(dates, 45.0, past, clim, None)
        self.assertEqual(raw["forecast_7d"]["normal_mm"], 20.0)
        self.assertFalse(raw["forecast_7d"]["bias_corrected"])


class ImergArchiveTest(unittest.TestCase):
    LOCS = [{"station_id": "a", "latitude": 7.2, "longitude": 100.6},
            {"station_id": "b", "latitude": -3.0, "longitude": 104.7}]

    def test_url_uses_utc_product_day_and_version(self):
        url = WX.imerg_1day_url(date(2026, 10, 19), "V07B")
        self.assertTrue(url.endswith("/2026/10/3B-HHR-L.MS.MRG.3IMERG.20261019-S233000-E235959.1410.V07B.1day.tif"))

    def test_update_skips_existing_and_records_unavailable(self):
        from datetime import datetime, timezone
        calls = []

        def fake(day, locs, email):
            calls.append(day)
            if day == date(2026, 10, 18):
                raise FileNotFoundError
            return "V07C", {"a": 1.5, "b": None}

        archive = WX.empty_imerg_archive()
        archive["stations"] = {"a": {"2026-10-19": 2.0}, "b": {"2026-10-19": 0.0}}
        now = datetime(2026, 10, 20, 12, tzinfo=timezone.utc)
        days = [date(2026, 10, 19), date(2026, 10, 18), date(2026, 10, 17)]
        added, unavailable = WX.update_imerg_archive(archive, self.LOCS, "x@y", days, fetch=fake, now=now)
        self.assertEqual((added, unavailable), (1, 1))
        self.assertEqual(calls, [date(2026, 10, 18), date(2026, 10, 17)])  # 19日已存在，跳过
        self.assertIsNone(archive["stations"]["b"]["2026-10-17"])         # 缺测保持为空
        self.assertIn("2026-10-18", archive["unavailable"])
        self.assertEqual(archive["coverage"]["days"], 2)
        # 近10天内的不可用日期下次会重试；更早的不再重试
        calls.clear()
        WX.update_imerg_archive(archive, self.LOCS, "x@y", [date(2026, 10, 18)], fetch=fake, now=now)
        self.assertEqual(calls, [date(2026, 10, 18)])
        calls.clear()
        later = datetime(2026, 11, 20, tzinfo=timezone.utc)
        WX.update_imerg_archive(archive, self.LOCS, "x@y", [date(2026, 10, 18)], fetch=fake, now=later)
        self.assertEqual(calls, [])

    def test_fetch_day_falls_back_to_older_version(self):
        import io
        import urllib.error
        from PIL import Image
        img = Image.new("I", (360, 180), 0)
        img.putpixel((280, 82), 123)  # 7.2N 100.6E → 12.3 mm（0.1mm存储）
        buf = io.BytesIO()
        img.save(buf, format="TIFF")
        payload = buf.getvalue()
        tried = []

        class Resp(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def fake_request(url, email, timeout=60):
            tried.append(url.split(".")[-3])
            if ".V07C." in url:
                raise urllib.error.HTTPError(url, 404, "nf", None, None)
            return Resp(payload)

        original = WX._authenticated_request
        WX._authenticated_request = fake_request
        try:
            version, values = WX.fetch_imerg_day(date(2024, 3, 1), self.LOCS[:1], "x@y")
        finally:
            WX._authenticated_request = original
        self.assertEqual(version, "V07B")
        self.assertEqual(tried, ["V07C", "V07B"])
        self.assertEqual(values["a"], 12.3)

    def test_context_prefers_complete_satellite_window(self):
        d0 = date(2026, 10, 20)
        dates = [(d0 + timedelta(days=i)).isoformat() for i in range(7)]
        clim = {"windows": {"7": [[20.0, 5.0, 12.0, 25.0, 40.0]] * 365, "14": [[40.0, 10, 30, 50, 80]] * 365,
                            "30": [[100.0, 30, 70, 120, 180]] * 365}}
        model = {(d0 - timedelta(days=i)).isoformat(): 1.0 for i in range(1, 31)}
        obs = {(d0 - timedelta(days=i)).isoformat(): 5.0 for i in range(1, 15)}  # 只有近14天卫星
        obs_bias = {"ratio_by_month": [1.25] * 12}
        ctx = WX.build_climate_context(dates, 20.0, model, clim, None, obs, obs_bias)
        self.assertEqual(ctx["forecast_7d"]["source"], "FORECAST")
        self.assertEqual(ctx["past_7d"]["source"], "IMERG")
        self.assertEqual(ctx["past_7d"]["value_mm"], 35.0)
        self.assertEqual(ctx["past_7d"]["normal_mm"], 25.0)   # 20×1.25
        self.assertEqual(ctx["past_14d"]["source"], "IMERG")
        self.assertEqual(ctx["past_30d"]["source"], "MODEL")  # 卫星不完整，退回模式
        self.assertEqual(ctx["past_30d"]["value_mm"], 30.0)
        self.assertEqual(ctx["past_30d"]["normal_mm"], 100.0)  # 模式比例缺失 → 不校正
        none = WX.build_climate_context(dates, 20.0, {}, clim, None, {}, None)
        self.assertIsNone(none["past_7d"]["source"])

    def test_imerg_ratio_requires_enough_paired_days(self):
        era5 = _daily(date(2025, 1, 1), date(2025, 3, 31), lambda d: 2.0)
        obs = {k: 3.0 for k in era5}
        ratios, _ = BIAS.monthly_ratios(obs, era5, min_days=60)
        self.assertEqual(ratios[1], 1.5)   # 2月窗口(1–3月)有90天
        self.assertIsNone(ratios[6])       # 7月无数据


if __name__ == "__main__":
    unittest.main()
