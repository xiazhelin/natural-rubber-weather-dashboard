import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("check_alerts", ROOT / "scripts" / "check_alerts.py")
ALERTS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ALERTS)


def station(sid, country="泰国", region="南部", rain=50, heavy=0, f7=None, p30=None, ens=None):
    return {"station_id": sid, "country": country, "region": region, "place": sid, "quality_status": "PASS",
            "summary": {"precipitation_7d_mm": rain, "heavy_rain_days_7d": heavy},
            "climate_context": {"forecast_7d": f7 or {}, "past_30d": p30 or {}, "forecast_7d_ensemble": ens or {}}}


class AlertRulesTest(unittest.TestCase):
    weights = {"th_south_songkhla": {"share_of_country_pct": 8.6}, "th_small": {"share_of_country_pct": 0.5}}

    def rules(self, stations):
        weather = {"thresholds": {"heavy_rain_total_7d_mm": 150}, "stations": stations}
        return {s["key"] for s in ALERTS.evaluate(weather, self.weights)}

    def test_key_stations_only(self):
        keys = self.rules([station("th_south_songkhla", rain=160), station("th_small", rain=300)])
        self.assertEqual(keys, {"th_south_songkhla:HEAVY_7D"})

    def test_unweighted_countries_count_as_key(self):
        keys = self.rules([station("vn_x", country="越南", region="东南部", heavy=3)])
        self.assertEqual(keys, {"vn_x:HEAVY_7D"})

    def test_wet_requires_ensemble_agreement(self):
        f7 = {"category": "ABOVE_P90", "value_mm": 120, "normal_mm": 60}
        weak = station("th_south_songkhla", f7=f7, ens={"quality_status": "PASS", "prob_above_p90_pct": 20,
                                                         "prob_above_normal_pct": 50, "prob_below_normal_pct": 10})
        strong = station("th_south_songkhla", f7=f7, ens={"quality_status": "PASS", "prob_above_p90_pct": 45,
                                                           "prob_above_normal_pct": 50, "prob_below_normal_pct": 10})
        self.assertNotIn("th_south_songkhla:WET_P90", self.rules([weak]))
        self.assertIn("th_south_songkhla:WET_P90", self.rules([strong]))

    def test_dry_30d_skips_dry_season(self):
        wet_season = station("th_south_songkhla", p30={"category": "BELOW_P10", "value_mm": 40, "normal_mm": 200, "source": "IMERG"})
        dry_season = station("th_south_songkhla", p30={"category": "BELOW_P10", "value_mm": 2, "normal_mm": 20})
        self.assertIn("th_south_songkhla:DRY_P10_30D", self.rules([wet_season]))
        self.assertNotIn("th_south_songkhla:DRY_P10_30D", self.rules([dry_season]))

    def test_regional_ensemble_weighted(self):
        ens = lambda up: {"quality_status": "PASS", "prob_above_normal_pct": up, "prob_below_normal_pct": 5, "prob_above_p90_pct": 0}
        keys = self.rules([station("th_south_songkhla", ens=ens(90)), station("th_small", ens=ens(10))])
        self.assertIn("泰国南部东海岸:ENS_WET", keys)  # 8.6 vs 0.5 权重 → 加权约85%

    def test_dedupe_with_state(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            weather = {"generated_at_utc": "2026-10-21T00:00:00Z", "thresholds": {}, "stations": [station("th_south_songkhla", rain=200)]}
            (d / "w.json").write_text(json.dumps(weather), encoding="utf-8")
            (d / "p.json").write_text(json.dumps({"stations": self.weights}), encoding="utf-8")
            args = ["--weather", str(d / "w.json"), "--weights", str(d / "p.json"), "--state", str(d / "s.json"), "--write-state", str(d / "s.json")]
            import contextlib, io
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                ALERTS.main(args)
            first = json.loads(out.getvalue())
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                ALERTS.main(args)
            second = json.loads(out.getvalue())
            self.assertEqual(len(first["new"]), 1)
            self.assertEqual(second["new"], [])
            self.assertEqual(len(second["signals"]), 1)


if __name__ == "__main__":
    unittest.main()
