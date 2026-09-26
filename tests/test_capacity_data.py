"""Small integrity check for the editable capacity-map data files."""

import json
import unittest
from pathlib import Path


DATA = Path(__file__).resolve().parents[1] / "site" / "data" / "capacity"


class CapacityDataTest(unittest.TestCase):
    def test_references_and_units(self):
        tyre = json.loads((DATA / "tyre-factories.json").read_text(encoding="utf-8"))
        rubber = json.loads((DATA / "rubber-regions.json").read_text(encoding="utf-8"))
        for data, records in ((tyre, tyre["factories"]), (rubber, rubber["regions"])):
            self.assertEqual(len(records), len({item["id"] for item in records}))
            for source in data["sources"].values():
                self.assertTrue(source["url"].startswith("https://"))
                self.assertTrue(source["published"])
            for item in records:
                self.assertTrue(-90 <= item["latitude"] <= 90)
                self.assertTrue(-180 <= item["longitude"] <= 180)
                self.assertTrue(item["source_ids"])
                self.assertTrue(set(item["source_ids"]) <= set(data["sources"]))
        for item in tyre["factories"]:
            for line in item["lines"]:
                self.assertIn(line["capacity_unit"], {"万条/年", "条/日", "万吨轮胎/年"})
                self.assertTrue(line["design_capacity"] is not None or line.get("capacity_lower_bound") is not None)
                self.assertTrue(line["effective_capacity_2025"] is None or line["effective_capacity_2025"] >= 0)
                if item["status"] in {"BUILDING", "PLANNED"}:
                    self.assertIsNone(line["formed_capacity"])
                    self.assertIsNone(line["effective_capacity_2025"])
        for item in tyre["group_benchmarks"]:
            self.assertGreater(item["actual_nr_t"], 0)
            self.assertTrue(set(item["source_ids"]) <= set(tyre["sources"]))
        for item in rubber["regions"]:
            self.assertIn(item["level"], {"PROVINCE", "COUNTRY"})
            self.assertGreaterEqual(item["production_t"], 0)
            if item["level"] == "COUNTRY":
                self.assertIsNone(item["province"])

    def test_indonesia_source_reconciliation(self):
        data = json.loads((DATA / "rubber-regions.json").read_text(encoding="utf-8"))
        provinces = [item for item in data["regions"] if item["country"] == "印度尼西亚" and item["level"] == "PROVINCE"]
        total = data["national_totals"]["印度尼西亚"]["production_t"]
        self.assertEqual(sum(item["production_t"] for item in provinces) - total, 1)
        self.assertIn("多 1", data["reconciliation"]["note"])


if __name__ == "__main__":
    unittest.main()
