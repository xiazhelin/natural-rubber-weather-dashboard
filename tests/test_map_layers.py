import json
import unittest
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class MapLayersTest(unittest.TestCase):
    """site/data/maps/*.topo.json 由 scripts/build-map-layers.mjs 生成；换界线或改代表点后需重跑。"""

    def load(self, name):
        return json.loads((ROOT / "site" / "data" / "maps" / f"{name}.topo.json").read_text(encoding="utf-8"))

    def test_layers_present_and_compact(self):
        for name in ("asia", "africa"):
            topo = self.load(name)
            self.assertEqual(topo["type"], "Topology")
            self.assertIn("transform", topo)  # 量化坐标，网页端按 transform 解码
            self.assertEqual(set(topo["objects"]), {"land", "admin"})
            self.assertLess((ROOT / "site" / "data" / "maps" / f"{name}.topo.json").stat().st_size, 1_500_000)

    def test_admin_coverage(self):
        countries = Counter()
        for name in ("asia", "africa"):
            for g in self.load(name)["objects"]["admin"]["geometries"]:
                countries[g["properties"]["country"]] += 1
        self.assertEqual(countries["泰国"], 77)
        self.assertEqual(countries["越南"], 63)
        self.assertEqual(countries["科特迪瓦"], 33)
        self.assertGreaterEqual(countries["印度尼西亚"], 10)
        self.assertEqual(countries["中国"], 4)

    def test_every_station_joined_to_one_region(self):
        config = json.loads((ROOT / "config" / "locations.json").read_text(encoding="utf-8"))
        joined = Counter()
        thai_iso = {}
        for name in ("asia", "africa"):
            for g in self.load(name)["objects"]["admin"]["geometries"]:
                for sid in filter(None, str(g["properties"].get("station_ids", "")).split(",")):
                    joined[sid] += 1
                    if g["properties"]["country"] == "泰国":
                        thai_iso[sid] = g["properties"]["iso"]
        ids = [loc["station_id"] for loc in config["locations"]]
        self.assertEqual(sorted(joined), sorted(ids))
        self.assertTrue(all(count == 1 for count in joined.values()))
        # 泰国代表点所在府（空间连接）与配置里的府代码一致
        for loc in config["locations"]:
            if loc.get("province_code"):
                self.assertEqual(thai_iso[loc["station_id"]], loc["province_code"], loc["station_id"])


if __name__ == "__main__":
    unittest.main()
