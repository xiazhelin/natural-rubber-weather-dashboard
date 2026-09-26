"use strict";

const DATA_ROOT = "data/capacity/";
const LAND_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/9380cca83db5f9aef52d5e762765100745f84b27/geojson/ne_110m_admin_0_countries.geojson";
const STATUS = {OPERATING: "运营", RAMPING: "爬坡", BUILDING: "在建", PLANNED: "规划", CLOSED: "已关闭", UNKNOWN: "状态待核"};
const TYPE = {"PCR/LTR": "半钢 PCR/LTR", TBR: "全钢 TBR", OTR: "工程胎 OTR", OTHER: "其他／未拆"};
const COLORS = {OPERATING: "#0b675c", RAMPING: "#2387bd", BUILDING: "#d58b19", PLANNED: "#8f8d9b"};
const BOUNDS = {
  world: {west: -170, east: 180, south: -56, north: 77},
  asia: {west: 91, east: 145, south: -12, north: 28},
  africa: {west: -20, east: 49, south: -13, north: 24}
};
const $ = (selector) => document.querySelector(selector);
const state = {tyre: null, rubber: null, manufacturers: null, land: null, activeTyre: null, activeRubber: null};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"})[char]);
}

function number(value, digits = 0) {
  return value == null || !Number.isFinite(Number(value)) ? "MISSING" : Number(value).toLocaleString("zh-CN", {maximumFractionDigits: digits});
}

function estimateNr(line, model) {
  if (line.actual_nr_2025_t != null) return {tons: line.actual_nr_2025_t, kind: "FACT · 企业披露"};
  const kg = model.kg_per_tire[line.type];
  if (!kg) return null;
  if (line.output_2025_wan != null) return {tons: line.output_2025_wan * 10 * kg, kind: "ESTIMATE · 产量×单耗"};
  return null;
}

function designNr(line, model) {
  const kg = model.kg_per_tire[line.type];
  return kg && line.design_capacity != null && !line.capacity_approximate && line.capacity_unit === "万条/年" ? line.design_capacity * 10 * kg : null;
}

function formedNr(line, model) {
  const kg = model.kg_per_tire[line.type];
  return kg && line.formed_capacity != null && !line.formed_capacity_approximate && line.capacity_unit === "万条/年" ? line.formed_capacity * 10 * kg : null;
}

// Sum only comparable, non-overlapping line records; retain missing coverage.
function sumKnown(values) {
  const known = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  return {value: known.length ? known.reduce((a, b) => a + b, 0) : null, known: known.length, total: values.length};
}

function factorySummary(item, model) {
  const types = Object.fromEntries(["PCR/LTR", "TBR"].map((type) => {
    const lines = item.lines.filter((line) => line.type === type);
    const sum = (field) => sumKnown(lines.map((line) => line.capacity_unit === "万条/年" && !(field === "formed_capacity" ? line.formed_capacity_approximate : line.capacity_approximate) ? line[field] : null));
    const otherUnits = lines.filter((line) => line.capacity_unit !== "万条/年" && line.design_capacity != null);
    return [type, {design: sum("design_capacity"), formed: sum("formed_capacity"), effective: sum("effective_capacity_2025"), otherUnits}];
  }));
  const actual = item.lines.map((line) => estimateNr(line, model));
  return {types, formedNr: sumKnown(item.lines.map((line) => formedNr(line, model))), designNr: sumKnown(item.lines.map((line) => designNr(line, model))),
    actualNr: sumKnown(actual.map((item) => item?.tons)), actualEstimated: actual.some((item) => item?.kind.startsWith("ESTIMATE"))};
}

function totalText(summary, divisor = 1, unit = "万条／年") {
  if (summary.value == null) return "未披露";
  const partial = summary.known < summary.total;
  return `${number(summary.value / divisor, 2)} ${unit}${partial ? `（已知 ${summary.known}/${summary.total} 项小计）` : ""}`;
}

