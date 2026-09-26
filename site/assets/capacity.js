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
const mapViews = {tyre: {zoom: 1, x: 0, y: 0}, rubber: {zoom: 1, x: 0, y: 0}};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"})[char]);
}

function number(value, digits = 0) {
  return value == null || !Number.isFinite(Number(value)) ? "MISSING" : Number(value).toLocaleString("zh-CN", {maximumFractionDigits: digits});
}

function nrRange(type, wan, model) {
  const kg = model.kg_per_tire_range[type];
  return kg && Number.isFinite(wan) && wan >= 0 ? {low: wan * 10 * kg[0], high: wan * 10 * kg[1]} : null;
}

function estimateNr(line, model) {
  if (line.quality === "FAIL") return null;
  if (Number.isFinite(line.actual_nr_2025_t) && line.actual_nr_2025_t >= 0)
    return {low: line.actual_nr_2025_t, high: line.actual_nr_2025_t, kind: "FACT · 企业披露"};
  const range = nrRange(line.type, line.output_2025_wan, model);
  return range ? {...range, kind: "ESTIMATE · 产量×单耗区间"} : null;
}

function designNr(line, model) {
  return line.quality !== "FAIL" && line.capacity_unit === "万条/年" && !line.capacity_approximate ? nrRange(line.type, line.design_capacity, model) : null;
}

function formedNr(line, model) {
  return line.quality !== "FAIL" && line.capacity_unit === "万条/年" && !line.formed_capacity_approximate ? nrRange(line.type, line.formed_capacity, model) : null;
}

function sumRanges(values) {
  const known = values.filter((v) => v && Number.isFinite(v.low) && Number.isFinite(v.high));
  return {low: known.length ? known.reduce((sum, v) => sum + v.low, 0) : null,
    high: known.length ? known.reduce((sum, v) => sum + v.high, 0) : null, known: known.length, total: values.length};
}

function rangeText(range, unit = "万吨／年") {
  if (!range || range.low == null) return "未披露／不可估";
  const value = range.low === range.high ? number(range.low / 10000, 2) : `${number(range.low / 10000, 2)}–${number(range.high / 10000, 2)}`;
  return `${value} ${unit}${range.known < range.total ? `（已知 ${range.known}/${range.total} 项小计）` : ""}`;
}

// Sum only comparable, non-overlapping line records; retain missing coverage.
function sumKnown(values) {
  const known = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  return {value: known.length ? known.reduce((a, b) => a + b, 0) : null, known: known.length, total: values.length};
}

