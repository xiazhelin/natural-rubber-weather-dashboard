import importlib.util
import json
import tempfile
import unittest
from datetime import datetime, timedelta
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
        self.tapping_window = {
            "start_hour_local": 4,
            "end_hour_local": 10,
            "rain_hour_threshold_mm": 0.1,
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
                "time": [
                    (datetime(2026, 9, 12) + timedelta(hours=hour)).isoformat(timespec="minutes")
                    for hour in range(168)
                ],
                "precipitation": [1 if hour % 24 in range(4, 10) else 0 for hour in range(168)],
                "precipitation_probability": [70] * 168,
                "soil_moisture_9_to_27cm": [0.25] * 168,
                "soil_moisture_27_to_81cm": [0.31] * 168,
            },
        }
        location = {"station_id": "test", "country": "泰国", "region": "南部", "place": "测试点", "latitude": 8, "longitude": 100}
        station = MODULE.build_station(location, payload, self.thresholds, self.tapping_window)
        self.assertEqual(station["quality_status"], "PASS")
        self.assertEqual(station["summary"]["precipitation_7d_mm"], 165.0)
        self.assertEqual(station["summary"]["heavy_rain_days_7d"], 5)
        self.assertEqual(station["summary"]["weather_states"], ["HEAVY_RAIN", "HEAT"])
        self.assertEqual(station["summary"]["soil_moisture_27_81cm_mean_7d"], 0.31)
        self.assertEqual(station["summary"]["tapping_window_precipitation_7d_mm"], 42.0)
        self.assertEqual(station["summary"]["tapping_window_rain_hours_7d"], 42)

    def test_imerg_grid_sampling_and_missing_value(self):
        class Image:
            size = (3600, 1800)

            def __init__(self, value):
                self.value = value
                self.coordinate = None

            def getpixel(self, coordinate):
                self.coordinate = coordinate
                return self.value

        image = Image(123)
        self.assertEqual(MODULE.sample_imerg_pixel(image, 0, 0), 12.3)
        self.assertEqual(image.coordinate, (1800, 900))
        self.assertIsNone(MODULE.sample_imerg_pixel(Image(29999), 0, 0))

    def test_forecast_realization_uses_only_prior_aligned_forecast(self):
        old_forecast = [
            {"date_utc": f"2026-09-{day:02d}", "precipitation_mm": value}
            for day, value in ((9, 5), (10, 10), (11, 15))
        ]
        future_forecast = [
            {"date_utc": "2026-09-11", "precipitation_mm": 100}
        ]
        history = {
            "snapshots": [
                {"generated_at_utc": "2026-09-07T13:00:00Z", "stations": [{"station_id": "test", "forecast_utc_daily": old_forecast}]},
                {"generated_at_utc": "2026-09-11T12:00:00Z", "stations": [{"station_id": "test", "forecast_utc_daily": future_forecast}]},
            ]
        }
        dataset = {
            "observation_source": {"end_at_utc": "2026-09-11T23:59:59Z"},
            "stations": [{"station_id": "test", "imerg": {"precipitation_24h_mm": 10, "precipitation_72h_mm": 30}}],
        }
        MODULE.attach_verification(dataset, history)
        verification = dataset["stations"][0]["verification"]
        self.assertEqual(verification["24h"]["forecast_mm"], 15.0)
        self.assertEqual(verification["24h"]["realization_pct"], 66.7)
        self.assertEqual(verification["72h"]["realization_pct"], 100.0)
        self.assertEqual(verification["24h"]["forecast_generated_at_utc"], "2026-09-07T13:00:00Z")

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
        self.assertIn("NASA_PPS_EMAIL", workflow)
        self.assertIn("pip install -r requirements.txt", workflow)
        self.assertNotIn('id="reloadButton"', page)
        self.assertNotIn('id="updateLink"', page)
        self.assertNotIn("更新控制", page)
        self.assertNotIn("每周五 21:00 自动更新", page)
        self.assertNotIn("reloadButton", script)
        self.assertNotIn("updateLink", script)
        self.assertIn("Natural Earth 1:110m", page)
        self.assertIn("MAP_DATA_URL", script)
        self.assertIn('class="map-land"', script)


if __name__ == "__main__":
    unittest.main()
