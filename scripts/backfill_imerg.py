#!/usr/bin/env python3
"""回填IMERG卫星日降水点值存档（data/observations/imerg-daily.json）。

日常更新只补最近35天；本脚本用于一次性回填更早的历史，供：
  1) 过去7/14/30日窗口直接使用卫星实况；
  2) build_model_bias.py --source imerg 计算“IMERG/ERA5”逐月比例（需要至少约1–2年重叠）。

需要环境变量 NASA_PPS_EMAIL（NASA PPS 注册邮箱）。可断点续跑：已回填的日期跳过；
产品不存在（404，可能早于存档起点或版本号不同）的日期记入 unavailable 并在日志汇总。

用法：
    NASA_PPS_EMAIL=... python3 scripts/backfill_imerg.py --start 2024-01-01 --max-minutes 60
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import update_weather as uw  # noqa: E402


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=uw.ROOT / "config" / "locations.json")
    parser.add_argument("--start", default="2024-01-01")
    parser.add_argument("--end", default=None, help="默认昨天（UTC）")
    parser.add_argument("--max-minutes", type=float, default=60)
    parser.add_argument("--save-every", type=int, default=10)
    args = parser.parse_args(argv)

    email = os.environ.get("NASA_PPS_EMAIL", "").strip()
    if not email:
        print("NASA_PPS_EMAIL 未设置，无法下载IMERG。", file=sys.stderr)
        return 2
    locations = json.loads(args.config.read_text(encoding="utf-8"))["locations"]
    start = date.fromisoformat(args.start)
    end = date.fromisoformat(args.end) if args.end else datetime.now(timezone.utc).date() - timedelta(days=1)
    # 从近到远回填：先让最近的窗口完整
    days = [end - timedelta(days=i) for i in range((end - start).days + 1)]
    archive = uw.load_imerg_archive()
    deadline = time.monotonic() + args.max_minutes * 60
    total_added = total_unavailable = 0
    for i in range(0, len(days), args.save_every):
        if time.monotonic() > deadline:
            print("IMERG backfill: time budget reached; rerun to continue", file=sys.stderr)
            break
        chunk = days[i:i + args.save_every]
        try:
            added, unavailable = uw.update_imerg_archive(archive, locations, email, chunk, deadline=deadline)
        except Exception as exc:  # 网络等异常：保存已完成部分，稍后重试
            print(f"IMERG backfill warning at {chunk[0]}: {exc}", file=sys.stderr)
            time.sleep(30)
            continue
        total_added += added
        total_unavailable += unavailable
        uw._atomic_write(uw.IMERG_ARCHIVE_PATH,
                         json.dumps(archive, ensure_ascii=False, separators=(",", ":")) + "\n")
        print(f"IMERG backfill: {chunk[-1]}..{chunk[0]} +{added} days ({unavailable} unavailable)", file=sys.stderr)
    cov = archive.get("coverage") or {}
    versions = {}
    for v in (archive.get("versions") or {}).values():
        versions[v] = versions.get(v, 0) + 1
    print(f"IMERG backfill done: +{total_added} days this run, {total_unavailable} unavailable; "
          f"archive {cov.get('first_date')}..{cov.get('last_date')} ({cov.get('days')} days); versions {versions}",
          file=sys.stderr)
    wanted = {d.isoformat() for d in days}
    have = {d for values in archive.get("stations", {}).values() for d in values}
    missing = sorted(wanted - have - set(archive.get("unavailable", {})))
    return 1 if missing else 0


if __name__ == "__main__":
    raise SystemExit(main())