function factorySummary(item, model) {
  const usable = item.quality === "FAIL" ? [] : item.lines.filter((l) => l.quality !== "FAIL");
  const types = Object.fromEntries(["PCR/LTR", "TBR"].map((type) => {
    const lines = usable.filter((line) => line.type === type);
    const sum = (field) => sumKnown(lines.map((line) => line.capacity_unit === "万条/年" && !(field === "formed_capacity" ? line.formed_capacity_approximate : line.capacity_approximate) ? line[field] : null));
    const otherUnits = lines.filter((line) => line.capacity_unit !== "万条/年" && line.design_capacity != null);
    return [type, {design: sum("design_capacity"), formed: sum("formed_capacity"), effective: sum("effective_capacity_2025"), otherUnits}];
  }));
  const actual = usable.map((line) => estimateNr(line, model));
  return {types, formedNr: sumRanges(usable.map((line) => formedNr(line, model))), designNr: sumRanges(usable.map((line) => designNr(line, model))),
    actualNr: sumRanges(actual), actualEstimated: actual.some((item) => item?.kind.startsWith("ESTIMATE"))};
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
  }).join("")}<div><span>全厂已形成满负荷耗胶</span><strong>${rangeText(summary.formedNr)}</strong><small>ESTIMATE · 能力 × 用户单耗区间</small></div><div><span>2025 年度耗胶</span><strong>${rangeText(summary.actualNr, "万吨")}</strong><small>${summary.actualNr.low == null ? "缺少厂级投料／实际产量依据" : summary.actualEstimated ? "ESTIMATE · 含实际产量 × 单耗" : "FACT · 厂级投料披露"}</small></div></div><p class="summary-dates">汇总全厂全部已收录产线；设计满产耗胶：${rangeText(summary.designNr)}（ESTIMATE）。半钢2.6–3.0、全钢22–23吨/千条。各线日期见下方；不是当前实际消费。</p>`;
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
  // A single Mercator scale keeps country views from stretching east–west.
  const mercator = (latitude) => Math.log(Math.tan(Math.PI / 4 + Math.max(-85, Math.min(85, latitude)) * Math.PI / 360)) * 180 / Math.PI;
  const north = mercator(bounds.north), south = mercator(bounds.south);
  const scale = Math.min((width - 44) / (bounds.east - bounds.west), (height - 36) / (north - south));
  return {
    x: width / 2 + (record.longitude - (bounds.west + bounds.east) / 2) * scale,
    y: height / 2 + ((north + south) / 2 - mercator(record.latitude)) * scale
  };
}

function mapViewBox(view) {
  const width = 920 / view.zoom, height = 460 / view.zoom;
  return `${460 + view.x - width / 2} ${230 + view.y - height / 2} ${width} ${height}`;
}

function adjustMapView(view, action) {
  if (action === "reset") Object.assign(view, {zoom: 1, x: 0, y: 0});
  if (action === "in") view.zoom = Math.min(16, view.zoom * 2);
  if (action === "out") view.zoom = Math.max(.25, view.zoom / 2);
  if (action === "left") view.x -= 184 / view.zoom;
  if (action === "right") view.x += 184 / view.zoom;
  if (action === "up") view.y -= 92 / view.zoom;
  if (action === "down") view.y += 92 / view.zoom;
  return view;
}

function updateMapViewport(kind) {
  const view = mapViews[kind], container = $(`#${kind}Svg`), svg = container.querySelector("svg");
  if (!svg) return;
  svg.setAttribute("viewBox", mapViewBox(view));
  svg.querySelectorAll(".map-marker circle").forEach((circle) => circle.setAttribute("r", Number(circle.dataset.radius) / view.zoom));
  svg.querySelectorAll(".map-marker text").forEach((label) => {
    label.style.fontSize = `${12 / view.zoom}px`;
    label.setAttribute("x", 12 / view.zoom);
    label.setAttribute("y", -11 / view.zoom);
  });
  const tools = $(`#${kind}MapTools`);
  tools.querySelector("output").textContent = `${number(view.zoom * 100)}%`;
  tools.querySelector('[data-map-action="in"]').disabled = view.zoom >= 16;
  tools.querySelector('[data-map-action="out"]').disabled = view.zoom <= .25;
}

function renderMap(records, kind, bounds, activeId, filterKey) {
  const view = mapViews[kind];
  if (view.filterKey !== filterKey) adjustMapView(view, "reset");
  view.filterKey = filterKey;
  $(`#${kind}Svg`).innerHTML = mapSvg(records, kind, bounds, activeId);
  updateMapViewport(kind);
}

