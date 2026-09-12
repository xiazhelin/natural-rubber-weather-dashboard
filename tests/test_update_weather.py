import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "update_weather.py"
SPEC = importlib.util.spec_from_file_location("update_weather", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class WeatherPipelineTest(unittest.TestCase):
    def setUp(self):
        self.thresholds = {
            "heavy_rain_total_7d_mm": 150,
            "dry_total_7d_mm": 20,
            "heavy_rain_day_mm": 25,
            "hot_day_max_c": 35,
        }

    def test_station_summary_and_descriptive_states(self):
        daily = {
            "time": [f"2026-09-{day:02d}" for day in range(12, 19)],
            "weather_code": [61] * 7,
            "temperature_2m_max": [31, 32, 33, 34, 35, 33, 32],
            "temperature_2m_min": [23] * 7,
            "precipitation_sum": [30, 30, 30, 30, 30, 10, 5],
            "precipitation_probability_max": [80] * 7,
            "wind_gusts_10m_max": [20] * 7,
            "et0_fao_evapotranspiration": [3] * 7,
        }
        payload = {
            "timezone": "Asia/Bangkok",
            "elevation": 12,
            "daily": daily,
            "hourly": {
                "soil_moisture_9_to_27cm": [0.25] * 168,
                "soil_moisture_27_to_81cm": [0.31] * 168,
            },
        }
        location = {"station_id": "test", "country": "泰国", "region": "南部", "place": "测试点", "latitude": 8, "longitude": 100}
        station = MODULE.build_station(location, payload, self.thresholds)
        self.assertEqual(station["quality_status"], "PASS")
        self.assertEqual(station["summary"]["precipitation_7d_mm"], 165.0)
        self.assertEqual(station["summary"]["heavy_rain_days_7d"], 5)
        self.assertEqual(station["summary"]["weather_states"], ["HEAVY_RAIN", "HEAT"])
        self.assertEqual(station["summary"]["soil_moisture_27_81cm_mean_7d"], 0.31)

    def test_history_is_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "history.json"
            for index in range(3):
                dataset = {
                    "generated_at_utc": f"2026-09-12T0{index}:00:00Z",
                    "stations": [{"station_id": "test", "quality_status": "PASS", "summary": {"precipitation_7d_mm": index}}],
                }
                MODULE.update_history(path, dataset, maximum=2)
            snapshots = json.loads(path.read_text(encoding="utf-8"))["snapshots"]
            self.assertEqual(len(snapshots), 2)
            self.assertEqual(snapshots[0]["generated_at_utc"], "2026-09-12T01:00:00Z")

    def test_publish_controls_and_schedule(self):
        root = SCRIPT.parent.parent
        workflow = (root / ".github/workflows/update-weather.yml").read_text(encoding="utf-8")
        page = (root / "site/index.html").read_text(encoding="utf-8")
        script = (root / "site/assets/app.js").read_text(encoding="utf-8")

        self.assertIn('cron: "0 21 * * 5"', workflow)
        self.assertIn('timezone: "Asia/Shanghai"', workflow)
        self.assertIn("workflow_dispatch:", workflow)
        self.assertNotIn('id="reloadButton"', page)
        self.assertNotIn('id="updateLink"', page)
        self.assertNotIn("reloadButton", script)
        self.assertNotIn("updateLink", script)


if __name__ == "__main__":
    unittest.main()