function factorySummaryHtml(item) {
  const summary = factorySummary(item, state.tyre.model);
  return `<div class="factory-summary" aria-label="厂区产能与耗胶汇总">${["PCR/LTR", "TBR"].map((type) => {
    const value = summary.types[type];
    const historical = (item.survey_observations || []).filter((o) => o.comparable_type === type);
    return `<div><span>${TYPE[type]} · 设计</span><strong>${totalText(value.design)}</strong><small>已形成：${totalText(value.formed)}</small><small>2025 全年有效：${totalText(value.effective)}</small>${value.otherUnits.map((l) => `<small>另披露 ${number(l.design_capacity)} ${escapeHtml(l.capacity_unit)}，不擅自年化</small>`).join("")}${historical.map((o) => `<small>2025 行业估计：${escapeHtml(o.reported_capacity_text)}，不等于当前设计</small>`).join("")}</div>`;
  }).join("")}<div><span>全厂已形成满负荷耗胶</span><strong>${totalText(summary.formedNr, 10000, "万吨／年")}</strong><small>ESTIMATE · 能力 × 单耗；未拆胎种不纳入</small></div><div><span>2025 年度耗胶</span><strong>${totalText(summary.actualNr, 10000, "万吨")}</strong><small>${summary.actualNr.value == null ? "缺少厂级投料／实际产量依据" : summary.actualEstimated ? "ESTIMATE · 含实际产量 × 单耗" : "FACT · 厂级投料披露"}</small></div></div><p class="summary-dates">汇总全厂全部已收录产线；设计满产耗胶：${totalText(summary.designNr, 10000, "万吨／年")}（ESTIMATE）。各产线披露日期见下方；未披露不等于零。</p>`;
}

function hasCoordinates(item) {
  return Number.isFinite(item.latitude) && Number.isFinite(item.longitude);
}

function fitBounds(records) {
  const points = records.filter(hasCoordinates);
  if (!points.length) return BOUNDS.world;
  const west = Math.min(...points.map((p) => p.longitude)), east = Math.max(...points.map((p) => p.longitude));
  const south = Math.min(...points.map((p) => p.latitude)), north = Math.max(...points.map((p) => p.latitude));
  const dx = Math.max(2, (east - west) * .15), dy = Math.max(2, (north - south) * .15);
  return {west: Math.max(-180, west - dx), east: Math.min(180, east + dx), south: Math.max(-85, south - dy), north: Math.min(85, north + dy)};
}

function coords(record, bounds, width, height) {
  return {
    x: 22 + (record.longitude - bounds.west) / (bounds.east - bounds.west) * (width - 44),
    y: 18 + (bounds.north - record.latitude) / (bounds.north - bounds.south) * (height - 36)
  };
}

function geometryCoords(value, out = []) {
  if (typeof value?.[0] === "number") out.push(value);
  else value?.forEach((item) => geometryCoords(item, out));
  return out;
}

function landPath(geometry, bounds, width, height) {
  const polygons = geometry?.type === "Polygon" ? [geometry.coordinates]
    : geometry?.type === "MultiPolygon" ? geometry.coordinates : [];
  return polygons.flatMap((polygon) => polygon.map((ring) => ring.map(([longitude, latitude], index) => {
    const point = coords({longitude, latitude}, bounds, width, height);
    return `${index ? "L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`;
  }).join("") + "Z")).join("");
}

function mapSvg(records, kind, view, activeId) {
  const bounds = typeof view === "string" ? BOUNDS[view] : view, width = 920, height = 460;
  const inFrame = (record) => hasCoordinates(record) && record.longitude >= bounds.west && record.longitude <= bounds.east
    && record.latitude >= bounds.south && record.latitude <= bounds.north;
  const land = (state.land?.features || []).filter((feature) => {
    const points = geometryCoords(feature.geometry?.coordinates);
    return points.some(([lon, lat]) => lon >= bounds.west && lon <= bounds.east && lat >= bounds.south && lat <= bounds.north);
  }).map((feature) => `<path class="land" d="${landPath(feature.geometry, bounds, width, height)}"/>`).join("");
  const grid = [0.25, 0.5, 0.75].flatMap((n) => [
    `<line class="grid" x1="${width * n}" y1="0" x2="${width * n}" y2="${height}"/>`,
    `<line class="grid" x1="0" y1="${height * n}" x2="${width}" y2="${height * n}"/>`
  ]).join("");
  const duplicates = new Map();
  const markers = records.filter(inFrame).map((item) => {
    const point = coords(item, bounds, width, height);
    const key = `${item.latitude.toFixed(1)}:${item.longitude.toFixed(1)}`;
    const duplicate = duplicates.get(key) || 0;
    duplicates.set(key, duplicate + 1);
    point.x += duplicate % 3 * 8;
    point.y += Math.floor(duplicate / 3) * 8;
    const active = item.id === activeId;
    const national = state.rubber?.national_totals?.[item.country]?.production_t;
    const radius = kind === "rubber" ? (item.level === "COUNTRY" ? 10 : Math.min(15, 5 + Math.sqrt((item.production_t || 0) / (national || 1)) * 22)) : 7;
    const color = kind === "rubber" ? (item.level === "PROVINCE" ? "#0b675c" : "#d58313") : COLORS[item.status] || "#8f8d9b";
    const label = kind === "rubber" ? `${item.country} ${item.province || "全国"} ${number(item.production_t)} ${item.production_unit || "吨"}` : `${item.company} ${item.site}`;
    return `<g class="map-marker${active ? " active" : ""}" role="button" tabindex="0" data-kind="${kind}" data-id="${escapeHtml(item.id)}" aria-label="${escapeHtml(label)}" transform="translate(${point.x.toFixed(1)},${point.y.toFixed(1)})"><circle r="${radius.toFixed(1)}" fill="${color}"><title>${escapeHtml(label)}</title></circle>${active ? `<text x="12" y="-11">${escapeHtml(kind === "rubber" ? item.province || item.country : item.company)}</text>` : ""}</g>`;
  }).join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${kind === "rubber" ? "天然橡胶产区" : "轮胎厂"}研究定位地图"><defs><clipPath id="clip-${kind}"><rect x="0" y="0" width="${width}" height="${height}"/></clipPath></defs><rect x="0" y="0" width="${width}" height="${height}" fill="#e9f4f0"/>${grid}<g clip-path="url(#clip-${kind})">${land}${markers}</g></svg>`;
}