function bindMapControls(kind) {
  const container = $(`#${kind}Svg`), view = mapViews[kind];
  const apply = (action) => { adjustMapView(view, action); updateMapViewport(kind); };
  $(`#${kind}MapTools`).addEventListener("click", (event) => {
    const button = event.target.closest("[data-map-action]");
    if (button) apply(button.dataset.mapAction);
  });
  container.addEventListener("keydown", (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const action = {"+": "in", "=": "in", "-": "out", Home: "reset", ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down"}[event.key];
    if (action) { event.preventDefault(); apply(action); }
  });
  let drag = null, suppressClick = false;
  container.addEventListener("pointerdown", (event) => {
    // Keep native touch scrolling/pinch zoom; touch users can pan with the buttons.
    if (event.pointerType === "touch" || event.button !== 0 || !container.querySelector("svg")) return;
    const rect = container.getBoundingClientRect();
    drag = {pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: view.x, y: view.y,
      scale: Math.min(rect.width / 920, rect.height / 460) * view.zoom};
    suppressClick = false;
  });
  container.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!event.buttons) { drag = null; return; }
    const dx = event.clientX - drag.clientX, dy = event.clientY - drag.clientY;
    if (Math.hypot(dx, dy) < 4 && !suppressClick) return;
    if (!suppressClick) container.setPointerCapture(event.pointerId);
    suppressClick = true;
    view.x = drag.x - dx / drag.scale;
    view.y = drag.y - dy / drag.scale;
    container.classList.add("is-dragging");
    updateMapViewport(kind);
  });
  const finish = () => { drag = null; container.classList.remove("is-dragging"); };
  container.addEventListener("pointerup", finish);
  container.addEventListener("pointercancel", finish);
  container.addEventListener("lostpointercapture", finish);
  container.addEventListener("click", (event) => {
    if (suppressClick) { event.preventDefault(); event.stopPropagation(); suppressClick = false; }
  }, true);
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
  const land = (state.land?.features || []).map((feature) => `<path class="land" d="${landPath(feature.geometry, bounds, width, height)}"/>`).join("");
  const grid = [0.25, 0.5, 0.75].flatMap((n) => [
    `<line class="grid" x1="${width * n}" y1="0" x2="${width * n}" y2="${height}"/>`,
    `<line class="grid" x1="0" y1="${height * n}" x2="${width}" y2="${height * n}"/>`
  ]).join("");
  const duplicates = new Map();
  const markers = records.filter(hasCoordinates).map((item) => {
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
    return `<g class="map-marker${active ? " active" : ""}" role="button" tabindex="0" data-kind="${kind}" data-id="${escapeHtml(item.id)}" aria-label="${escapeHtml(label)}" transform="translate(${point.x.toFixed(1)},${point.y.toFixed(1)})"><circle r="${radius.toFixed(1)}" data-radius="${radius.toFixed(1)}" fill="${color}"><title>${escapeHtml(label)}</title></circle>${active ? `<text x="12" y="-11">${escapeHtml(kind === "rubber" ? item.province || item.country : item.company)}</text>` : ""}</g>`;
  }).join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${kind === "rubber" ? "天然橡胶产区" : "轮胎厂"}研究定位地图">${grid}${land}${markers}</svg>`;
}

function sourceList(ids, sources) {
  const unique = [...new Set(ids || [])].filter((id) => sources[id]);
  return unique.length ? `<h4>原始来源</h4><ol class="capacity-sources">${unique.map((id) => {
    const source = sources[id];
    return `<li><a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.title)}</a> · ${escapeHtml(source.published || "未注明发布日期")}${source.accessed || source.accessed_at ? ` · 核验 ${escapeHtml(source.accessed || source.accessed_at)}` : ""}${source.note ? `<small>${escapeHtml(source.note)}</small>` : ""}</li>`;
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
      <div><dt>2025耗胶</dt><dd>${nr ? `${rangeText(nr, "万吨")} <small>${escapeHtml(nr.kind)}</small>` : "MISSING"}</dd></div>
      <div><dt>已形成满负荷情景</dt><dd>${formed == null ? "MISSING" : `${rangeText(formed)} <small>ESTIMATE，不是实际耗胶</small>`}</dd></div>
      <div><dt>设计满产情景</dt><dd>${full == null ? "MISSING" : `${rangeText(full)} <small>ESTIMATE，不是实际耗胶</small>`}</dd></div>
    </dl>${line.phases?.length ? `<small>扩产周期：${line.phases.map((phase) => `${escapeHtml(phase.period)} ${escapeHtml(phase.label)}（${escapeHtml(phase.status)}）`).join(" → ")}</small>` : ""}${line.note ? `<small>${escapeHtml(line.note)}</small>` : ""}</div>`;
  }).join("");
  const ids = [...(item.source_ids || []), ...(item.address_source_ids || []), ...(item.coordinate_source_ids || []), ...visible.flatMap((line) => line.source_ids || [])];
  const address = item.address ? `${escapeHtml(item.address)} <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${item.company} ${item.address}`)}" target="_blank" rel="noopener noreferrer">地图查址 ↗</a>` : "具体厂址 MISSING · 当前无法确认";
  const historical = (item.survey_observations || []).map((o) => `<div class="capacity-line"><strong>2025 行业调查 · ${escapeHtml(TYPE[o.comparable_type])}</strong><p>${escapeHtml(o.reported_capacity_text)} · ESTIMATE / WARNING</p><small>原表胎种代码：${escapeHtml(o.product_types)}；PDF 第 ${number(o.source_page)} 页；DOT ${escapeHtml(o.dot_codes.join(" / "))}。</small><small>${escapeHtml(o.note)} u/d＝条/日，u/y＝条/年，t/y＝轮胎吨/年，t/m＝轮胎吨/月，t/d＝轮胎吨/日；不能当作天然胶吨数。与较新企业披露不合并求和。</small></div>`).join("");
  const claims = (item.capacity_claims || []).map((c) => `<p class="detail-note">待核线索：${escapeHtml(TYPE[c.type])} ${number(c.reported_design_capacity)} ${escapeHtml(c.capacity_unit)} · ${escapeHtml(c.claim_as_of)}。${escapeHtml(c.claim_source)}；未进入产能及耗胶合计。</p>`).join("");
  const reported = item.reported_nr_scenario ? `<p class="detail-note">企业可研耗胶情景：${number(item.reported_nr_scenario.value)} ${escapeHtml(item.reported_nr_scenario.unit)} · ${escapeHtml(item.reported_nr_scenario.as_of)}。${escapeHtml(item.reported_nr_scenario.basis)}</p>` : "";
  return `<h3>${escapeHtml(item.company)} · ${escapeHtml(item.site)}</h3><p class="detail-sub">${escapeHtml(item.country)} · ${escapeHtml(item.province || item.place)} · ${escapeHtml(STATUS[item.status] || item.status)} · ${escapeHtml(item.quality)}${item.census_record_type === "HISTORICAL_SURVEY_FACTORY" ? " · 2025行业普查厂区" : ""}</p>${factorySummaryHtml(item)}<div class="factory-address"><strong>${item.address_scope === "REGISTRY_ADDRESS" ? "登记地址 · 物理厂址待核" : "厂区地址"}</strong><p>${address}</p><small>地址核验：${escapeHtml(item.address_quality || "MISSING")} · ${escapeHtml(item.coord_precision || "坐标待核")}</small></div><p class="detail-note">${escapeHtml(item.note || "厂区地址与地图坐标精度分别核验；产能以逐项披露日期为准。")}</p>${claims}${reported}${historical}${lines}${sourceList(ids, state.tyre.sources)}`;
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

