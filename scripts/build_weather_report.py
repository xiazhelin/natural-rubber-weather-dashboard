#!/usr/bin/env python3
"""天然橡胶产区天气简报：读取 site/data 下的静态 JSON，生成 PDF（3页）+ 首页 PNG + Markdown 要点。

用法：
    python3 scripts/build_weather_report.py                # 输出到 reports/<数据日期>/
    python3 scripts/build_weather_report.py --out some/dir
    python3 scripts/build_weather_report.py --commentary 点评.txt   # 点评印在第1页顶部，并写入 summary.md

口径说明（同样印在报告页脚）：
- 未来7日 = Open-Meteo 最新一期 D0–D6 预报累计；模式网格，不是地面站。
- 近7日估算 = 过去7个UTC日，每日取最近一期快照对该日的最短时效预报，再累计；是“短时效预报拼接”，不是实测。
- 区域值：泰国、印尼按省级产量占比加权；中国、越南、科特迪瓦无权重表，等权平均。
- 泰国周度对比 = ERA5 再分析代表点等权合成，同 ISO 周 2022–2025 均值作季节参照（样本仅4年）。
- 天气状态只是筛选条件，不代表割胶、产量或价格结论。
"""
from __future__ import annotations

import argparse
import textwrap
import json
import statistics
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import matplotlib
import matplotlib.patches
import numpy as np

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.backends.backend_pdf import PdfPages  # noqa: E402

def _cjk_fonts():
    from matplotlib import font_manager
    have = {f.name for f in font_manager.fontManager.ttflist}
    want = ["Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", "PingFang SC", "SimHei", "Arial Unicode MS"]
    return [f for f in want if f in have] + ["DejaVu Sans"]


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "site" / "data"
CLIMATE = ROOT / "site" / "assets" / "climate"
BJT = timezone(timedelta(hours=8))

plt.rcParams.update({
    "font.family": "sans-serif",
    "font.sans-serif": _cjk_fonts(),
    "axes.unicode_minus": False,
    "axes.spines.top": False,
    "axes.spines.right": False,
    "axes.edgecolor": "#9aa0a6",
    "axes.labelcolor": "#3c4043",
    "xtick.color": "#5f6368",
    "ytick.color": "#3c4043",
    "font.size": 8.5,
})

INK = "#202124"
MUTED = "#5f6368"
BLUE = "#2f6db5"
LIGHT = "#c9d7ea"
ORANGE = "#d9822b"
RED = "#c0392b"
GRID = "#e8eaed"

# 泰南东/西海岸划分（东北季风期 10–12 月以东海岸为主）
TH_SOUTH_WEST = {"th_ranong", "th_phangnga", "th_phuket", "th_krabi", "th_south_trang", "th_satun"}

# 按月份的通用物候背景（一般规律，供阅读参考，非本期数据结论）
PHENOLOGY = {
    1: "泰国、越南处于旺产后段；中国海南、云南停割期；泰国2月起陆续进入落叶停割。",
    2: "泰国、印尼部分产区落叶减产；中国产区停割。",
    3: "东南亚多处于低产/停割季，关注开割前的降雨与干旱。",
    4: "中国、泰国陆续开割，早期降雨决定开割节奏。",
    5: "主要产区开割，西南季风建立，关注泰国北部/东北部降雨是否及时。",
    6: "泰国、越南产量逐步上升；关注西南季风强度与持续降雨对割胶的干扰。",
    7: "雨季中段，重点看割胶窗口受雨天数与持续强降雨。",
    8: "雨季中段，重点看割胶窗口受雨天数与持续强降雨。",
    9: "泰国北部/东北部雨季尾声；关注台风与持续强降雨。",
    10: "泰国北部/东北部转入旱季，DRY 标记偏多属季节性；泰南东海岸进入东北季风雨季。",
    11: "泰南东海岸东北季风雨季高峰（宋卡、那空是贪玛叻、北大年一线）；中国产区陆续停割。",
    12: "泰南东海岸雨季尾段，洪涝风险仍在；中国产区停割，泰国、越南旺产。",
}


def load(name: str):
    return json.loads((DATA / name).read_text(encoding="utf-8"))


def parse_utc(text: str) -> datetime:
    return datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def group_of(st: dict) -> str:
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


GROUP_ORDER = [
    "泰国南部东海岸", "泰国南部西海岸", "泰国东北部", "泰国北部", "泰国中东部",
    "印尼(苏门答腊+西加)", "越南", "中国海南", "中国云南", "科特迪瓦",
]