function sourceList(ids, sources) {
  const unique = [...new Set(ids || [])].filter((id) => sources[id]);
  return unique.length ? `<h4>原始来源</h4><ol class="capacity-sources">${unique.map((id) => {
    const source = sources[id];
    return `<li><a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.title)}</a> · ${escapeHtml(source.published || "未注明发布日期")}${source.accessed ? ` · 核验 ${escapeHtml(source.accessed)}` : ""}${source.note ? `<small>${escapeHtml(source.note)}</small>` : ""}</li>`;
  }).join("")}</ol>` : "<p class=\"detail-note\">来源 MISSING，记录不得用于正式判断。</p>";
}

function tyreDetail(item, type) {
  if (!item) return "<p>当前筛选没有厂区。</p>";
  const visible = item.lines.filter((line) => type === "all" || line.type === type);
  const lines = visible.map((line) => {
    const nr = estimateNr(line, state.tyre.model);
    const full = designNr(line, state.tyre.model);
    const formed = formedNr(line, state.tyre.model);
    const unit = line.capacity_unit || "万条/年";
    return `<div class="capacity-line"><strong>${escapeHtml(TYPE[line.type] || line.type)}${line.phase_name ? ` · ${escapeHtml(line.phase_name)}` : ""}</strong><dl>
      <div><dt>设计／披露能力</dt><dd>${line.capacity_lower_bound != null ? `＞${number(line.capacity_lower_bound, 2)}` : `${line.capacity_approximate ? "约 " : ""}${number(line.design_capacity, 2)}`} ${escapeHtml(unit)} <small>${escapeHtml(line.design_as_of || "日期未标")}</small></dd></div>
      <div><dt>已形成能力</dt><dd>${line.formed_capacity == null ? "MISSING" : `${number(line.formed_capacity, 2)} ${escapeHtml(unit)}`} <small>${escapeHtml(line.formed_as_of || "尚未核实")}</small></dd></div>
      <div><dt>2025全年有效</dt><dd>${line.effective_capacity_2025 == null ? "MISSING" : `${number(line.effective_capacity_2025, 2)} ${escapeHtml(unit)}`}</dd></div>
      <div><dt>2025利用率</dt><dd>${line.utilization_2025_pct == null ? "MISSING" : `${number(line.utilization_2025_pct, 2)}% <small>不能单独反推全年产量</small>`}</dd></div>
      <div><dt>2025耗胶</dt><dd>${nr ? `${number(nr.tons / 10000, 2)} 万吨 <small>${escapeHtml(nr.kind)}</small>` : "MISSING"}</dd></div>
      <div><dt>已形成满负荷情景</dt><dd>${formed == null ? "MISSING" : `${number(formed / 10000, 2)} 万吨／年 <small>ESTIMATE，不是实际耗胶</small>`}</dd></div>
      <div><dt>设计满产情景</dt><dd>${full == null ? "MISSING" : `${number(full / 10000, 2)} 万吨／年 <small>ESTIMATE，不是实际耗胶</small>`}</dd></div>
    </dl>${line.phases?.length ? `<small>扩产周期：${line.phases.map((phase) => `${escapeHtml(phase.period)} ${escapeHtml(phase.label)}（${escapeHtml(phase.status)}）`).join(" → ")}</small>` : ""}${line.note ? `<small>${escapeHtml(line.note)}</small>` : ""}</div>`;
  }).join("");
  const ids = [...(item.source_ids || []), ...(item.address_source_ids || []), ...(item.coordinate_source_ids || []), ...visible.flatMap((line) => line.source_ids || [])];
  const address = item.address ? `${escapeHtml(item.address)} <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${item.company} ${item.address}`)}" target="_blank" rel="noopener noreferrer">地图查址 ↗</a>` : "具体厂址 MISSING · 当前无法确认";
  const historical = (item.survey_observations || []).map((o) => `<div class="capacity-line"><strong>2025 行业调查 · ${escapeHtml(TYPE[o.comparable_type])}</strong><p>${escapeHtml(o.reported_capacity_text)} · ESTIMATE / WARNING</p><small>原表胎种代码：${escapeHtml(o.product_types)}；PDF 第 ${number(o.source_page)} 页；DOT ${escapeHtml(o.dot_codes.join(" / "))}。</small><small>${escapeHtml(o.note)} u/d＝条/日，u/y＝条/年，t/y＝轮胎吨/年，t/m＝轮胎吨/月，t/d＝轮胎吨/日；不能当作天然胶吨数。与较新企业披露不合并求和。</small></div>`).join("");
  return `<h3>${escapeHtml(item.company)} · ${escapeHtml(item.site)}</h3><p class="detail-sub">${escapeHtml(item.country)} · ${escapeHtml(item.province || item.place)} · ${escapeHtml(STATUS[item.status] || item.status)} · ${escapeHtml(item.quality)}${item.census_record_type === "HISTORICAL_SURVEY_FACTORY" ? " · 2025行业普查厂区" : ""}</p>${factorySummaryHtml(item)}<div class="factory-address"><strong>${item.address_scope === "REGISTRY_ADDRESS" ? "登记地址 · 物理厂址待核" : "厂区地址"}</strong><p>${address}</p><small>地址核验：${escapeHtml(item.address_quality || "MISSING")} · ${escapeHtml(item.coord_precision || "坐标待核")}</small></div><p class="detail-note">${escapeHtml(item.note || "厂区地址与地图坐标精度分别核验；产能以逐项披露日期为准。")}</p>${historical}${lines}${sourceList(ids, state.tyre.sources)}`;
}