function aggregateNr(factories, model, options = {}) {
  const days = options.days ?? 0, loadPct = options.loadPct ?? 100;
  if (!Number.isFinite(days) || days < 0 || days > 366 || !Number.isFinite(loadPct) || loadPct < 0 || loadPct > 100)
    throw new Error("情景参数超出范围");
  const rows = [], excluded = {closed: 0, daily: 0, mixed: 0, overlap: 0, failed: 0};
  const add = (f, type, wan, bucket, basis, date, sources) => {
    const nr = nrRange(type, wan, model);
    if (nr && wan > 0) rows.push({factory_id: f.id, company: f.company, site: f.site, country: f.country, type,
      capacity_wan: wan, bucket, basis, as_of: date || "日期未核", source_ids: sources || f.source_ids,
      low: nr.low, high: nr.high});
  };
  for (const f of factories) {
    if (f.quality === "FAIL") { excluded.failed++; continue; }
    if (f.status === "CLOSED") { excluded.closed++; continue; }
    if (f.census_record_type === "REGISTRY_CANDIDATE") continue;
    for (const l of f.lines) {
      if (l.quality === "FAIL") { excluded.failed++; continue; }
      const lineStatus = l.status || f.status;
      if (lineStatus === "CLOSED") continue;
      const future = ["PLANNED", "BUILDING"].includes(lineStatus);
      if (!future && formedNr(l, model))
        add(f, l.type, l.formed_capacity, "FORMED", l.capacity_scope === "CONFIRMED_INCREMENT_ONLY" ? "仅已核增量；非全厂总数" : "已披露形成能力", l.formed_as_of, l.source_ids);
      if (!future && l.capacity_unit === "条/日" && model.kg_per_tire_range[l.type]
          && Number.isFinite(l.formed_capacity) && !l.formed_capacity_approximate) {
        if (days > 0) add(f, l.type, l.formed_capacity * days / 10000, "FORMED", "已披露日能力×情景天数", l.formed_as_of, l.source_ids);
        else excluded.daily++;
      }
      // A design-minus-formed gap is potential, not a dated commissioning forecast.
      let pending = Number.isFinite(l.pipeline_increment_capacity) ? l.pipeline_increment_capacity
        : future ? l.design_capacity
        : Number.isFinite(l.formed_capacity) && Number.isFinite(l.design_capacity) ? Math.max(0, l.design_capacity - l.formed_capacity) : null;
      if (l.capacity_unit === "万条/年" && !l.capacity_approximate)
        add(f, l.type, pending, "PIPELINE", future ? "在建／规划设计" : "历史设计未形成差额／核实增量",
          future || Number.isFinite(l.pipeline_increment_capacity) ? l.design_as_of : `设计${l.design_as_of || "未核"}／形成${l.formed_as_of || "未核"}`, l.source_ids);
    }
    const observations = f.survey_observations || [];
    for (const o of observations) {
      if (o.quality === "FAIL") { excluded.failed++; continue; }
      if (["PLANNED", "BUILDING"].includes(f.status)) continue;
      if (!model.kg_per_tire_range[o.comparable_type]) { excluded.mixed++; continue; }
      const related = f.lines.filter((l) => l.type === o.comparable_type);
      const blocked = related.some((l) => formedNr(l, model)
        || (l.quality !== "FAIL" && l.capacity_unit === "条/日" && Number.isFinite(l.formed_capacity) && !l.formed_capacity_approximate)
        || l.status === "CLOSED"
        || ["PLANNED", "BUILDING"].includes(l.status))
        || observations.filter((v) => v.comparable_type === o.comparable_type).length !== 1;
      if (blocked) { excluded.overlap++; continue; }
      const annual = o.unit === "u/y" ? o.value : o.unit === "u/d" && days > 0 ? o.value * days : null;
      if (annual == null) { if (o.unit === "u/d") excluded.daily++; continue; }
      add(f, o.comparable_type, annual / 10000, "HISTORICAL", o.unit === "u/d" ? "历史日能力×情景天数" : "历史年能力", o.as_of, o.source_ids);
    }
  }
  const inBucket = (bucket) => rows.filter((r) => r.bucket === bucket);
  const current = rows.filter((r) => r.bucket !== "PIPELINE");
  const combined = sumRanges(current);
  return {rows, excluded, formed: sumRanges(inBucket("FORMED")), historical: sumRanges(inBucket("HISTORICAL")),
    pipeline: sumRanges(inBucket("PIPELINE")), combined,
    scenario: {...combined, low: combined.low == null ? null : combined.low * loadPct / 100,
      high: combined.high == null ? null : combined.high * loadPct / 100},
    coveredFactories: new Set(current.map((r) => r.factory_id)).size, factoryCount: factories.length,
    days, loadPct};
}

