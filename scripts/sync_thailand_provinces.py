#!/usr/bin/env python3
"""Sync Thai weather points and weights from the audited OAE province table."""

import argparse
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXISTING_CODES = {
    "th_south_surat_thani": "TH-84", "th_south_nakhon_si_thammarat": "TH-80",
    "th_south_songkhla": "TH-90", "th_south_trang": "TH-92",
    "th_south_yala": "TH-95", "th_northeast_udon_thani": "TH-41",
    "th_northeast_bueng_kan": "TH-38", "th_northeast_ubon": "TH-34",
    "th_east_rayong": "TH-21",
}


def inside_ring(point, ring):
    x, y = point
    inside = False
    for i, (ax, ay) in enumerate(ring):
        bx, by = ring[i - 1]
        if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax:
            inside = not inside
    return inside


def inside_geometry(point, geometry):
    polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
    return any(inside_ring(point, rings[0]) and not any(inside_ring(point, hole) for hole in rings[1:]) for rings in polygons)


def sample_point(region, geometry):
    original = (region["longitude"], region["latitude"])
    if inside_geometry(original, geometry):
        return original
    points = [p for polygon in (geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]) for ring in polygon for p in ring]
    west, east = min(p[0] for p in points), max(p[0] for p in points)
    south, north = min(p[1] for p in points), max(p[1] for p in points)
    candidates = ((west + (east - west) * i / 80, south + (north - south) * j / 80) for i in range(1, 80) for j in range(1, 80))
    chosen = min((p for p in candidates if inside_geometry(p, geometry)), key=lambda p: (p[0] - original[0]) ** 2 + (p[1] - original[1]) ** 2)
    return tuple(round(value, 4) for value in chosen)


def write_json(path, value, compact=False):
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":") if compact else None,
                               indent=None if compact else 2) + "\n", encoding="utf-8")


def main(geo_path):
    source = json.loads(geo_path.read_text(encoding="utf-8"))
    features = {feature["properties"]["shapeISO"]: feature for feature in source["features"]}
    regions = json.loads((ROOT / "site/data/capacity/rubber-regions.json").read_text(encoding="utf-8"))
    thai = [r for r in regions["regions"] if r["country"] == "泰国" and isinstance(r["production_t"], (int, float)) and r["production_t"] > 0]
    assert len(features) == 77 and len(thai) == 68 and len({r["province_code"] for r in thai}) == 68
    total = regions["national_totals"]["泰国"]["production_t"]
    assert sum(r["production_t"] for r in thai) == total

    config_path = ROOT / "config/locations.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    old = {EXISTING_CODES[loc["station_id"]]: loc for loc in config["locations"] if loc["station_id"] in EXISTING_CODES}
    assert len(old) == 9
    new_locations = []
    for region in thai:
        code = region["province_code"]
        if code in old:
            location = {**old[code], "province_code": code}
        else:
            lon, lat = sample_point(region, features[code]["geometry"])
            location = {"station_id": region["id"], "country": "泰国", "region": region["region"],
                        "place": region["province"], "province_code": code, "latitude": lat, "longitude": lon}
        assert inside_geometry((location["longitude"], location["latitude"]), features[code]["geometry"]), code
        new_locations.append(location)
    config["locations"] = [loc for loc in config["locations"] if loc["country"] != "泰国"] + new_locations
    config["description"] = "天然橡胶产区省级代表网格；泰国覆盖OAE 2025f表中全部68个正产量府。单点模式预报不代表全府平均或地面站实测。"
    write_json(config_path, config)

    weights_path = ROOT / "site/data/production-weights.json"
    weights = json.loads(weights_path.read_text(encoding="utf-8"))
    weights["prepared_at"] = "2026-10-01"
    weights["unit"] = "mixed_country_specific_units"
    weights["methodology"] = "泰国采用OAE 2025f省级生胶片产量/同版全国产量（68个正产量府）；印尼采用BPS 2024年省级干胶产量。泰国生胶片与全球干胶口径不等价，不计算泰国或跨国合计的全球占比。各府天气仅为单个模式网格样本。"
    weights["countries"]["泰国"] = {"reference_year": 2025, "data_type": "ESTIMATE", "quality_status": "WARNING",
        "production_t": total, "production_unit": "吨生胶片", "global_share_denominator_year": None,
        "methodology": "OAE《Agricultural Statistics of Thailand 2025》表5.9省级2025f生胶片产量；68个正产量府之和与同版全国合计一致。未列出府不补0；天气代表点不是府平均。"}
    d = weights["denominators"]
    d.update(thailand_2025_production_t=total, tracked_thailand_production_t=total,
             tracked_share_of_thailand_pct=100, thailand_share_of_world_pct=None,
             tracked_thailand_share_of_world_pct=None, tracked_share_of_world_pct=None)
    weights["sources"] = [source for source in weights["sources"] if not source["source_name"].startswith("Thailand")]
    weights["sources"].insert(0, {"source_name": "Thailand OAE Agricultural Statistics of Thailand 2025, table 5.9",
        "url": regions["sources"]["TH_OAE_2025"]["url"], "period": "2025f", "data_type": "ESTIMATE",
        "unit": "吨生胶片", "use": "泰国68个正产量府及全国合计", "quality_status": "WARNING",
        "note": regions["sources"]["TH_OAE_2025"]["access_note"]})
    weights["stations"] = {key: value for key, value in weights["stations"].items() if not key.startswith("th_")}
    for region, loc in zip(thai, new_locations):
        weights["stations"][loc["station_id"]] = {"province_code": region["province_code"],
            "province_name_en": features[region["province_code"]]["properties"]["shapeName"],
            "estimated_production_t": region["production_t"], "production_unit": "吨生胶片",
            "share_of_country_pct": round(100 * region["production_t"] / total, 4),
            "share_of_world_pct": None, "quality_status": "WARNING", "source_as_of": "2026-03"}
    write_json(weights_path, weights)

    geo = {"type": "FeatureCollection", "source": "geoBoundaries THA ADM1 gbOpen, version 9469f09, ODbL 1.0, boundaries 2017",
           "source_url": "https://www.geoboundaries.org/api/current/gbOpen/THA/ADM1/",
           "features": [{"type": "Feature", "properties": {"shapeISO": f["properties"]["shapeISO"], "shapeName": f["properties"]["shapeName"]},
                         "geometry": f["geometry"]} for f in source["features"]]}
    write_json(ROOT / "site/data/thailand-provinces.geojson", geo, compact=True)
    print(f"Synced {len(new_locations)} Thai weather points and weights, total {total} tons raw rubber sheet; {len(features)} borders")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("geojson", type=Path, help="Pinned geoBoundaries THA ADM1 simplified GeoJSON")
    main(parser.parse_args().geojson)
