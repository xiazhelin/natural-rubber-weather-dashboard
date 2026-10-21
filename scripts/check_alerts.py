#!/usr/bin/env python3
"""主产区天气异常的触发式提醒：读取 site/data/weather.json，按固定规则判断是否需要提醒。

规则（只针对“重点点位”：泰国/印尼占本国产量≥3%的府/省，以及暂无产量权重的越南、中国、科特迪瓦代表点）：
  HEAVY_7D     未来7日降雨 ≥ 150 mm，或强降雨日（≥25 mm）≥ 3 天
  WET_P90      未来7日高于常年第90百分位，且集合预报显著偏多概率 ≥ 40%
  DRY_P10_30D  过去30日低于常年第10百分位（常年 ≥ 60 mm，避开旱季）
  ENS_WET/ENS_DRY  区域（产量加权）集合预报偏多或偏少概率 ≥ 75%
天气信号只是筛选条件，不代表割胶、产量或价格结论。

去重：--state 指定上次状态文件（JSON），只有“新出现”的信号才算 new；输出写到 stdout（JSON），
并把本次全部信号写入 --write-state。
用法：
  python3 scripts/check_alerts.py --state prev.json --write-state now.json
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# 与 build_weather_report.py 相同的区域划分（复制而非导入，避免依赖 matplotlib）
TH_SOUTH_WEST = {"th_ranong", "th_phangnga", "th_phuket", "th_krabi", "th_south_trang", "th_satun"}


def group_of(st):
    c, r, sid = st["country"], st["region"], st["station_id"]
    if c == "泰国":
        if r == "南部":
            return "泰国南部西海岸" if sid in TH_SOUTH_WEST else "泰国南部东海岸"
        if r in ("中部", "东部"):
            return "泰国中东部"
        return "泰国" + r
    if c == "印度尼西亚":
        return "印尼(苏门答腊+西加)"
    if c == "中国":
        return "中国" + r
    return c

KEY_SHARE_PCT = 3.0
# 代表点权重尚不齐全的国家：全部代表点都算重点，区域汇总等权（越南目前仅2/4省有权重）
UNWEIGHTED_COUNTRIES = {"越南", "中国", "科特迪瓦"}


def key_station(station, weights):
    share = (weights.get(station["station_id"]) or {}).get("share_of_country_pct")
    if station["country"] in UNWEIGHTED_COUNTRIES:
        return True, share
    if share is not None:
        return share >= KEY_SHARE_PCT, share
    return station["country"] in UNWEIGHTED_COUNTRIES, None


def evaluate(weather, weights):
    thresholds = weather.get("thresholds") or {}
    heavy_total = thresholds.get("heavy_rain_total_7d_mm", 150)
    signals = []
    by_group = {}
    for st in weather.get("stations") or []:
        if st.get("quality_status") == "MISSING":
            continue
        is_key, share = key_station(st, weights)
        cc = st.get("climate_context") or {}
        sm = st.get("summary") or {}
        ens = cc.get("forecast_7d_ensemble") or {}
        w = share if (share is not None and st["country"] not in UNWEIGHTED_COUNTRIES) else 1.0
        by_group.setdefault(group_of(st), []).append((st, ens, w))
        if not is_key:
            continue
        base = {"station_id": st["station_id"], "place": st["place"], "country": st["country"],
                "region": st.get("region"), "share_of_country_pct": share}
        rain7 = sm.get("precipitation_7d_mm")
        heavy_days = sm.get("heavy_rain_days_7d") or 0
        if (rain7 is not None and rain7 >= heavy_total) or heavy_days >= 3:
            signals.append({**base, "rule": "HEAVY_7D", "detail": f"未来7日 {rain7:.0f} mm，强降雨日 {heavy_days} 天"})
        f7 = cc.get("forecast_7d") or {}
        if f7.get("category") == "ABOVE_P90" and (ens.get("prob_above_p90_pct") or 0) >= 40:
            signals.append({**base, "rule": "WET_P90",
                            "detail": f"未来7日 {f7['value_mm']:.0f} mm（常年 {f7['normal_mm']:.0f}），集合显著偏多概率 {ens['prob_above_p90_pct']}%"})
        p30 = cc.get("past_30d") or {}
        if p30.get("category") == "BELOW_P10" and (p30.get("normal_mm") or 0) >= 60:
            src = "卫星" if p30.get("source") == "IMERG" else "模式估算"
            signals.append({**base, "rule": "DRY_P10_30D",
                            "detail": f"过去30日 {p30['value_mm']:.0f} mm（常年 {p30['normal_mm']:.0f}，{src}）"})
    for group, items in by_group.items():
        valid = [(e, w) for _, e, w in items if e.get("quality_status") == "PASS"]
        if not valid:
            continue
        tw = sum(w for _, w in valid)
        up = sum(e["prob_above_normal_pct"] * w for e, w in valid) / tw
        down = sum(e["prob_below_normal_pct"] * w for e, w in valid) / tw
        if up >= 75:
            signals.append({"station_id": group, "place": group, "rule": "ENS_WET", "detail": f"区域集合偏多概率 {up:.0f}%（常年约33%）"})
        if down >= 75:
            signals.append({"station_id": group, "place": group, "rule": "ENS_DRY", "detail": f"区域集合偏少概率 {down:.0f}%（常年约33%）"})
    for s in signals:
        s["key"] = f"{s['station_id']}:{s['rule']}"
    signals.sort(key=lambda s: (-(s.get("share_of_country_pct") or 0), s["key"]))
    return signals


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--weather", type=Path, default=ROOT / "site" / "data" / "weather.json")
    parser.add_argument("--weights", type=Path, default=ROOT / "site" / "data" / "production-weights.json")
    parser.add_argument("--state", type=Path, default=None, help="上次的信号状态（JSON）；不存在视为空")
    parser.add_argument("--write-state", type=Path, default=None)
    args = parser.parse_args(argv)
    weather = json.loads(args.weather.read_text(encoding="utf-8"))
    weights = json.loads(args.weights.read_text(encoding="utf-8")).get("stations") or {}
    signals = evaluate(weather, weights)
    previous = set()
    if args.state and args.state.exists():
        previous = set(json.loads(args.state.read_text(encoding="utf-8")).get("active_keys") or [])
    new = [s for s in signals if s["key"] not in previous]
    cleared = sorted(previous - {s["key"] for s in signals})
    result = {"generated_at_utc": weather.get("generated_at_utc"), "signals": signals, "new": new, "cleared": cleared}
    if args.write_state:
        args.write_state.write_text(json.dumps({"generated_at_utc": weather.get("generated_at_utc"),
                                                "active_keys": [s["key"] for s in signals]}, ensure_ascii=False, indent=1),
                                    encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