function renderNrTotals(records, type, registry) {
  const daysInput = $("#nrDays"), loadInput = $("#nrLoad");
  if (!daysInput.checkValidity() || !loadInput.checkValidity()) {
    $("#nrTotals").textContent = "请填写有效参数：年化天数0–366，情景负荷0–100%。";
    $("#nrScenario").textContent = "参数无效，本次结果未计算。";
    $("#nrLedger").textContent = "";
    return;
  }
  const options = {days: Number(daysInput.value), loadPct: Number(loadInput.value)};
  const global = aggregateNr(state.tyre.factories, state.tyre.model, options);
  const filtered = records.map((f) => ({...f, lines: f.lines.filter((l) => type === "all" || l.type === type),
    survey_observations: (f.survey_observations || []).filter((o) => type === "all" || o.comparable_type === type)}));
  const selected = registry ? null : aggregateNr(filtered, state.tyre.model, options);
  $("#nrTotals").innerHTML = stat("全球名录 · 满负荷粗估 A+B", rangeText(global.combined), `可估${global.coveredFactories}/${global.factoryCount}厂；不是全球实际消费`)
    + stat("A · 已披露形成能力", rangeText(global.formed), `${global.formed.known}项；各项数据期不同`)
    + stat("B · 历史调查补充", rangeText(global.historical), `${global.historical.known}项；不与同厂同胎种A重复`)
    + stat("未来／未形成潜在增量", rangeText(global.pipeline), `${global.pipeline.known}项；不并入A+B`);
  $("#nrScenario").textContent = `按${options.loadPct}%情景负荷（非观测开工率）：全球名录${rangeText(global.scenario)}。`
    + (selected ? ` 当前筛选满负荷${rangeText(selected.combined)}，负荷情景${rangeText(selected.scenario)}，可估${selected.coveredFactories}/${selected.factoryCount}厂。` : " 登记线索层不参与耗胶计算。")
    + ` 日能力${options.days ? `按${options.days}天/年假设换算，非企业有效生产天数` : "未年化"}；跳过日能力${global.excluded.daily}项、混合/非适用历史胎种${global.excluded.mixed}项、同厂同胎种已覆盖或不明确${global.excluded.overlap}项、已关闭${global.excluded.closed}厂、FAIL记录${global.excluded.failed}项。已收录但未能估算的厂区不补0。`;
  const buckets = {FORMED: "A 已形成", HISTORICAL: "B 历史补充", PIPELINE: "未来／未形成"};
  $("#nrLedger").innerHTML = `<table><thead><tr><th>国家 · 厂区</th><th>胎种</th><th>分类 / 数据期</th><th>基数 万条/年</th><th>满负荷耗胶 万吨/年</th></tr></thead><tbody>${global.rows.map((r) =>
    `<tr><td><button type="button" data-nr-factory="${escapeHtml(r.factory_id)}">${escapeHtml(r.country)} · ${escapeHtml(r.company)} · ${escapeHtml(r.site)}</button></td><td>${escapeHtml(TYPE[r.type])}</td><td>${buckets[r.bucket]} · ${escapeHtml(r.as_of)}<small>${escapeHtml(r.basis)}</small></td><td>${number(r.capacity_wan, 2)}</td><td>${rangeText(r, "")}</td></tr>`).join("")}</tbody></table>`;
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
  renderNrTotals(records, type, registry);
  $("#tyreStats").innerHTML = stat(registry ? "登记候选地点（非厂数）" : "已收录厂区", `${records.length} 个`, registry ? "办公地址／历史记录仍待剔除" : `详细地址已核 ${addresses} 个`) + stat("分胎种产线", `${lineCount} 项`, `其中已形成能力有据 ${formedCount} 项`)
    + stat("全年有效产能有据", `${effectiveCount} 项`, "未核实保持 MISSING") + stat("厂级年度耗胶有据／可估", `${nrCount} 项`, "仅实耗或实际产量可用");
  renderMap(records, "tyre", country === "all" ? "world" : fitBounds(records), state.activeTyre, JSON.stringify([country, type, status, manufacturer, registry, query]));
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
  renderMap(records, "rubber", country === "all" ? view : fitBounds(records), state.activeRubber, JSON.stringify([country, view, query]));
  $("#rubberDetail").innerHTML = rubberDetail(records.find((item) => item.id === state.activeRubber));
  $("#rubberList").innerHTML = records.map((item) => `<button type="button" data-kind="rubber" data-id="${escapeHtml(item.id)}" class="${item.id === state.activeRubber ? "active" : ""}"><strong>${escapeHtml(item.country)} · ${escapeHtml(item.province || "全国")}</strong><small>${escapeHtml(item.year)} ${escapeHtml(item.data_type)} · ${number(item.production_t)} ${escapeHtml(item.production_unit || "吨")} · ${escapeHtml(item.quality)}</small></button>`).join("") || "<p>当前地图范围没有匹配的产区。</p>";
}

