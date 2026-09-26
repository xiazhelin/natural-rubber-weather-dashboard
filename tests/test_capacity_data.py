"""Small integrity check for the editable capacity-map data files."""

import json
import unittest
from pathlib import Path


DATA = Path(__file__).resolve().parents[1] / "site" / "data" / "capacity"


class CapacityDataTest(unittest.TestCase):
    def test_references_and_units(self):
        tyre = json.loads((DATA / "tyre-factories.json").read_text(encoding="utf-8"))
        rubber = json.loads((DATA / "rubber-regions.json").read_text(encoding="utf-8"))
        for data, records in ((tyre, tyre["factories"] + tyre.get("registry_candidates", [])), (rubber, rubber["regions"])):
            self.assertEqual(len(records), len({item["id"] for item in records}))
            for source in data["sources"].values():
                self.assertTrue(source["url"].startswith("https://"))
                self.assertTrue(source.get("published") or source.get("accessed"))
            for item in records:
                if item["latitude"] is None or item["longitude"] is None:
                    self.assertIsNone(item["latitude"])
                    self.assertIsNone(item["longitude"])
                    self.assertNotEqual(item["quality"], "PASS")
                else:
                    self.assertTrue(-90 <= item["latitude"] <= 90)
                    self.assertTrue(-180 <= item["longitude"] <= 180)
                self.assertTrue(item["source_ids"])
                self.assertTrue(set(item["source_ids"]) <= set(data["sources"]))
        for item in tyre["factories"]:
            for line in item["lines"]:
                self.assertIn(line["capacity_unit"], {"万条/年", "条/日", "万吨轮胎/年"})
                if line["design_capacity"] is None and line.get("capacity_lower_bound") is None:
                    self.assertNotEqual(item["quality"], "PASS")
                self.assertTrue(line["effective_capacity_2025"] is None or line["effective_capacity_2025"] >= 0)
                if item["status"] in {"BUILDING", "PLANNED"}:
                    self.assertIsNone(line["formed_capacity"])
                    self.assertIsNone(line["effective_capacity_2025"])
        for item in tyre["group_benchmarks"]:
            self.assertGreater(item["actual_nr_t"], 0)
            self.assertTrue(set(item["source_ids"]) <= set(tyre["sources"]))
        for item in rubber["regions"]:
            self.assertIn(item["level"], {"PROVINCE", "COUNTRY"})
            if item["production_t"] is None:
                self.assertEqual(item["quality"], "MISSING")
                self.assertEqual(item["reporting_status"], "NOT_LISTED")
            else:
                self.assertGreaterEqual(item["production_t"], 0)
            if item["level"] == "COUNTRY":
                self.assertIsNone(item["province"])

    def test_census_layers_and_addresses(self):
        tyre = json.loads((DATA / "tyre-factories.json").read_text(encoding="utf-8"))
        registry = json.loads((DATA / "tyre-manufacturers.json").read_text(encoding="utf-8"))
        makers = {m["id"] for m in registry["manufacturers"]}
        self.assertEqual(len(makers), 75)
        self.assertEqual(len(registry["manufacturers"]), 75)
        self.assertEqual(registry["ranking"]["edition"], 2025)
        self.assertEqual(registry["ranking"]["data_year"], 2024)
        factory_ids = {f["id"] for f in tyre["factories"]}
        for f in tyre["factories"] + tyre["registry_candidates"]:
            self.assertIn(f["manufacturer_id"], makers)
            self.assertEqual(f["country"], f["country"].strip())
            self.assertNotIn(f["country"], {"VN", "Netherlands", "ISRAEL", "越南（历史登记）"})
            self.assertIn(f["address_quality"], {"PASS", "WARNING", "MISSING"})
            self.assertTrue(set(f["address_source_ids"]) <= set(tyre["sources"]))
            if f["address_quality"] == "PASS":
                self.assertTrue(f["address"])
                self.assertTrue(f["address_source_ids"])
            for line in f["lines"]:
                self.assertTrue(set(line.get("source_ids", [])) <= set(tyre["sources"]))
            for o in f.get("survey_observations", []):
                self.assertEqual(o["data_type"], "ESTIMATE")
                self.assertEqual(o["as_of"], "2025")
                self.assertTrue(12 <= o["source_page"] <= 23)
                self.assertTrue(o["dot_codes"])
        for f in tyre["registry_candidates"]:
            self.assertEqual(f["status"], "UNKNOWN")
            self.assertEqual(f["address_scope"], "REGISTRY_ADDRESS")
            self.assertNotEqual(f["address_quality"], "PASS")
            self.assertEqual(f["lines"], [])
            self.assertIsNone(f["latitude"])
            if f.get("matched_factory_id"):
                self.assertIn(f["matched_factory_id"], factory_ids)
        enschede = [f for f in tyre["factories"] if f["manufacturer_id"] == "apollo" and f.get("place") == "Enschede"]
        self.assertEqual(len(enschede), 1)
        self.assertEqual(enschede[0]["status"], "CLOSED")
        self.assertTrue(enschede[0]["survey_observations"])
        for f in tyre["factories"]:
            if f["census_record_type"] == "HISTORICAL_SURVEY_FACTORY":
                self.assertIn(f["status"], {"UNKNOWN", "CLOSED"})
                self.assertTrue(f["survey_observations"])
                self.assertTrue(all(l["design_capacity"] is None and l["formed_capacity"] is None for l in f["lines"]))

    def test_thailand_full_province_coverage(self):
        data = json.loads((DATA / "rubber-regions.json").read_text(encoding="utf-8"))
        provinces = [item for item in data["regions"] if item["country"] == "泰国"]
        self.assertEqual(len(provinces), 77)
        self.assertEqual(len({item["province_code"] for item in provinces}), 77)
        reported = [item for item in provinces if item["production_t"] is not None]
        self.assertEqual(len(reported), 69)
        self.assertEqual(sum(item["production_t"] for item in reported), 4837050)
        self.assertEqual(sum(item["productive_area"] for item in reported), 22359375)
        self.assertEqual(sum(item["production_t"] == 0 for item in reported), 1)
        zero = next(item for item in provinces if item["province_code"] == "TH-13")
        self.assertEqual(zero["reporting_status"], "REPORTED_ZERO")
        self.assertEqual(zero["productive_area"], 243)
        missing = {item["province_code"] for item in provinces if item["production_t"] is None}
        self.assertEqual(missing, {"TH-10", "TH-11", "TH-12", "TH-14", "TH-15", "TH-17", "TH-74", "TH-75"})
        self.assertEqual(missing, set(data["coverage"]["泰国"]["not_listed_province_codes"]))

    def test_indonesia_source_reconciliation(self):
        data = json.loads((DATA / "rubber-regions.json").read_text(encoding="utf-8"))
        provinces = [item for item in data["regions"] if item["country"] == "印度尼西亚" and item["level"] == "PROVINCE"]
        total = data["national_totals"]["印度尼西亚"]["production_t"]
        self.assertEqual(sum(item["production_t"] for item in provinces) - total, 1)
        self.assertIn("多 1", data["reconciliation"]["note"])


if __name__ == "__main__":
    unittest.main()