function rubberDetail(item) {
  if (!item) return "<p>当前筛选没有产区。</p>";
  const national = state.rubber.national_totals[item.country];
  const share = item.level === "PROVINCE" && item.production_t != null && national?.production_t && item.year === national.year ? `${number(item.production_t / national.production_t * 100, 2)}%` : "MISSING／不适用";
  return `<h3>${escapeHtml(item.country)} · ${escapeHtml(item.province || "全国")}</h3><p class="detail-sub">${escapeHtml(item.year)} 年 · ${escapeHtml(item.data_type)} · ${escapeHtml(item.quality)}</p><dl>
    <div><dt>天然胶产量</dt><dd>${number(item.production_t)} ${escapeHtml(item.production_unit || "吨")}</dd></div>
    <div><dt>全国占比</dt><dd>${share} <small>同年、同国内口径</small></dd></div>
    <div><dt>生产性面积</dt><dd>${number(item.productive_area)} ${escapeHtml(item.area_unit || "")} <small>${escapeHtml(item.area_definition || "口径待核")}</small></dd></div>
    <div><dt>地理层级</dt><dd>${item.level === "PROVINCE" ? "省级" : "国家级"}</dd></div>
    <div><dt>空间定位</dt><dd>${escapeHtml(item.coord_precision)}</dd></div>
  </dl><p class="detail-note">${escapeHtml(item.note || "年产量不是产能；未核实的可割胶面积保持 MISSING。")}</p>${sourceList(item.source_ids, state.rubber.sources)}`;
}