function activate(kind, id) {
  if (kind === "tyre") { state.activeTyre = id; renderTyres(); }
  else { state.activeRubber = id; renderRubber(); }
}

async function start() {
  ["tyre", "rubber"].forEach(bindMapControls);
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
    const nrFactory = event.target.closest("[data-nr-factory]");
    if (nrFactory) {
      $("#tyreEvidence").value = "factory";
      ["#tyreManufacturer", "#tyreCountry", "#tyreType", "#tyreStatus"].forEach((id) => $(id).value = "all");
      $("#tyreSearch").value = "";
      state.activeTyre = nrFactory.dataset.nrFactory;
      renderTyres();
      $("#tyreDetail").scrollIntoView({behavior: "smooth", block: "start"});
    }
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
  ["#nrDays", "#nrLoad"].forEach((id) => $(id).addEventListener("input", () => state.tyre && renderTyres()));
}

function matchesTyreType(item, type) {
  return type === "all" || item.lines.some((line) => line.type === type)
    || (item.survey_observations || []).some((o) => o.comparable_type === type);
}

if (typeof document !== "undefined") start();
if (typeof module !== "undefined") module.exports = {nrRange, sumRanges, aggregateNr, estimateNr, designNr, formedNr, sumKnown, factorySummary, fitBounds, matchesTyreType, coords, mapViewBox, adjustMapView};