def wavg(pairs):
    pairs = [(v, w) for v, w in pairs if v is not None]
    if not pairs:
        return None
    tw = sum(w for _, w in pairs)
    return sum(v * w for v, w in pairs) / tw if tw else None


ANOM_SHORT = {"BELOW_P10": "显著偏少", "BELOW_NORMAL": "偏少", "NEAR_NORMAL": "正常",
              "ABOVE_NORMAL": "偏多", "ABOVE_P90": "显著偏多"}


def group_anomaly(rs, key):
    """区域距平：加权当前值 / 加权常年均值 − 1（仅用两者都有的点位）。"""
    pairs = [((r["cc"].get(key) or {}).get("value_mm"), (r["cc"].get(key) or {}).get("normal_mm"), r["w"])
             for r in rs]
    pairs = [(v, n, w) for v, n, w in pairs if v is not None and n is not None]
    if not pairs:
        return {"value": None, "normal": None, "pct": None}
    tw = sum(w for *_, w in pairs)
    v = sum(v * w for v, _, w in pairs) / tw
    n = sum(n * w for _, n, w in pairs) / tw
    out = {"value": v, "normal": n, "pct": (v / n * 100 - 100) if n >= 3 else None}
    # 按百分位档位判断（降雨分布偏斜，均值百分比易误导）：产量加权的偏多/偏少点位占比
    cats = [((r["cc"].get(key) or {}).get("category"), r["w"]) for r in rs]
    cats = [(c, w) for c, w in cats if c]
    tw = sum(w for _, w in cats)
    if tw:
        above = sum(w for c, w in cats if c in ("ABOVE_NORMAL", "ABOVE_P90")) / tw
        below = sum(w for c, w in cats if c in ("BELOW_NORMAL", "BELOW_P10")) / tw
        extreme_above = sum(w for c, w in cats if c == "ABOVE_P90") / tw
        extreme_below = sum(w for c, w in cats if c == "BELOW_P10") / tw
        if above >= 0.5:
            label = "显著偏多" if extreme_above >= 0.3 else "偏多"
        elif below >= 0.5:
            label = "显著偏少" if extreme_below >= 0.3 else "偏少"
        elif above >= 0.3 and below >= 0.3:
            label = "分化"
        else:
            label = "正常"
        out.update({"label": label, "above_share": above, "below_share": below})
    else:
        out.update({"label": None, "above_share": None, "below_share": None})
    return out


def past7_estimate(history: dict, station_ids, start: date) -> dict:
    """过去7个UTC日：每天取最近一期快照对该日的预报值（时效最短）。"""
    days = [(start - timedelta(days=i)).isoformat() for i in range(7, 0, -1)]
    best = {}  # (sid, day) -> (generated, value)
    for snap in history["snapshots"]:
        gen = snap["generated_at_utc"]
        for st in snap["stations"]:
            for row in st.get("forecast_utc_daily") or []:
                key = (st["station_id"], row["date_utc"])
                if row["date_utc"] in days and row.get("precipitation_mm") is not None:
                    if key not in best or gen > best[key][0]:
                        best[key] = (gen, row["precipitation_mm"])
    out = {}
    for sid in station_ids:
        vals = [best.get((sid, d)) for d in days]
        out[sid] = round(sum(v[1] for v in vals), 1) if all(vals) else None
    return out