function fillCountrySelect(selector, records) {
  const countries = [...new Set(records.map((item) => item.country))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  $(selector).insertAdjacentHTML("beforeend", countries.map((country) => `<option value="${escapeHtml(country)}">${escapeHtml(country)}</option>`).join(""));
}

function stat(label, value, note) {
  return `<div class="capacity-stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></div>`;
}

function renderTyres() {
  const data = state.tyre;
  const country = $("#tyreCountry").value, type = $("#tyreType").value, status = $("#tyreStatus").value;
  const manufacturer = $("#tyreManufacturer").value;
  const registry = $("#tyreEvidence").value === "registry";
  const query = $("#tyreSearch").value.trim().toLowerCase();
  const records = (registry ? data.registry_candidates || [] : data.factories).filter((item) => (country === "all" || item.country === country)
    && (manufacturer === "all" || item.manufacturer_id === manufacturer)
    && matchesTyreType(item, type)
    && (status === "all" || item.status === status)
    && (!query || `${item.company} ${item.site} ${item.country} ${item.province || ""} ${item.address || ""}`.toLowerCase().includes(query)));
  if (!records.some((item) => item.id === state.activeTyre)) state.activeTyre = records[0]?.id || null;
  const visibleLines = records.flatMap((item) => item.lines.filter((line) => type === "all" || line.type === type));
  const lineCount = visibleLines.length;
  const formedCount = visibleLines.filter((line) => line.formed_capacity != null).length;
  const effectiveCount = visibleLines.filter((line) => line.effective_capacity_2025 != null).length;
  const nrCount = visibleLines.filter((line) => estimateNr(line, data.model)).length;
  const addresses = records.filter((item) => item.address && item.address_quality === "PASS").length;
  $("#tyreStats").innerHTML = stat(registry ? "登记候选地点（非厂数）" : "已收录厂区", `${records.length} 个`, registry ? "办公地址／历史记录仍待剔除" : `详细地址已核 ${addresses} 个`) + stat("分胎种产线", `${lineCount} 项`, `其中已形成能力有据 ${formedCount} 项`)
    + stat("全年有效产能有据", `${effectiveCount} 项`, "未核实保持 MISSING") + stat("厂级年度耗胶有据／可估", `${nrCount} 项`, "仅实耗或实际产量可用");
  $("#tyreSvg").innerHTML = mapSvg(records, "tyre", country === "all" ? "world" : fitBounds(records), state.activeTyre);
  $("#tyreMapCoverage").textContent = registry ? "登记地址可能是办公地或旧址，尚未核实的不落地图、不计入厂区或产能总量；可在下方查看原始登记地址。" : `所选 ${records.length} 个厂区，地图已定位 ${records.filter(hasCoordinates).length} 个，${records.filter((r) => !hasCoordinates(r)).length} 个坐标待核。城市／地区近似点不是厂门定位；地址可点击单独查地图。`;
  $("#tyreDetail").innerHTML = tyreDetail(records.find((item) => item.id === state.activeTyre), type);
  $("#tyreList").innerHTML = records.map((item) => `<button type="button" data-kind="tyre" data-id="${escapeHtml(item.id)}" class="${item.id === state.activeTyre ? "active" : ""}"><strong>${escapeHtml(item.company)} · ${escapeHtml(item.site)}</strong><small>${escapeHtml(item.country)} · ${escapeHtml(item.lines.filter((line) => type === "all" || line.type === type).map((line) => TYPE[line.type] || line.type).join(" / "))} · ${escapeHtml(STATUS[item.status] || item.status)}</small></button>`).join("") || "<p>没有匹配的工厂。</p>";
}

function renderCensus() {
  const data = state.manufacturers;
  if (!data) { $("#censusStatus").textContent = "企业普查名录读取失败，现有工厂数据仍可查看。"; return; }
  const records = data.manufacturers;
  const covered = records.filter((m) => state.tyre.factories.some((f) => f.manufacturer_id === m.id)).length;
  $("#censusStatus").textContent = `${data.ranking.edition} 榜单 · ${data.ranking.data_year} 年轮胎销售额口径；${records.length} 家企业中 ${covered} 家已收录厂区。${data.ranking.notes?.[0] || ""} 厂区与登记候选分层，仍非全球全量核验完成。`;
  $("#tyreManufacturer").insertAdjacentHTML("beforeend", records.map((m) => `<option value="${escapeHtml(m.id)}">${m.rank}. ${escapeHtml(m.name)}</option>`).join(""));
  $("#censusTable").innerHTML = `<table><thead><tr><th>榜单排名</th><th>企业／集团</th><th>已收录厂区</th><th>详细地址已核</th><th>产能数值有据</th><th>登记待核线索</th><th>核验进度</th></tr></thead><tbody>${records.map((m) => {
    const factories = state.tyre.factories.filter((f) => f.manufacturer_id === m.id);
    const addresses = factories.filter((f) => f.address_quality === "PASS" && f.address).length;
    const capacities = factories.filter((f) => f.lines.some((l) => l.design_capacity != null || l.formed_capacity != null || l.capacity_lower_bound != null)).length;
    const surveys = factories.filter((f) => f.survey_observations?.length).length;
    const candidates = (state.tyre.registry_candidates || []).filter((f) => f.manufacturer_id === m.id).length;
    return `<tr><td>${m.rank}</td><td><button type="button" data-manufacturer="${escapeHtml(m.id)}">${escapeHtml(m.name)}</button><small>${escapeHtml(m.name_en || "")}</small></td><td>${factories.length}</td><td>${addresses}</td><td>${capacities}<small>另历史估计 ${surveys} 个，勿相加</small></td><td><button type="button" data-manufacturer="${escapeHtml(m.id)}" data-layer="registry">${candidates}</button></td><td>${factories.length ? "已开展 · 全量仍待核验" : "待收录厂区"}</td></tr>`;
  }).join("")}</tbody></table>`;
  $("#censusSources").innerHTML = sourceList(data.ranking.source_ids, data.sources);
}

function renderGroupBenchmarks() {
  const rows = state.tyre.group_benchmarks || [];
  $("#groupBenchmarks").innerHTML = rows.map((item) => `<article><h3>${escapeHtml(item.company)} · ${escapeHtml(item.year)}</h3><p>集团天然胶实际耗用：<strong>${number(item.actual_nr_t / 10000, 2)} 万吨</strong> · FACT</p><p>${escapeHtml(item.note)}</p>${sourceList(item.source_ids, state.tyre.sources)}</article>`).join("");
}

function renderRubber() {
  const country = $("#rubberCountry").value, view = $("#rubberView").value, query = $("#rubberSearch").value.trim().toLowerCase();
  const bounds = BOUNDS[view];
  const records = state.rubber.regions.filter((item) => (country === "all" || item.country === country)
    && item.longitude >= bounds.west && item.longitude <= bounds.east && item.latitude >= bounds.south && item.latitude <= bounds.north
    && (!query || `${item.country} ${item.province || ""} ${item.name || ""}`.toLowerCase().includes(query)));
  if (!records.some((item) => item.id === state.activeRubber)) state.activeRubber = records[0]?.id || null;
  const province = records.filter((item) => item.level === "PROVINCE");
  const countryRecords = records.filter((item) => item.level === "COUNTRY");
  const thRecords = province.filter((item) => item.country === "泰国"), idRecords = province.filter((item) => item.country === "印度尼西亚");
  const th = sumKnown(thRecords.map((item) => item.production_t)), id = sumKnown(idRecords.map((item) => item.production_t));
  $("#rubberStats").innerHTML = stat("省级记录", `${province.length} 个`, `产量数值有据 ${province.filter((p) => p.production_t != null).length} 个`)
    + stat("国家级记录", `${countryRecords.length} 个`, "不得向省级分配")
    + stat("泰国所选省级产量", th.value != null ? `${number(th.value / 10000, 1)} 万吨` : "—", `${th.known}/${th.total} 个有数值 · 2025f 生胶片`)
    + stat("印尼所选省级产量", id.value != null ? `${number(id.value / 10000, 1)} 万吨` : "—", "2025初值 · 干胶口径");
  const thAll = state.rubber.regions.filter((r) => r.country === "泰国" && r.level === "PROVINCE");
  const thSum = sumKnown(thAll.map((r) => r.production_t));
  $("#rubberCoverage").textContent = `泰国省级名录 ${thAll.length} 个，产量数值有据 ${thSum.known} 个；未列数值的省份保留 MISSING。全国披露 ${number(state.rubber.national_totals["泰国"]?.production_t)} 吨，已录省级合计 ${number(thSum.value)} 吨；差额单列核对，不分摊补数。`;
  $("#rubberSvg").innerHTML = mapSvg(records, "rubber", view, state.activeRubber);
  $("#rubberDetail").innerHTML = rubberDetail(records.find((item) => item.id === state.activeRubber));
  $("#rubberList").innerHTML = records.map((item) => `<button type="button" data-kind="rubber" data-id="${escapeHtml(item.id)}" class="${item.id === state.activeRubber ? "active" : ""}"><strong>${escapeHtml(item.country)} · ${escapeHtml(item.province || "全国")}</strong><small>${escapeHtml(item.year)} ${escapeHtml(item.data_type)} · ${number(item.production_t)} ${escapeHtml(item.production_unit || "吨")} · ${escapeHtml(item.quality)}</small></button>`).join("") || "<p>当前地图范围没有匹配的产区。</p>";
}

function activate(kind, id) {
  if (kind === "tyre") { state.activeTyre = id; renderTyres(); }
  else { state.activeRubber = id; renderRubber(); }
}

async function start() {
  const getJson = (url) => fetch(url, {cache: "no-store", signal: AbortSignal.timeout(12000)}).then((response) => {
    if (!response.ok) throw new Error(`${response.status} ${url}`);
    return response.json();
  });
  const [tyre, rubber, land, manufacturers] = await Promise.allSettled([
    getJson(`${DATA_ROOT}tyre-factories.json`), getJson(`${DATA_ROOT}rubber-regions.json`), getJson(LAND_URL), getJson(`${DATA_ROOT}tyre-manufacturers.json`)
  ]);
  state.land = land.status === "fulfilled" ? land.value : null;
  state.manufacturers = manufacturers.status === "fulfilled" ? manufacturers.value : null;
  if (tyre.status === "fulfilled") {
    state.tyre = tyre.value;
    fillCountrySelect("#tyreCountry", [...state.tyre.factories, ...(state.tyre.registry_candidates || [])]);
    renderCensus();
    renderTyres();
    renderGroupBenchmarks();
  } else $("#tyreSvg").textContent = `轮胎数据读取失败：${tyre.reason.message}`;
  if (rubber.status === "fulfilled") {
    state.rubber = rubber.value;
    fillCountrySelect("#rubberCountry", state.rubber.regions);
    renderRubber();
  } else $("#rubberSvg").textContent = `产区数据读取失败：${rubber.reason.message}`;
  $("#atlasUpdated").textContent = `文件修订：轮胎 ${state.tyre?.updated_at || "MISSING"} · 产区 ${state.rubber?.updated_at || "MISSING"}${state.land ? "" : " · 底图暂不可用"}`;
  ["#tyreCountry", "#tyreManufacturer", "#tyreType", "#tyreStatus", "#tyreSearch"].forEach((id) => $(id).addEventListener("input", () => state.tyre && renderTyres()));
  $("#tyreEvidence").addEventListener("change", () => {
    ["#tyreType", "#tyreStatus"].forEach((id) => $(id).value = "all");
    if (state.tyre) renderTyres();
  });
  $("#rubberCountry").addEventListener("change", () => {
    if ($("#rubberCountry").value === "科特迪瓦") $("#rubberView").value = "africa";
    else if ($("#rubberView").value === "africa") $("#rubberView").value = "asia";
    if (state.rubber) renderRubber();
  });
  ["#rubberView", "#rubberSearch"].forEach((id) => $(id).addEventListener("input", () => state.rubber && renderRubber()));
  document.addEventListener("click", (event) => {
    const manufacturer = event.target.closest("[data-manufacturer]");
    if (manufacturer) {
      $("#tyreManufacturer").value = manufacturer.dataset.manufacturer;
      $("#tyreEvidence").value = manufacturer.dataset.layer || "factory";
      ["#tyreCountry", "#tyreType", "#tyreStatus"].forEach((id) => $(id).value = "all");
      $("#tyreSearch").value = "";
      renderTyres();
      $("#tyreCountry").scrollIntoView({behavior: "smooth", block: "center"});
    }
    const target = event.target.closest("[data-kind][data-id]");
    if (target) activate(target.dataset.kind, target.dataset.id);
  });
  document.addEventListener("keydown", (event) => {
    const target = event.target.closest(".map-marker[data-kind][data-id]");
    if (target && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); activate(target.dataset.kind, target.dataset.id); }
  });
}

function matchesTyreType(item, type) {
  return type === "all" || item.lines.some((line) => line.type === type)
    || (item.survey_observations || []).some((o) => o.comparable_type === type);
}

if (typeof document !== "undefined") start();
if (typeof module !== "undefined") module.exports = {estimateNr, designNr, formedNr, sumKnown, factorySummary, fitBounds, matchesTyreType};
