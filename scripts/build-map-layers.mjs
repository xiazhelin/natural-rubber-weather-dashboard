#!/usr/bin/env node
// 构建网页地图图层：把精细行政区界线预处理成紧凑的 TopoJSON，写入 site/data/maps/。
//
// 原始数据体积大（泰国约35MB），不进仓库；放在本地“地图数据 geojson”文件夹（或 --src 指定的目录），
// 只有处理结果进仓库。每次新增/移动代表点或更换界线数据后重跑一次即可。
//
// 依赖：npm i mapshaper@0.6.102（只在构建时需要，网页运行时不需要）
// 用法：node scripts/build-map-layers.mjs --src "地图数据 geojson" --ne <Natural Earth 目录>
//
// 输出：
//   site/data/maps/asia.topo.json    objects: land（周边国家陆地）、admin（泰/印尼/越/中南部省界）
//   site/data/maps/africa.topo.json  objects: land、admin（科特迪瓦大区）
// 每个 admin 要素带：country、name、iso（若有）、station_ids（落在该区内的代表点，空间连接计算）。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mapshaper from "mapshaper";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, value, index, list) => {
  if (value.startsWith("--")) acc.push([value.slice(2), list[index + 1]]);
  return acc;
}, []));
const SRC = path.resolve(args.src || path.join(ROOT, "地图数据 geojson"));
const NE = path.resolve(args.ne || SRC);
const OUT = path.join(ROOT, "site", "data", "maps");
const TMP = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "maplayers-"));

const REGIONS = {
  asia: { bbox: [92, -10, 118, 27], countries: ["泰国", "印度尼西亚", "越南", "中国"] },
  africa: { bbox: [-10, 3, 0.5, 11], countries: ["科特迪瓦"] },
};

function need(file) {
  const full = path.join(SRC, file);
  if (!fs.existsSync(full)) throw new Error(`缺少原始数据：${full}`);
  return full;
}

function needNe(file) {
  const full = path.join(NE, file);
  if (!fs.existsSync(full)) throw new Error(`缺少 Natural Earth 数据：${full}（用 --ne 指定目录）`);
  return full;
}

async function run(command) {
  await mapshaper.runCommands(command);
}

const q = (value) => JSON.stringify(value);

// 1) 各国行政区：统一字段 country / name / iso，并适度简化（Visvalingam，保留形状）
async function buildAdmin() {
  const parts = [];
  const steps = [
    // 泰国 OCHA COD-AB 2019（77府）：ADM1_PCODE 如 TH90 → ISO 3166-2 TH-90
    [need("tha_admbnda_adm1_rtsd_20190221.shp"),
      `-each 'country="泰国", name=ADM1_EN, name_local=ADM1_TH, iso=ADM1_PCODE.replace(/^TH/, "TH-")' -filter-fields country,name,name_local,iso`, "th"],
    // 印尼 BAKOSURTANAL 1:250,000 省界（32省旧划分；橡胶主产的苏门答腊、西加里曼丹省界未变）
    [need("indonesia-province.json"),
      `-each 'country="印度尼西亚", name=Propinsi, iso=""' -filter-fields country,name,iso`, "id"],
    // 越南 63省（2025年7月合并前划分）
    [need("diaphantinhenglish.geojson"),
      `-each 'country="越南", name=Name, iso=""' -filter-fields country,name,iso`, "vn"],
  ];
  for (const [file, each, key] of steps) {
    const out = path.join(TMP, `${key}.json`);
    await run(`-i ${q(file)} snap -proj wgs84 ${each} -simplify 6% weighted keep-shapes -clean -o ${q(out)} format=geojson`);
    parts.push(out);
  }
  // 中国南部省份（Natural Earth 1:10m 中国观点版 admin-1）
  const cn = path.join(TMP, "cn.json");
  await run(`-i ${q(needNe("ne_10m_admin_1_states_provinces.geojson"))} -filter 'adm0_a3==="CHN" && ["Hainan","Yunnan","Guangxi","Guangdong"].indexOf(name)>-1' -each 'country="中国", name=name, iso=iso_3166_2' -filter-fields country,name,iso -simplify 12% weighted keep-shapes -o ${q(cn)} format=geojson`);
  parts.push(cn);
  // 科特迪瓦 OCHA COD-AB 2016 二级区（33个大区）
  const ci = path.join(TMP, "ci.json");
  await run(`-i ${q(need("civ/civ_admbnda_adm2_cntig_20160527.shp"))} snap -proj wgs84 -each 'country="科特迪瓦", name=admin2Name, iso=admin2Pcod' -filter-fields country,name,iso -simplify 10% weighted keep-shapes -clean -o ${q(ci)} format=geojson`);
  parts.push(ci);
  return parts;
}

// 2) 代表点 → 空间连接到所在行政区
function stationsGeojson() {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "locations.json"), "utf8"));
  const features = config.locations.map((loc) => ({
    type: "Feature",
    properties: { station_id: loc.station_id },
    geometry: { type: "Point", coordinates: [loc.longitude, loc.latitude] },
  }));
  const file = path.join(TMP, "stations.json");
  fs.writeFileSync(file, JSON.stringify({ type: "FeatureCollection", features }));
  return file;
}

async function buildRegion(key, adminParts, stationsFile) {
  const { bbox } = REGIONS[key];
  const box = bbox.join(",");
  const land = path.join(TMP, `${key}-land.json`);
  // 周边陆地：Natural Earth 1:10m 国家（中国观点版），裁剪到视窗并简化；只画轮廓，不标国名
  await run(`-i ${q(needNe("ne_10m_admin_0_countries_chn.geojson"))} -clip bbox=${box} -filter-fields ADM0_A3 -rename-fields a3=ADM0_A3 -simplify 15% weighted keep-shapes -o ${q(land)} format=geojson`);
  const admin = path.join(TMP, `${key}-admin.json`);
  const files = adminParts.map((p) => q(p)).join(" ");
  await run(`-i ${files} combine-files -merge-layers force -clip bbox=${box} -join ${q(stationsFile)} calc='station_ids=collect(station_id)' -each 'station_ids = Array.isArray(station_ids) ? station_ids.join(",") : (station_ids || "")' -o ${q(admin)} format=geojson`);
  const out = path.join(OUT, `${key}.topo.json`);
  fs.mkdirSync(OUT, { recursive: true });
  await run(`-i ${q(land)} ${q(admin)} combine-files -rename-layers land,admin -o ${q(out)} format=topojson quantization=60000 precision=0.0001`);
  const kb = Math.round(fs.statSync(out).size / 1024);
  console.log(`${key}: ${path.relative(ROOT, out)} (${kb} KB)`);
}

const adminParts = await buildAdmin();
const stationsFile = stationsGeojson();
for (const key of Object.keys(REGIONS)) await buildRegion(key, adminParts, stationsFile);
fs.rmSync(TMP, { recursive: true, force: true });