def build(out_dir: Path, commentary: str | None = None) -> dict:
    wx = load("weather.json")
    hist = load("history.json")
    weights = load("production-weights.json")["stations"]
    thw = load("thailand-weekly-rain.json")
    th = wx["thresholds"]

    gen = parse_utc(wx["generated_at_utc"])
    stations = [s for s in wx["stations"] if s.get("quality_status") != "MISSING"]
    first_day = date.fromisoformat(stations[0]["daily"][0]["date"])
    last_day = date.fromisoformat(stations[0]["daily"][-1]["date"])
    fstart = date.fromisoformat(stations[0]["forecast_utc_daily"][0]["date_utc"])
    past7 = past7_estimate(hist, [s["station_id"] for s in stations], fstart)

    bias_ok = ((wx.get("climate_context_definition") or {}).get("bias_correction") or {}).get("status") == "PASS"
    has_clim = any((s.get("climate_context") or {}).get("quality_status") in ("PASS", "WARNING") for s in stations)
    if has_clim:  # 有 past_days 数据时，用它替代“短时效预报拼接”
        for s in stations:
            v = ((s.get("climate_context") or {}).get("past_7d") or {}).get("value_mm")
            if v is not None:
                past7[s["station_id"]] = v

    def w_of(s):
        return (weights.get(s["station_id"]) or {}).get("share_of_country_pct") or 1.0

    # ---- 站点行 ----
    rows = []
    for s in stations:
        sm = s["summary"]
        rows.append({
            "sid": s["station_id"], "country": s["country"], "place": s["place"], "group": group_of(s), "region": s["region"],
            "w": w_of(s), "share": (weights.get(s["station_id"]) or {}).get("share_of_country_pct"),
            "rain7": sm.get("precipitation_7d_mm"), "past7": past7.get(s["station_id"]),
            "heavy_days": sm.get("heavy_rain_days_7d"), "rain_days": sm.get("rain_days_7d"),
            "tap_days": sm.get("tapping_window_rain_days_7d"), "tmax": sm.get("temperature_max_7d_c"),
            "states": sm.get("weather_states") or [],
            "imerg72": (s.get("imerg") or {}).get("precipitation_72h_mm"),
            "cc": s.get("climate_context") or {},
        })

    # ---- 区域聚合 ----
    groups = []
    for g in GROUP_ORDER:
        rs = [r for r in rows if r["group"] == g]
        if not rs:
            continue
        groups.append({
            "group": g, "n": len(rs),
            "rain7": wavg([(r["rain7"], r["w"]) for r in rs]),
            "past7": wavg([(r["past7"], r["w"]) for r in rs]),
            "tap_days": wavg([(r["tap_days"], r["w"]) for r in rs]),
            "heavy_days": wavg([(r["heavy_days"], r["w"]) for r in rs]),
            "weighted": rs[0]["country"] in ("泰国", "印度尼西亚"),
            **{f"{k}_{f}": v for k in ("forecast_7d", "past_7d", "past_30d")
               for f, v in group_anomaly(rs, k).items()},
        })

    # ---- 泰国周度 vs 同周均值 ----
    th_regions = {r["region_id"]: r for r in thw["regions"]}
    th_panels = []
    for rid in ("th_south_east_coast", "th_south_west_coast", "th_northeast", "th_north"):
        reg = th_regions.get(rid)
        if not reg:
            continue
        wk = reg["weekly"]
        clim = {}
        for row in wk:
            if row["iso_year"] < wk[-1]["iso_year"] and row.get("precipitation_mm") is not None:
                clim.setdefault(row["iso_week"], []).append(row["precipitation_mm"])
        recent = wk[-12:]
        th_panels.append({
            "name": reg["name"].replace("泰国", ""),
            "weeks": [r["week_start"][5:] for r in recent],
            "vals": [r["precipitation_mm"] for r in recent],
            "mean": [statistics.mean(clim[r["iso_week"]]) if clim.get(r["iso_week"]) else None for r in recent],
            "lo": [min(clim[r["iso_week"]]) if clim.get(r["iso_week"]) else None for r in recent],
            "hi": [max(clim[r["iso_week"]]) if clim.get(r["iso_week"]) else None for r in recent],
            "last": recent[-1],
            "last4": sum(r["precipitation_mm"] for r in recent[-4:]),
            "last4_mean": sum(statistics.mean(clim[r["iso_week"]]) for r in recent[-4:] if clim.get(r["iso_week"])),
        })

    # ---- 关注清单 ----
    flagged = []
    for r in rows:
        why = []
        if "HEAVY_RAIN" in r["states"]:
            why.append(f"7日≥{th['heavy_rain_total_7d_mm']}mm")
        if (r["heavy_days"] or 0) >= 2:
            why.append(f"暴雨日{r['heavy_days']}天")
        if (r["tap_days"] or 0) >= 5:
            why.append(f"割胶窗受雨{r['tap_days']}天")
        if "HEAT" in r["states"]:
            why.append(f"最高温{r['tmax']:.0f}℃")
        f7 = r["cc"].get("forecast_7d") or {}
        if f7.get("category") in ("ABOVE_P90", "BELOW_P10") and (f7.get("normal_mm") or 0) >= 10:
            why.append(f"7日{ANOM_SHORT[f7['category']]}")
        p30 = r["cc"].get("past_30d") or {}
        if p30.get("category") in ("ABOVE_P90", "BELOW_P10") and (p30.get("normal_mm") or 0) >= 30:
            why.append(f"近30日{ANOM_SHORT[p30['category']]}")
        if why:
            flagged.append({**r, "why": "；".join(why)})
    flagged.sort(key=lambda r: (-(r["share"] or 0), -(r["rain7"] or 0)))
    dry_count = sum("DRY" in r["states"] for r in rows)
    dry_weighted = [r for r in rows if "DRY" in r["states"] and (r["share"] or 0) >= 3]

    # ---- 文字要点 ----
    bullets = []
    gsort = sorted([g for g in groups if g["rain7"] is not None], key=lambda g: -g["rain7"])
    top = gsort[:2]
    bullets.append("未来7日降雨最多：" + "、".join(
        f"{g['group']} {g['rain7']:.0f}mm（近7日估算{g['past7']:.0f}mm）" if g["past7"] is not None
        else f"{g['group']} {g['rain7']:.0f}mm" for g in top) + "。")
    shifts = [g for g in groups if g["rain7"] is not None and g["past7"] is not None]
    wetter = [g for g in shifts if g["rain7"] - g["past7"] >= 30 and g["rain7"] >= 1.5 * max(g["past7"], 1)]
    drier = [g for g in shifts if g["past7"] - g["rain7"] >= 30 and g["rain7"] <= 0.6 * g["past7"]]
    if has_clim:
        pass  # 有季节基准时，“转湿/转干”由下面的距平要点覆盖
    elif wetter or drier:
        parts = []
        if wetter:
            parts.append("转湿：" + "、".join(f"{g['group']}（{g['past7']:.0f}→{g['rain7']:.0f}mm）" for g in wetter))
        if drier:
            parts.append("转干：" + "、".join(f"{g['group']}（{g['past7']:.0f}→{g['rain7']:.0f}mm）" for g in drier))
        bullets.append("与近7日相比，" + "；".join(parts) + "。")
    else:
        bullets.append("各区域未来7日与近7日相比无明显转湿/转干（差值<30mm或<50%）。")
    first = bullets[0]
    if has_clim:
        bullets[0] = first.replace("近7日估算", "近7日")
    if has_clim:
        def lab(g, k):
            share = g[k + "_above_share"] if "多" in g[k + "_label"] else g[k + "_below_share"]
            return f"{g['group']}（{g[k + '_label']}，{share:.0%}产量权重）"
        f_wet = [g for g in groups if (g.get("forecast_7d_label") or "").endswith("偏多")]
        f_dry = [g for g in groups if (g.get("forecast_7d_label") or "").endswith("偏少")]
        parts = []
        if f_wet:
            parts.append("偏多：" + "、".join(lab(g, "forecast_7d") for g in f_wet))
        if f_dry:
            parts.append("偏少：" + "、".join(lab(g, "forecast_7d") for g in f_dry))
        bullets.append("未来7日与常年同期相比（按历年同期百分位），" + ("；".join(parts) if parts else "各区域多数点位处于常年正常区间") + "。")
        p_wet = [g for g in groups if (g.get("past_30d_label") or "").endswith("偏多")]
        p_dry = [g for g in groups if (g.get("past_30d_label") or "").endswith("偏少")]
        if p_wet or p_dry:
            parts = []
            if p_wet:
                parts.append("偏湿：" + "、".join(lab(g, "past_30d") for g in p_wet))
            if p_dry:
                parts.append("偏干：" + "、".join(lab(g, "past_30d") for g in p_dry))
            srcs = [(r["cc"].get("past_30d") or {}).get("source") for r in rows]
            n_sat = sum(x == "IMERG" for x in srcs)
            src_label = ("卫星实况" if n_sat == len(srcs) else
                         ("模式估算" if n_sat == 0 else f"{n_sat}/{len(srcs)}点为卫星实况，其余模式估算"))
            bullets.append(f"过去30日累计（{src_label}）" + "；".join(parts) + "。")
    tap = [g for g in groups if (g["tap_days"] or 0) >= 3.5]
    if tap:
        bullets.append("割胶窗口（当地02–10时）受雨偏多：" + "、".join(
            f"{g['group']} 平均{g['tap_days']:.1f}/7天" for g in sorted(tap, key=lambda g: -g["tap_days"])) + "。")
    else:
        bullets.append("各区域割胶窗口受雨天数平均均低于3.5/7天，早间割胶干扰有限。")
    for p in th_panels:
        if p["name"] == "南部东海岸":
            diff = p["last4"] - p["last4_mean"]
            bullets.append(
                f"泰南东海岸近4周ERA5累计{p['last4']:.0f}mm，较2022–25同期均值{p['last4_mean']:.0f}mm"
                f"{'偏多' if diff >= 0 else '偏少'}{abs(diff):.0f}mm（截至{p['last']['week_end']}）。")
    if flagged:
        heavy = [f for f in flagged if "7日≥" in f["why"] or "暴雨日" in f["why"]]
        if heavy:
            bullets.append("强降雨点位：" + "、".join(
                f"{f['place']}（{f['rain7']:.0f}mm" + (f"，占本国{f['share']:.1f}%" if f["share"] else "") + "）"
                for f in heavy[:5]) + "。")
        heat = [f for f in flagged if "最高温" in f["why"]]
        if heat:
            bullets.append("高温点位：" + "、".join(f"{f['place']}（{f['tmax']:.0f}℃）" for f in heat[:5]) + "。")
    if not has_clim:
        bullets.append(f"DRY（7日<{th['dry_total_7d_mm']}mm）{dry_count}/{len(rows)}个点位"
                       + (f"，其中占本国≥3%的有{len(dry_weighted)}个（" + "、".join(r["place"] for r in dry_weighted[:6]) + "）"
                          if dry_weighted else "") + "。")
    month = first_day.month
    phen = PHENOLOGY.get(month, "")

    # ================= 绘图 =================
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = gen.astimezone(BJT)
    title = "天然橡胶产区天气简报"
    sub = (f"预报期 {first_day:%m/%d}–{last_day:%m/%d}（D0–D6）｜数据生成 {stamp:%Y-%m-%d %H:%M} 北京时间｜"
           f"{len(rows)}个代表网格点｜质量 {wx['overall_quality_status']}")
    foot = ("口径：Open-Meteo模式网格预报，非地面站；近7日" + ("=NASA IMERG卫星实况（不全时用Open-Meteo模式估算）" if has_clim else "估算=每日最短时效预报拼接") + "，非实测；"
            + (("常年同期=同点ERA5 2001–25同季节均值，已按2022–25重叠期逐月换算到模式口径，距平仅作筛选；" if bias_ok
              else "常年同期=同点ERA5 2001–25同季节均值，未做模式偏差校正，距平仅作筛选；") if has_clim else "") + "泰国、印尼按省级产量占比加权，"
            "其余等权；泰国周度为ERA5代表点合成，季节参照仅2022–25四年。天气状态仅为筛选条件，不代表割胶、产量或价格结论。")
    pdf_path = out_dir / f"天然橡胶产区天气简报_{first_day:%Y%m%d}.pdf"
    png_path = out_dir / f"天然橡胶产区天气简报_{first_day:%Y%m%d}.png"

    A4 = (8.27, 11.69)

    # ---------- 第1页 ----------
    fig1 = plt.figure(figsize=A4)
    fig1.text(0.06, 0.965, title, fontsize=17, weight="bold", color=INK)
    fig1.text(0.06, 0.945, sub, fontsize=7.5, color=MUTED)

    y = 0.918
    # 点评（可选）
    if commentary:
        c_lines = []
        for para in [p.strip() for p in commentary.strip().splitlines() if p.strip()]:
            bullet = para.startswith(("- ", "• ", "* "))
            text = para[2:].strip() if bullet else para
            for i, ln in enumerate(textwrap.wrap(text, 56, break_on_hyphens=False)):
                c_lines.append((("• " if i == 0 else "   ") if bullet else "") + ln)
        box_h = 0.026 + 0.0168 * len(c_lines) + 0.008
        fig1.patches.append(matplotlib.patches.FancyBboxPatch(
            (0.05, y - box_h + 0.012), 0.90, box_h, boxstyle="round,pad=0.004,rounding_size=0.006",
            transform=fig1.transFigure, facecolor="#eef3fa", edgecolor="#c9d7ea", lw=0.8, zorder=0))
        fig1.text(0.065, y, "本期点评", fontsize=10.5, weight="bold", color=BLUE)
        y -= 0.022
        for ln in c_lines:
            fig1.text(0.068, y, ln, fontsize=8.7, color=INK)
            y -= 0.0168
        y -= 0.022
    # 要点
    fig1.text(0.06, y, "本期要点（自动生成）" if commentary else "本期要点", fontsize=10.5, weight="bold", color=INK)
    y -= 0.022
    for b in bullets:
        lines = textwrap.wrap(b, 58, break_on_hyphens=False)
        for i, ln in enumerate(lines):
            fig1.text(0.065, y, ("• " if i == 0 else "   ") + ln, fontsize=8.6, color=INK)
            y -= 0.0165
        y -= 0.003
    if phen:
        fig1.text(0.065, y, f"季节背景（{month}月一般规律）：{phen}", fontsize=7.6, color=MUTED, style="italic")
        y -= 0.02

    # 图表区按剩余高度等比缩放
    need = 0.015 + 0.225 + 0.075 + 0.175
    k_s = min(1.3, (y - 0.125) / need)
    hA, hB = 0.215 * k_s, 0.165 * k_s
    # 图A：区域未来7日 vs 近7日
    axA_top = y - 0.015
    axA = fig1.add_axes([0.25, axA_top - hA - 0.01, 0.70, hA])
    gl = groups[::-1]
    ys = range(len(gl))
    axA.barh(list(ys), [g["rain7"] or 0 for g in gl], color=BLUE, height=0.55, label="未来7日预报", zorder=2)
    axA.scatter([g["past7"] for g in gl if g["past7"] is not None],
                [i for i, g in enumerate(gl) if g["past7"] is not None],
                marker="|", s=260, linewidths=2.2, color=ORANGE, label="近7日" if has_clim else "近7日估算", zorder=3)
    if has_clim:
        nx = [(g["forecast_7d_normal"], i) for i, g in enumerate(gl) if g["forecast_7d_normal"] is not None]
        axA.scatter([x for x, _ in nx], [i for _, i in nx], marker="D", s=22, color="#5f6368",
                    label="常年同期", zorder=4)
    for i, g in enumerate(gl):
        lab = f"{g['rain7']:.0f}"
        if has_clim and g.get("forecast_7d_label"):
            lab += f"（{g['forecast_7d_label']}）"
        axA.text(max(g["rain7"] or 0, g.get("forecast_7d_normal") or 0, g["past7"] or 0) + 2, i, lab,
                 va="center", fontsize=7.5, color=INK)
    axA.set_yticks(list(ys))
    axA.set_yticklabels([g["group"] + ("" if g["weighted"] else "*") for g in gl])
    axA.axvline(th["heavy_rain_total_7d_mm"], color=RED, lw=0.8, ls="--", zorder=1)
    axA.text(th["heavy_rain_total_7d_mm"], len(gl) - 0.4, f" {th['heavy_rain_total_7d_mm']}mm", color=RED, fontsize=7)
    axA.grid(axis="x", color=GRID, zorder=0)
    axA.set_xlabel("mm")
    axA.set_xlim(0, max(th["heavy_rain_total_7d_mm"] + 20, max((g["rain7"] or 0) for g in gl) * 1.15,
                        max((g["past7"] or 0) for g in gl) * 1.1,
                        max((g.get("forecast_7d_normal") or 0) for g in gl) * 1.25))
    axA.legend(loc="lower right", bbox_to_anchor=(1.0, 1.0), ncol=3, fontsize=7.5, frameon=False)
    fig1.text(0.06, axA_top + 0.008, ("① 分区降雨：未来7日/近7日/常年均值（括号=历年同期档位，*等权）" if has_clim else "① 分区降雨：未来7日 vs 近7日（*为等权平均）"), fontsize=10, weight="bold", color=INK)

    # 图B：割胶窗口受雨天数
    yB = axA_top - hA - 0.01 - 0.065
    axB = fig1.add_axes([0.25, yB - hB - 0.01, 0.70, hB])
    vals = [g["tap_days"] or 0 for g in gl]
    axB.barh(list(ys), vals, color=[ORANGE if v >= 3.5 else LIGHT for v in vals], height=0.55, zorder=2)
    for i, v in enumerate(vals):
        axB.text(v + 0.08, i, f"{v:.1f}", va="center", fontsize=7.5, color=INK)
    axB.set_yticks(list(ys))
    axB.set_yticklabels([g["group"] for g in gl])
    axB.set_xlim(0, 7)
    axB.set_xlabel("天（满7）")
    axB.grid(axis="x", color=GRID, zorder=0)
    fig1.text(0.06, yB + 0.008, "② 未来7日割胶窗口（当地02–10时）受雨天数，橙色≥3.5天", fontsize=10, weight="bold", color=INK)

    # 图C（第3页上半）：泰国周度 vs 同周均值
    fig3 = plt.figure(figsize=A4)
    fig3.text(0.06, 0.965, "季节对比与中期展望", fontsize=14, weight="bold", color=INK)
    yC = 0.925
    fig3.text(0.06, yC + 0.008, "③ 泰国分区周降雨（ERA5，近12周）vs 2022–25同周均值/区间", fontsize=10, weight="bold", color=INK)
    pw = 0.205
    for k, p in enumerate(th_panels):
        ax = fig3.add_axes([0.08 + (k % 2) * 0.46, yC - 0.035 - 0.17 - (k // 2) * 0.215, 0.40, 0.17])
        x = range(len(p["vals"]))
        lo = [v if v is not None else 0 for v in p["lo"]]
        hi = [v if v is not None else 0 for v in p["hi"]]
        ax.fill_between(list(x), lo, hi, color=LIGHT, alpha=0.6, lw=0, label="22–25区间")
        ax.plot(list(x), p["mean"], color=MUTED, lw=1, ls="--", label="22–25均值")
        ax.bar(list(x), p["vals"], color=BLUE, width=0.6, label="2026")
        ax.set_title(p["name"], fontsize=8.5, color=INK, pad=3)
        ax.set_xticks([0, len(p["vals"]) - 1])
        ax.set_xticklabels([p["weeks"][0], p["weeks"][-1]], fontsize=6.5)
        ax.tick_params(axis="y", labelsize=6.5)
        ax.grid(axis="y", color=GRID)
        if k == 0:
            ax.set_ylabel("mm/周", fontsize=7)
            ax.legend(fontsize=6, frameon=False, loc="upper left")
    fig1.text(0.06, 0.035, "\n".join(textwrap.wrap(foot, 92)), fontsize=6.3, color=MUTED, va="bottom")

    # ---------- 第2页 ----------
    fig2 = plt.figure(figsize=A4)
    fig2.text(0.06, 0.965, "关注点位明细", fontsize=14, weight="bold", color=INK)
    fig2.text(0.06, 0.947, ("筛选：7日累计≥150mm、暴雨日（≥25mm）≥2天、割胶窗受雨≥5天、最高温≥35℃"
              + ("、未来7日或近30日低于常年P10/高于P90" if has_clim else "") + "；按占本国产量排序。"),
              fontsize=7.5, color=MUTED)
    MAXROWS = 16
    cols = ["国家", "点位", "区域", "占本国%", "未来7日mm", "近7日mm" if has_clim else "近7日估算mm", "IMERG 72h", "关注原因"]
    table_rows = [[f["country"].replace("印度尼西亚", "印尼"), f["place"], f["region"],
                   f"{f['share']:.1f}" if f["share"] else "-",
                   f"{f['rain7']:.0f}" if f["rain7"] is not None else "-",
                   f"{f['past7']:.0f}" if f["past7"] is not None else "-",
                   f"{f['imerg72']:.0f}" if f["imerg72"] is not None else "-",
                   f["why"]] for f in flagged[:MAXROWS]]
    if not table_rows:
        table_rows = [["-", "本期无点位触发筛选条件", "", "", "", "", "", ""]]
    n = len(table_rows)
    th_h = 0.022 * (n + 1)
    axT = fig2.add_axes([0.05, 0.93 - th_h, 0.90, th_h])
    axT.axis("off")
    tb = axT.table(cellText=table_rows, colLabels=cols, bbox=[0, 0, 1, 1], cellLoc="center",
                   colWidths=[0.06, 0.09, 0.10, 0.07, 0.08, 0.09, 0.08, 0.43])
    tb.auto_set_font_size(False)
    tb.set_fontsize(7.3)
    for (r, c), cell in tb.get_celld().items():
        cell.set_edgecolor(GRID)
        if r == 0:
            cell.set_facecolor("#f1f3f4")
            cell.set_text_props(weight="bold")
        if c == 7 and r > 0:
            cell._loc = "left"
    if len(flagged) > MAXROWS:
        fig2.text(0.06, 0.925 - th_h - 0.012, f"另有{len(flagged) - MAXROWS}个点位未列出，见网页面板。", fontsize=7, color=MUTED)

    # 产量权重前12点位概览
    yT2 = 0.925 - th_h - 0.05
    fig2.text(0.06, yT2, "重点产区（占本国≥4%）未来7日逐日降雨 mm", fontsize=10.5, weight="bold", color=INK)
    key = sorted([s for s in stations if (weights.get(s["station_id"]) or {}).get("share_of_country_pct", 0) >= 4],
                 key=lambda s: -weights[s["station_id"]]["share_of_country_pct"])[:12]
    if key:
        mat = [[d.get("precipitation_sum") for d in s["daily"]] for s in key]
        hh = 0.022 * len(key)
        axH = fig2.add_axes([0.22, yT2 - 0.015 - hh, 0.62, hh])
        arr = np.array([[v if v is not None else np.nan for v in row] for row in mat], dtype=float)
        axH.imshow(arr, aspect="auto", cmap="Blues", vmin=0, vmax=40)
        for i in range(arr.shape[0]):
            for j in range(arr.shape[1]):
                v = arr[i, j]
                if not np.isnan(v):
                    axH.text(j, i, f"{v:.0f}", ha="center", va="center", fontsize=7,
                             color="white" if v > 25 else INK)
        axH.set_yticks(range(len(key)))
        axH.set_yticklabels([f"{s['place']}（{s['country'][:2]} {weights[s['station_id']]['share_of_country_pct']:.1f}%）"
                             for s in key], fontsize=7.5)
        axH.set_xticks(range(arr.shape[1]))
        axH.set_xticklabels([d["date"][5:] for d in key[0]["daily"]], fontsize=7.5)
        axH.tick_params(length=0)
        for sp in axH.spines.values():
            sp.set_visible(False)
        yG = yT2 - 0.015 - hh - 0.04
    else:
        yG = yT2 - 0.04

    fig2.text(0.06, 0.035, "\n".join(textwrap.wrap(foot, 92)), fontsize=6.3, color=MUTED, va="bottom")


    # ---------- 第3页下半：中期展望 ----------
    yG = 0.47
    gth = CLIMATE / "gth-outlook.png"
    if gth.exists():
        man = json.loads((CLIMATE / "climate-outlook-manifest.json").read_text(encoding="utf-8"))["products"]["gth"]
        fig3.text(0.06, yG, f"NOAA/CPC 第2–3周全球热带危险展望｜发布{man.get('issued')}｜有效期{'、'.join(man.get('valid_periods') or [])}",
                  fontsize=9.5, color=INK)
        img = plt.imread(gth)
        ratio = img.shape[0] / img.shape[1]
        hfig = min(0.88 * ratio * A4[0] / A4[1], yG - 0.11)
        wfig = hfig / ratio * A4[1] / A4[0]
        axI = fig3.add_axes([0.06, yG - 0.012 - hfig, wfig, hfig])
        axI.imshow(img)
        axI.axis("off")
        fig3.text(0.06, yG - 0.03 - hfig, "说明：图为NOAA官方产品原图（ESTIMATE），仅作第2–3周热带降水/气旋风险背景；以官方图内图例与有效期为准。",
                  fontsize=7.5, color=MUTED)
    fig3.text(0.06, 0.035, "\n".join(textwrap.wrap(foot, 92)), fontsize=6.3, color=MUTED, va="bottom")

    with PdfPages(pdf_path) as pdf:
        pdf.savefig(fig1)
        pdf.savefig(fig2)
        pdf.savefig(fig3)
    fig1.savefig(png_path, dpi=170)
    plt.close("all")

    md = [f"# {title}（{first_day:%Y-%m-%d}）", "", sub, ""]
    if commentary:
        md += ["## 点评", commentary.strip(), ""]
    md += ["## 要点（自动生成）" if commentary else "## 要点", *[f"- {b}" for b in bullets]]
    if phen:
        md += ["", f"季节背景（{month}月一般规律）：{phen}"]
    def _pct(v):
        return "" if v is None else f"{v:+.0f}%"
    md += ["", "## 分区", "| 区域 | 未来7日mm | 较常年（档位/均值%） | 近7日mm | 近30日较常年 | 割胶窗受雨天 |", "|---|---|---|---|---|---|"]
    md += [f"| {g['group']} | {g['rain7']:.0f} | {g.get('forecast_7d_label') or ''} {_pct(g.get('forecast_7d_pct'))} | {'' if g['past7'] is None else format(g['past7'], '.0f')} | {g.get('past_30d_label') or ''} {_pct(g.get('past_30d_pct'))} | {g['tap_days']:.1f} |"
           for g in groups]
    md += ["", foot]
    (out_dir / "summary.md").write_text("\n".join(md), encoding="utf-8")
    return {"pdf": str(pdf_path), "png": str(png_path), "bullets": bullets, "groups": groups}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=None)
    ap.add_argument("--commentary", default=None, help="点评文本文件（UTF-8），每行一句；以“- ”开头的行显示为分点")
    args = ap.parse_args()
    commentary = Path(args.commentary).read_text(encoding="utf-8") if args.commentary else None
    wx = load("weather.json")
    d0 = wx["stations"][0]["daily"][0]["date"]
    out = Path(args.out) if args.out else ROOT / "reports" / d0
    res = build(out, commentary)
    print(res["pdf"])
    print(res["png"])
    for b in res["bullets"]:
        print("-", b)


if __name__ == "__main__":
    main()
