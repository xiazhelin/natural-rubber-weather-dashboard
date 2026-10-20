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


if __name__ == "__main__":
    unittest.main()
