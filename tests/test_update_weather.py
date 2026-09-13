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
            "start_hour_local": 2,
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
                    for hour in range(192)
                ],
                "precipitation": [1 if hour % 24 in range(2, 10) else 0 for hour in range(192)],
                "precipitation_probability": [70] * 192,
                "soil_moisture_9_to_27cm": [0.25] * 192,
                "soil_moisture_27_to_81cm": [0.31] * 192,
            },
        }
        location = {"station_id": "test", "country": "泰国", "region": "南部", "place": "测试点", "latitude": 8, "longitude": 100}
        station = MODULE.build_station(
            location,
            payload,
            self.thresholds,
            self.tapping_window,
            datetime(2026, 9, 12, tzinfo=MODULE.timezone.utc),
        )
        self.assertEqual(station["quality_status"], "PASS")
        self.assertEqual(station["summary"]["precipitation_7d_mm"], 165.0)
        self.assertEqual(station["summary"]["heavy_rain_days_7d"], 5)
        self.assertEqual(station["summary"]["weather_states"], ["HEAVY_RAIN", "HEAT"])
        self.assertEqual(station["summary"]["soil_moisture_27_81cm_mean_7d"], 0.31)
        self.assertEqual(station["summary"]["tapping_window_precipitation_7d_mm"], 56.0)
        self.assertEqual(station["summary"]["tapping_window_rain_hours_7d"], 56)
        self.assertEqual(len(station["forecast_utc_6h"]), 28)

    def test_six_hour_forecast_aligns_local_hours_to_utc(self):
        hourly = {
            "time": [
                (datetime(2026, 9, 12) + timedelta(hours=hour)).isoformat(timespec="minutes")
                for hour in range(48)
            ],
            "precipitation": [1] * 48,
        }
        forecast = MODULE.utc_six_hour_forecast(
            hourly,
            "Asia/Bangkok",
            datetime(2026, 9, 12, 0, 1, tzinfo=MODULE.timezone.utc),
            periods=2,
        )
        self.assertEqual(forecast[0]["start_at_utc"], "2026-09-12T06:00:00Z")
        self.assertEqual(forecast[0]["end_at_utc"], "2026-09-12T12:00:00Z")
        self.assertEqual(forecast[0]["precipitation_mm"], 6.0)

    def test_thailand_weekly_rain_requires_complete_point_weeks(self):
        start = datetime(2026, 9, 7).date()
        dates = [(start + timedelta(days=offset)).isoformat() for offset in range(7)]
        point_days = {
            "a": dict(zip(dates, [1] * 7)),
            "b": dict(zip(dates, [2] * 7)),
        }
        self.assertEqual(MODULE.weekly_region_value(point_days, ["a", "b"], start), 10.5)
        point_days["b"][dates[-1]] = None
        self.assertIsNone(MODULE.weekly_region_value(point_days, ["a", "b"], start))

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

    def test_imerg_dates_and_direct_product_urls(self):
        dates = MODULE._imerg_candidate_dates(
            "bad\n20260910\n20260912\n20260911\n20260912\n",
            datetime(2026, 9, 11).date(),
        )
        self.assertEqual(dates, ["20260911", "20260910"])
        urls = MODULE._imerg_urls(dates[0])
        self.assertTrue(urls["1day"].endswith("V07C.1day.tif"))
        self.assertTrue(urls["3day"].endswith("V07C.3day.tif"))

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

    def test_bom_index_parser_and_svg(self):
        points = MODULE.parse_bom_index(
            "period_start,period_end,value\n20260801,20260807,0.75\n"
            "bad,row\n20260808,20260814,1.25\n"
        )
        self.assertEqual(points[0][0].isoformat(), "2026-08-07")
        self.assertEqual(points[-1][1], 1.25)
        svg = MODULE.render_bom_svg(points, "Test index", -3, 3, -0.8, 0.8)
        self.assertIn("<svg", svg)
        self.assertIn("Latest week ending 2026-08-14", svg)
        self.assertIn("Test index", svg)

    def test_seasia_temperature_archive_keeps_four_distinct_maps(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            for index in range(5):
                MODULE.archive_seasia_temperature(
                    b"\x89PNG\r\n\x1a\n" + bytes([index]),
                    datetime(2026, 8, 3, tzinfo=MODULE.timezone.utc) + timedelta(days=index * 7),
                    directory=directory,
                )
            history = json.loads((directory / "seasia-temperature-history.json").read_text(encoding="utf-8"))
            self.assertEqual(len(history["items"]), 4)
            self.assertEqual(history["items"][0]["captured_at_utc"], "2026-08-31T00:00:00Z")
            self.assertEqual(len(list(directory.glob("seasia-temperature-*.png"))), 4)
            MODULE.archive_seasia_temperature(
                b"\x89PNG\r\n\x1a\nrevision", datetime(2026, 9, 1, tzinfo=MODULE.timezone.utc), directory=directory
            )
            self.assertEqual(len(list(directory.glob("seasia-temperature-*.png"))), 4)

    def test_publish_controls_and_schedule(self):
        root = SCRIPT.parent.parent
        workflow = (root / ".github/workflows/update-weather.yml").read_text(encoding="utf-8")
        config = json.loads((root / "config/locations.json").read_text(encoding="utf-8"))
        page = (root / "site/index.html").read_text(encoding="utf-8")
        script = (root / "site/assets/app.js").read_text(encoding="utf-8")

        self.assertIn('cron: "0 21 * * 5"', workflow)
        self.assertIn('timezone: "Asia/Shanghai"', workflow)
        self.assertIn("workflow_dispatch:", workflow)
        self.assertIn("NASA_PPS_EMAIL", workflow)
        self.assertIn("pip install -r requirements.txt", workflow)
        self.assertIn("site/assets/climate/", workflow)
        self.assertIn("site/data/thailand-weekly-rain.json", workflow)
        self.assertNotIn('id="reloadButton"', page)
        self.assertNotIn('id="updateLink"', page)
        self.assertNotIn("更新控制", page)
        self.assertNotIn("每周五 21:00 自动更新", page)
        self.assertNotIn("reloadButton", script)
        self.assertNotIn("updateLink", script)
        self.assertEqual(config["tapping_window"]["start_hour_local"], 2)
        self.assertEqual(config["tapping_window"]["end_hour_local"], 10)
        self.assertIn("晨间割胶作业窗", page)
        self.assertIn("Natural Earth 1:110m", page)
        self.assertIn("MAP_DATA_URL", script)
        self.assertIn('class="map-land"', script)
        self.assertIn("assets/climate/rnino34-weekly.svg", page)
        self.assertIn("assets/climate/iod-weekly.svg", page)
        self.assertIn("assets/climate/roni-outlook.png", page)
        self.assertIn('id="seasiaTempAnomalyTitle"', page)
        self.assertIn('id="seasiaTempGrid"', page)
        self.assertIn("最近四周气温距平", page)
        self.assertIn("wctan5.png", page)
        self.assertIn("GTS地面站", page)
        self.assertIn("function loadTemperatureHistory()", script)

    def test_weekly_summary_is_wired_into_dashboard(self):
        root = SCRIPT.parent.parent
        page = (root / "site/index.html").read_text(encoding="utf-8")
        script = (root / "site/assets/app.js").read_text(encoding="utf-8")
        styles = (root / "site/assets/styles.css").read_text(encoding="utf-8")

        self.assertIn('id="weeklySummary"', page)
        self.assertIn("function renderWeeklySummary()", script)
        self.assertIn("renderWeeklySummary();", script)
        self.assertIn("【本项目判断】本周关注", script)
        self.assertIn(".weekly-summary-grid", styles)
        self.assertIn('id="sixHourRows"', page)
        self.assertIn("function renderSixHourForecast()", script)
        self.assertIn("renderSixHourForecast();", script)
        self.assertIn(".six-hour-table", styles)
        self.assertIn('id="thailandRainCharts"', page)
        self.assertIn("function renderThailandWeeklyRain()", script)
        self.assertIn(".thailand-rain-grid", styles)


if __name__ == "__main__":
    unittest.main()
