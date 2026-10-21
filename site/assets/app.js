"use strict";

const state = { data: null, history: [], thailandRain: null, productionWeights: null, climateOutlooks: null, mapViews: {}, filtered: [], activeId: null };
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[char]);
const hasNumber = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
const number = (value, digits = 1) => hasNumber(value) ? Number(value).toFixed(digits) : "—";
const percent = (value) => hasNumber(value) ? `${number(value)}%` : "—";
const sum = (values) => values.reduce((total, value) => total + Number(value || 0), 0);
const formatTons = (value) => hasNumber(value) ? `${new Intl.NumberFormat("zh-CN").format(Math.round(Number(value)))} 吨` : "MISSING";

const LABELS = {
  HEAVY_RAIN: "强降雨关注",
  DRY: "少雨关注",
  HEAT: "高温关注",
  NORMAL: "常规",
};

const COLORS = {
  HEAVY_RAIN: "#2878c7",
  DRY: "#d58313",
  HEAT: "#c14b36",
  NORMAL: "#0b675c",
};

const ANOMALY_LABELS = {
  BELOW_P10: "显著偏少",
  BELOW_NORMAL: "偏少",
  NEAR_NORMAL: "正常",
  ABOVE_NORMAL: "偏多",
  ABOVE_P90: "显著偏多",
};

function anomalyBadge(item) {
  if (!item || !item.category) return '<span class="anom anom-missing" title="季节基准或数据缺失">MISSING</span>';
  const pct = hasNumber(item.anomaly_pct) ? `${item.anomaly_pct > 0 ? "+" : ""}${item.anomaly_pct}%` : "";
  const title = `当前 ${number(item.value_mm)} mm；常年均值 ${number(item.normal_mm)} mm${pct ? `（较均值 ${pct}）` : ""}；常年正常区间（第33–67百分位）${number(item.p33_mm)}–${number(item.p67_mm)} mm。降雨分布偏斜，档位按历年同期百分位判断，比均值百分比更可靠。`;
  const sourceNote = { IMERG: "数据：NASA IMERG卫星实况（UTC日）。", MODEL: "数据：Open-Meteo模式估算（卫星存档不完整时的替代）。", FORECAST: "数据：Open-Meteo预报。" }[item.source] || "";
  return `<span class="anom anom-${item.category.toLowerCase().replace(/_/g, "-")}" title="${escapeHtml(sourceNote + title)}">${ANOMALY_LABELS[item.category] || escapeHtml(item.category)}</span>`;
}

const RAIN_CHANGE_ALERT_MM = 25;
const VERIFICATION_ERROR_ALERT_MM = 25;

function primaryState(station) {
  return station.summary?.weather_states?.[0] || "NORMAL";
}

function formatUpdate(value) {
  if (!value) return "当前无法确认最新数据";
  const date = new Date(value);
  return `更新于 ${new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date)}（北京时间）`;
}

function freshnessStatus(status, dateValue, maximumAgeHours) {
  const normalized = ["PASS", "WARNING", "MISSING"].includes(status) ? status : "MISSING";
  const timestamp = Date.parse(dateValue || "");
  if (normalized === "MISSING" || !Number.isFinite(timestamp)) return "MISSING";
  const ageHours = (Date.now() - timestamp) / 36e5;
  return normalized === "WARNING" || ageHours > maximumAgeHours || ageHours < -1 ? "WARNING" : "PASS";
}

function freshnessDate(value, prefix = "截至") {
  if (!value || !Number.isFinite(Date.parse(value))) return "日期待确认";
  const date = new Date(value);
  const options = {timeZone:"Asia/Shanghai", year:"numeric", month:"2-digit", day:"2-digit"};
  if (String(value).includes("T")) Object.assign(options, {hour:"2-digit", minute:"2-digit", hour12:false});
  return `${prefix} ${new Intl.DateTimeFormat("zh-CN", options).format(date)}`;
}

function productionWeight(station) {
  return state.productionWeights?.stations?.[station?.station_id] || null;
}

function productionMeta(station) {
  return state.productionWeights?.countries?.[station?.country] || {};
}

function productionContext(stations, country = $("#countryFilter")?.value || "all") {
  const shareKey = "share_of_country_pct";
  const denominator = country === "all" ? "（请筛选单一国家看同口径权重）" : `${country}产量`;
  const entries = stations.map((station) => ({station, weight: productionWeight(station)}))
    .filter((item) => country !== "all" && hasNumber(item.weight?.[shareKey]) && hasNumber(item.weight?.estimated_production_t));
  return {shareKey, denominator, entries, coveragePct: sum(entries.map((item) => item.weight[shareKey]))};
}

function productionExposure(stations, code, country = $("#countryFilter")?.value || "all") {
  const affected = stations.filter((station) => station.summary?.weather_states?.includes(code));
  const context = productionContext(affected, country);
  return {...context, affectedCount: affected.length};
}

function renderFreshness() {
  const weather = state.data || {};
  const observation = weather.observation_source || {};
  const history = state.thailandRain || {};
  const historyDates = (history.regions || []).flatMap((region) => (region.weekly || []).map((item) => item.week_end)).filter(Boolean).sort();
  const climate = state.climateOutlooks || {};
  const climateStatuses = Object.values(climate.products || {}).map((product) => product.quality_status || "MISSING");
  const climateQuality = !climateStatuses.length || climateStatuses.every((value) => value === "MISSING")
    ? "MISSING" : climateStatuses.every((value) => value === "PASS") ? "PASS" : "WARNING";
  const weights = state.productionWeights || {};
  const weightCount = Object.keys(weights.stations || {}).length;
  const weightYears = [...new Set(Object.values(weights.countries || {}).map((item) => item.reference_year).filter(Boolean))].sort();
  const cards = [
    {
      title: "天气预报",
      status: freshnessStatus(weather.overall_quality_status, weather.generated_at_utc, 36),
      date: freshnessDate(weather.generated_at_utc, "更新"),
      note: `${weather.quality_counts?.PASS ?? 0}/${weather.stations?.length ?? 0}个地点通过；超过36小时未更新转WARNING`,
    },
    {
      title: "IMERG实况",
      status: freshnessStatus(observation.quality_status, observation.end_at_utc, 96),
      date: freshnessDate(observation.end_at_utc),
      note: "NASA Late Run 24h/72h；允许约4天产品时滞",
    },
    {
      title: "历史监测",
      status: freshnessStatus(history.overall_quality_status, historyDates.at(-1), 24 * 14),
      date: freshnessDate(historyDates.at(-1), "最新完整周截至"),
      note: "泰国分区周度降雨；超过14天未形成完整周转WARNING",
    },
    {
      title: "气候展望",
      status: freshnessStatus(climateQuality, climate.updated_at_utc, 48),
      date: freshnessDate(climate.updated_at_utc, "检查"),
      note: `${climateStatuses.filter((value) => value === "PASS").length}/${climateStatuses.length || 4}项产品通过；超过48小时未检查转WARNING`,
    },
    {
      title: "产量权重",
      status: weights.overall_quality_status || "MISSING",
      date: weightYears.length ? `基准 ${weightYears.join("/")}年` : "年份待确认",
      note: `${weightCount}/${weather.stations?.length ?? 0}个地点已接入；泰国2025f生胶片、印尼2024干胶，不跨国加总`,
    },
  ];
  $("#freshnessGrid").innerHTML = cards.map((card) => `<article class="freshness-card">
    <div><h3>${escapeHtml(card.title)}</h3><span class="freshness-status ${card.status.toLowerCase()}">${card.status}</span></div>
    <time>${escapeHtml(card.date)}</time><small>${escapeHtml(card.note)}</small>
  </article>`).join("");
}

function populateProductionWeightMethod() {
  const weights = state.productionWeights || {};
  const d = weights.denominators || {};
  const status = weights.overall_quality_status || "MISSING";
  $("#weightStatus").textContent = `${status} · ${weights.data_type || "MISSING"}`;
  $("#weightThailandTotal").textContent = formatTons(d.thailand_2025_production_t);
  $("#weightIndonesiaTotal").textContent = formatTons(d.indonesia_2024_production_t);
  $("#weightWorldTotal").textContent = formatTons(d.world_2025_production_t);
  $("#weightCoverage").textContent = hasNumber(d.tracked_share_of_thailand_pct)
    ? `泰国 ${number(d.tracked_share_of_thailand_pct, 2)}% / 印尼 ${number(d.tracked_share_of_indonesia_pct, 2)}%；两国产量单位不同，不计算跨国占比`
    : "当前无法确认最新数据";
  $("#weightMethod").textContent = weights.methodology || "统一省级产量权重尚未接入，缺失时不以代表点数量替代。";
  const bps = weights.sources?.find((source) => source.source_name?.includes("BPS"));
  if (bps?.url) $("#weightDocs").href = bps.url;
  const oae = weights.sources?.find((source) => source.source_name?.includes("OAE"));
  if (oae?.url) $("#weightThaiDocs").href = oae.url;
}

function temperatureMissingFigure() {
  return '<figure class="cpc-figure"><div class="temperature-missing" role="img" aria-label="周度气温距平图待归档"><strong>MISSING</strong><span>等待官方周图归档</span></div><figcaption>历史周图待补齐</figcaption></figure>';
}

async function loadTemperatureHistory() {
  try {
    const response = await fetch(`assets/climate/seasia-temperature-history.json?v=${Date.now()}`, {cache:"no-store"});
    if (!response.ok) return;
    const history = await response.json();
    const items = (history.items || []).slice(0, 4);
    const figures = items.map((item) => `<figure class="cpc-figure">
      <img src="assets/climate/${escapeHtml(item.filename)}" alt="NOAA CPC东南亚周度气温距平分布" loading="lazy" decoding="async">
      <figcaption>官方周图 · 归档于 ${escapeHtml(String(item.captured_at_utc || "").slice(0, 10))} UTC（有效期见图内标题）</figcaption>
    </figure>`);
    figures.push(...Array.from({length: 4 - figures.length}, temperatureMissingFigure));
    $("#seasiaTempGrid").innerHTML = figures.join("");
    $("#seasiaTempArchiveMeta").textContent = `已归档${items.length}/4个不同官方周图；不足部分保持MISSING。`;
  } catch (error) {
    console.warn("Southeast Asia temperature archive unavailable", error);
  }
}

function setupOutlookTabs() {
  const tabs = [...document.querySelectorAll(".outlook-tab")];
  const select = (tab) => {
    tabs.forEach((item) => {
      const active = item === tab;
      item.setAttribute("aria-selected", String(active));
      item.tabIndex = active ? 0 : -1;
      document.getElementById(item.getAttribute("aria-controls")).hidden = !active;
    });
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      const step = event.key === "ArrowRight" ? 1 : -1;
      const next = tabs[(index + step + tabs.length) % tabs.length];
      select(next);
      next.focus();
    });
  });
}

function renderOutlookProduct(product, gridId, metaId) {
  const grid = document.getElementById(gridId);
  const meta = document.getElementById(metaId);
  const images = product?.images || [];
  if (!images.length) {
    grid.innerHTML = '<div class="temperature-missing" role="status"><strong>MISSING</strong><span>尚未取得官方图表</span></div>';
    meta.textContent = "当前无法确认最新数据。";
    return;
  }
  grid.innerHTML = images.map((item) => {
    const path = `assets/climate/${escapeHtml(item.filename)}`;
    return `<figure class="cpc-figure"><a href="${path}" target="_blank" rel="noreferrer"><img src="${path}" alt="${escapeHtml(product.title)}：${escapeHtml(item.label)}" loading="lazy" decoding="async"></a><figcaption>${escapeHtml(item.label)}</figcaption></figure>`;
  }).join("");
  const status = product.quality_status || "MISSING";
  const period = product.issued ? `发布 ${escapeHtml(product.issued)}` : `起报/${escapeHtml(product.source_period || "未知")}`;
  const valid = (product.valid_periods || []).length ? `；有效期 ${escapeHtml(product.valid_periods.join("；"))}` : "";
  const retained = product.warning ? "；本次更新失败，已保留上次图表" : "";
  meta.innerHTML = `<span class="outlook-status ${escapeHtml(status.toLowerCase())}">${escapeHtml(status)}</span> · ${escapeHtml(product.data_type || "ESTIMATE")} · ${period}${valid}${retained}；来源：<a href="${escapeHtml(product.documentation)}" target="_blank" rel="noreferrer">${escapeHtml(product.source_name)}</a>。`;
}

async function loadExtendedOutlooks() {
  const products = [
    ["gth", "gthOutlookGrid", "gthOutlookMeta"],
    ["iri_precip", "iriPrecipGrid", "iriPrecipMeta"],
    ["nmme_precip", "nmmePrecipGrid", "nmmePrecipMeta"],
    ["nmme_temperature", "nmmeTemperatureGrid", "nmmeTemperatureMeta"],
  ];
  try {
    const response = await fetch(`assets/climate/climate-outlook-manifest.json?v=${Date.now()}`, {cache:"no-store"});
    if (!response.ok) throw new Error(`climate-outlook-manifest.json ${response.status}`);
    const manifest = await response.json();
    state.climateOutlooks = manifest;
    products.forEach(([key, grid, meta]) => renderOutlookProduct(manifest.products?.[key], grid, meta));
    renderFreshness();
    if (state.data) renderWeeklySummary();
  } catch (error) {
    console.warn("Extended climate outlooks unavailable", error);
    state.climateOutlooks = null;
    products.forEach(([, grid, meta]) => renderOutlookProduct(null, grid, meta));
    renderFreshness();
    if (state.data) renderWeeklySummary();
  }
}

function populateSources(data) {
  const source = data.source || {};
  $("#sourceName").textContent = source.source_name || "当前无法确认最新数据";
  $("#sourceNature").textContent = source.data_nature || "当前无法确认最新数据";
  $("#sourceModels").textContent = source.upstream_models || "当前无法确认最新数据";
  $("#sourceAccess").textContent = source.access || "当前无法确认最新数据";
  $("#scopeNote").textContent = data.scope_note || "当前无法确认最新数据";
  if (source.documentation) $("#sourceDocs").href = source.documentation;
  const tapping = data.tapping_window || {};
  const start = String(tapping.start_hour_local ?? "—").padStart(2, "0");
  const end = String(tapping.end_hour_local ?? "—").padStart(2, "0");
  $("#tappingWindowText").textContent = `${start}:00–${end}:00（各地当地时间）；${tapping.note || "当前无法确认最新数据"}`;
  const observation = data.observation_source || {};
  $("#imergSourceName").textContent = observation.source_name || "NASA GPM IMERG Late Run GIS";
  $("#imergNature").textContent = observation.data_nature || "当前无法确认最新数据";
  $("#imergResolution").textContent = observation.spatial_resolution || "当前无法确认最新数据";
  $("#imergPeriod").textContent = observation.periods || "当前无法确认最新数据";
  $("#imergStatus").textContent = `${observation.quality_status || "MISSING"}${observation.end_at_utc ? ` · ${observation.end_at_utc.slice(0, 10)} UTC` : ""}`;
  $("#imergNote").textContent = observation.availability_note || "累计量为卫星多源融合估算，与模式预报分层展示。";
  if (observation.documentation) $("#imergDocs").href = observation.documentation;
  const t = data.thresholds || {};
  $("#thresholdText").textContent = `研究筛选阈值：7日累计降雨 ≥ ${t.heavy_rain_total_7d_mm ?? "—"} mm 为强降雨关注，< ${t.dry_total_7d_mm ?? "—"} mm 为少雨关注，日最高温 ≥ ${t.hot_day_max_c ?? "—"}℃ 为高温关注。`;
  $("#heavyRule").textContent = `7日累计 ≥ ${t.heavy_rain_total_7d_mm ?? "—"} mm`;
  $("#dryRule").textContent = `7日累计 < ${t.dry_total_7d_mm ?? "—"} mm`;
  $("#heatRule").textContent = `最高温 ≥ ${t.hot_day_max_c ?? "—"}℃`;
}

function previousSnapshot() {
  const snapshots = state.history || [];
  if (snapshots.length < 2) return null;
  return snapshots[snapshots.length - 2];
}

function rainChange(station) {
  const previous = previousSnapshot();
  if (!previous) return null;
  const old = previous.stations?.find((item) => item.station_id === station.station_id);
  const currentValue = station.summary?.precipitation_7d_mm;
  if (!old || currentValue == null || old.precipitation_7d_mm == null) return null;
  return Number((currentValue - old.precipitation_7d_mm).toFixed(1));
}

function thailandFourWeekSignal() {
  const region = state.thailandRain?.regions?.find((item) => item.region_id === "th_key_regions");
  const valid = (region?.weekly || []).filter((item) => hasNumber(item.precipitation_mm) && hasNumber(item.iso_year) && hasNumber(item.iso_week));
  if (valid.length < 5) return null;
  const latestYear = Math.max(...valid.map((item) => Number(item.iso_year)));
  const current = valid.filter((item) => Number(item.iso_year) === latestYear).slice(-4);
  if (current.length < 4) return null;
  const baseline = current.map((item) => valid
    .filter((other) => Number(other.iso_year) < latestYear && Number(other.iso_week) === Number(item.iso_week))
    .map((other) => Number(other.precipitation_mm))).map((values) => values.length ? sum(values) / values.length : null);
  if (baseline.some((value) => value == null)) return null;
  const currentTotal = sum(current.map((item) => item.precipitation_mm));
  const baselineTotal = sum(baseline);
  return {
    currentTotal,
    baselineTotal,
    anomalyPct: baselineTotal ? (currentTotal - baselineTotal) / baselineTotal * 100 : null,
    endDate: current.at(-1).week_end,
    baselineYears: [...new Set(valid.filter((item) => Number(item.iso_year) < latestYear).map((item) => Number(item.iso_year)))],
  };
}

function populateCountries(stations) {
  const select = $("#countryFilter");
  const current = select.value;
  const countries = [...new Set(stations.map((item) => item.country))];
  select.innerHTML = '<option value="all">全部国家</option>' + countries.map((country) => `<option value="${escapeHtml(country)}">${escapeHtml(country)}</option>`).join("");
  select.value = countries.includes(current) ? current : "all";
}

function scopedStations() {
  const country = $("#countryFilter").value;
  const query = $("#searchInput").value.trim().toLowerCase();
  return (state.data?.stations || []).filter((station) => {
    const haystack = `${station.country} ${station.region} ${station.place}`.toLowerCase();
    return (country === "all" || station.country === country)
      && (!query || haystack.includes(query));
  });
}

function filterStations() {
  const status = $("#stateFilter").value;
  state.filtered = scopedStations().filter((station) => status === "all" || station.summary?.weather_states?.includes(status));
  if (!state.filtered.some((item) => item.station_id === state.activeId)) {
    state.activeId = state.filtered[0]?.station_id || null;
  }
  render();
}

function renderMetrics() {
  const stations = scopedStations();
  const rain = stations.map((item) => item.summary?.precipitation_7d_mm).filter((value) => value != null);
  $("#avgRain").textContent = rain.length ? `${number(sum(rain) / rain.length)} mm` : "—";
  const context = productionContext(stations);
  const weightedRainEntries = context.entries.filter((item) => hasNumber(item.station.summary?.precipitation_7d_mm));
  const productionTotal = sum(weightedRainEntries.map((item) => item.weight.estimated_production_t));
  const weightedRain = productionTotal
    ? sum(weightedRainEntries.map((item) => Number(item.station.summary.precipitation_7d_mm) * Number(item.weight.estimated_production_t))) / productionTotal
    : null;
  $("#weightedRain").textContent = weightedRain == null
    ? "跨国产量口径不可加总；请筛选单一国家。上方为地点等权"
    : `产量加权 ${number(weightedRain)} mm；覆盖${number(context.coveragePct, 2)}%${context.denominator}`;
  for (const code of ["HEAVY_RAIN", "DRY", "HEAT"]) {
    const count = stations.filter((item) => item.summary?.weather_states?.includes(code)).length;
    $(`#${code === "HEAVY_RAIN" ? "heavy" : code.toLowerCase()}Count`).textContent = `${count} 个`;
    const exposure = productionExposure(stations, code);
    const exposureId = code === "HEAVY_RAIN" ? "heavyExposure" : `${code.toLowerCase()}Exposure`;
    $(`#${exposureId}`).textContent = context.entries.length
      ? `已纳入权重产量暴露 ${number(exposure.coveragePct, 2)}%${context.denominator}（${exposure.entries.length}/${count}点）`
      : "请筛选单一国家查看同口径产量暴露";
  }
  $("#resultCount").textContent = `${state.filtered.length}个地点`;
  document.querySelectorAll("[data-weather-filter]").forEach((card) => {
    card.setAttribute("aria-pressed", String(card.dataset.weatherFilter === $("#stateFilter").value));
  });
}

function activateMetricFilter(status) {
  if (!state.data) return;
  $("#stateFilter").value = status;
  filterStations();
  const target = state.filtered.length === 1 ? $("#detailPanel") : $("#sevenDayTitle").closest(".panel");
  target.scrollIntoView({behavior:"smooth", block:"start"});
}

function renderWeeklySummary() {
  const stations = state.data?.stations || [];
  if (!stations.length) {
    $("#weeklySummary").innerHTML = '<p class="weekly-summary-note">当前无法确认最新数据。</p>';
    return;
  }

  const thresholds = state.data.thresholds || {};
  const heavy = stations.filter((station) => station.summary?.weather_states?.includes("HEAVY_RAIN"));
  const dry = stations.filter((station) => station.summary?.weather_states?.includes("DRY"));
  const heat = stations.filter((station) => station.summary?.weather_states?.includes("HEAT"));
  const tappingRain = stations.filter((station) => Number(station.summary?.tapping_window_rain_days_7d || 0) > 0);
  const thaiContext = productionContext(stations.filter((station) => station.country === "泰国"), "泰国");
  const heavyExposure = productionExposure(stations.filter((station) => station.country === "泰国"), "HEAVY_RAIN", "泰国");
  const dryExposure = productionExposure(stations.filter((station) => station.country === "泰国"), "DRY", "泰国");
  const stationName = (station) => `${station.country}·${station.region}·${station.place}`;
  const previous = previousSnapshot();
  const previousById = new Map((previous?.stations || []).map((station) => [station.station_id, station]));
  const transitions = {entered: [], exited: []};
  stations.forEach((station) => {
    const old = previousById.get(station.station_id);
    if (!old) return;
    const currentStates = new Set(station.summary?.weather_states || []);
    const oldStates = new Set(old.weather_states || []);
    ["HEAVY_RAIN", "DRY", "HEAT"].forEach((code) => {
      if (currentStates.has(code) && !oldStates.has(code)) transitions.entered.push({station, code});
      if (!currentStates.has(code) && oldStates.has(code)) transitions.exited.push({station, code});
    });
  });
  const transitionText = (items) => ["HEAVY_RAIN", "DRY", "HEAT"].map((code) => {
    const matched = items.filter((item) => item.code === code);
    if (!matched.length) return null;
    const names = matched.slice(0, 3).map((item) => stationName(item.station)).join("、");
    return `${LABELS[code]}：${names}${matched.length > 3 ? `等${matched.length}点` : ""}`;
  }).filter(Boolean).join("；") || "无";
  const rainChanges = stations.map((station) => ({station, change: rainChange(station)}))
    .filter((item) => hasNumber(item.change) && Math.abs(item.change) >= RAIN_CHANGE_ALERT_MM);
  const changeText = (items) => items.length
    ? items.slice(0, 3).map((item) => `${stationName(item.station)} ${item.change > 0 ? "+" : ""}${number(item.change)} mm`).join("；")
    : "无";
  const rainUp = rainChanges.filter((item) => item.change > 0).sort((a, b) => b.change - a.change);
  const rainDown = rainChanges.filter((item) => item.change < 0).sort((a, b) => a.change - b.change);
  const comparableVerification = [];
  const verificationMismatches = [];
  stations.forEach((station) => {
    const candidates = ["72h", "24h"].map((period) => {
      const values = station.verification?.[period] || {};
      if (!hasNumber(values.forecast_mm) || !hasNumber(values.observed_mm)) return null;
      return {station, period, forecast: Number(values.forecast_mm), observed: Number(values.observed_mm), difference: Number(values.observed_mm) - Number(values.forecast_mm)};
    }).filter(Boolean).sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
    if (candidates[0]) comparableVerification.push(candidates[0]);
    if (candidates[0] && Math.abs(candidates[0].difference) >= VERIFICATION_ERROR_ALERT_MM) verificationMismatches.push(candidates[0]);
  });
  verificationMismatches.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
  const verificationText = verificationMismatches.length
    ? verificationMismatches.slice(0, 3).map((item) => `${stationName(item.station)} ${item.period}实况${item.difference > 0 ? "高于" : "低于"}预报${number(Math.abs(item.difference))} mm`).join("；")
    : comparableVerification.length ? `未发现绝对误差 ≥ ${VERIFICATION_ERROR_ALERT_MM} mm 的地点` : "尚无可对齐样本，等待每日快照覆盖验证期";
  const fourWeek = thailandFourWeekSignal();
  const fourWeekText = fourWeek
    ? `泰国重点区域最近4个完整周累计${number(fourWeek.currentTotal)} mm，2022年至上一年同周均值${number(fourWeek.baselineTotal)} mm，偏差${fourWeek.anomalyPct >= 0 ? "+" : ""}${number(fourWeek.anomalyPct)}%；截至${fourWeek.endDate}。`
    : "泰国周度序列不足，2–8周水分背景保持MISSING。";
  const climateProducts = Object.values(state.climateOutlooks?.products || {});
  const climateAvailable = climateProducts.filter((item) => item.quality_status !== "MISSING");
  const climateWarning = climateProducts.filter((item) => item.quality_status === "WARNING").length;
  const climatePeriods = [...new Set(climateAvailable.map((item) => item.source_period || item.issued).filter(Boolean))];
  const climateText = climateAvailable.length
    ? `${climateAvailable.length}/${climateProducts.length}项中期及季节产品可用，${climateWarning}项为WARNING；当前起报/发布日期：${climatePeriods.join("、") || "见各图内标题"}。`
    : "中期及季节展望尚未完成质量检查，保持MISSING。";
  const dates = stations.find((station) => station.daily?.length)?.daily || [];
  const period = dates.length ? `${dates[0].date}—${dates[dates.length - 1].date}` : "D0–D6";
  $("#weeklyPeriod").textContent = `${period} · 全部${stations.length}点`;

  let judgment = "0–7天先核验晨间割胶作业窗、原料到量和开割率；2–8周再看周度降雨与深层土壤水分是否持续；1–6月气候图只作背景。";
  if (heavy.length) {
    judgment += " 强降雨关注点需验证是否连续阻断割胶，而不是把降雨机械解释为供应利多。";
  } else if (dry.length) {
    judgment += " 少雨关注点需结合9–81cm土壤水分和物候确认是否形成实际供给约束。";
  }
  judgment += " 当前面板未接入原料价格、库存及RU/NR基差月差，因此价格是否已反映仍待跨模块验证。";

  $("#weeklySummary").innerHTML = `
    <article class="weekly-summary-block">
      <h3>【预报 / 估算】0–7天 · 作业扰动</h3>
      <p>${tappingRain.length}/${stations.length}个代表点的晨间割胶作业窗至少1天受雨（当日累计≥1 mm）；强降雨关注${heavy.length}个、少雨关注${dry.length}个、高温关注${heat.length}个。</p>
      <p>泰国同口径2025f生胶片产量中，强降雨关注府占${number(heavyExposure.coveragePct, 2)}%，少雨关注府占${number(dryExposure.coveragePct, 2)}%。</p>
      <small>阈值：7日降雨 ≥ ${thresholds.heavy_rain_total_7d_mm ?? "—"} mm / &lt; ${thresholds.dry_total_7d_mm ?? "—"} mm，日最高温 ≥ ${thresholds.hot_day_max_c ?? "—"}℃。泰国权重覆盖${number(thaiContext.coveragePct, 2)}%同版全国产量；生胶片与其他国家干胶不可加总。</small>
    </article>
    <article class="weekly-summary-block">
      <h3>【事实】2–8周 · 水分背景</h3>
      <p>${escapeHtml(fourWeekText)}</p>
      <small>仅为泰国8个ERA5代表网格等权序列；不能替代全产区面积加权降雨或土壤墒情。</small>
    </article>
    <article class="weekly-summary-block">
      <h3>【事实】变化与兑现</h3>
      <p>新进入：${escapeHtml(previous ? transitionText(transitions.entered) : "历史快照不足")}</p>
      <p>退出：${escapeHtml(previous ? transitionText(transitions.exited) : "历史快照不足")}</p>
      <p>上调：${escapeHtml(changeText(rainUp))}</p>
      <p>下调：${escapeHtml(changeText(rainDown))}</p>
      <p>${escapeHtml(verificationText)}</p>
      <small>预报调整阈值${RAIN_CHANGE_ALERT_MM} mm；IMERG偏离阈值${VERIFICATION_ERROR_ALERT_MM} mm。</small>
    </article>
    <article class="weekly-summary-block">
      <h3>【事实】1–6月 · 气候背景</h3>
      <p>${escapeHtml(climateText)}</p>
      <small>概率与距平图不可直接换算为省级产量损失；须由后续天气实况和供应数据验证。</small>
    </article>
    <article class="weekly-summary-block weekly-summary-judgment">
      <h3>【本项目判断】后续验证指标</h3>
      <p>${escapeHtml(judgment)} 天气信号不等于天然橡胶供应或价格结论，仍需结合物候、原料供应、库存和价格结构验证。</p>
      <small>产量权重：${escapeHtml(state.productionWeights?.data_type || "MISSING")} / ${escapeHtml(state.productionWeights?.overall_quality_status || "MISSING")}；未接入权重的地点不参与产量暴露合计。</small>
    </article>`;
}

// ---------- 地图：TopoJSON 省界 + 距平填色 ----------
// 图层由 scripts/build-map-layers.mjs 生成（site/data/maps/*.topo.json）：
//   land  = 周边国家陆地轮廓（Natural Earth 1:10m 中国观点版）
//   admin = 泰国77府、印尼省、越南63省、中国南部4省、科特迪瓦33区；station_ids 为落在区内的代表点
const MAP_VIEWS = {
  mainland: { title: "泰国、越南与中国南部", source: "asia", countries: ["泰国", "越南", "中国"], bounds: { west: 97.2, east: 111.6, south: 5.3, north: 24.9 } },
  indonesia: { title: "印度尼西亚：苏门答腊与西加里曼丹", source: "asia", countries: ["印度尼西亚"], bounds: { west: 94.8, east: 110.6, south: -6.3, north: 6.2 } },
  africa: { title: "科特迪瓦", source: "africa", countries: ["科特迪瓦"], bounds: { west: -8.7, east: -2.4, south: 4.2, north: 10.8 } },
};
const MAP_FOCUS = {
  泰国: { view: "mainland", bounds: { west: 97.2, east: 105.9, south: 5.4, north: 20.6 } },
  越南: { view: "mainland", bounds: { west: 102, east: 109.8, south: 8.4, north: 23.5 } },
  中国: { view: "mainland", bounds: { west: 97.4, east: 111.4, south: 17.8, north: 24.9 } },
  印度尼西亚: { view: "indonesia" },
  科特迪瓦: { view: "africa" },
};
const MAP_LAYERS = {
  forecast_7d: { label: "未来7日", hint: "未来7日预报降雨与常年同期比" },
  past_7d: { label: "过去7日", hint: "过去7日降雨（卫星实况优先）与常年同期比" },
  past_30d: { label: "过去30日", hint: "过去30日降雨（卫星实况优先）与常年同期比" },
  ensemble: { label: "集合概率", hint: "ECMWF 51成员集合预报中，未来7日降雨偏多或偏少的成员比例" },
  weight: { label: "产量权重", hint: "代表点所在区占本国产量的比例" },
};
const ENSEMBLE_LABELS = {
  BELOW_P10: "偏少概率≥80%",
  BELOW_NORMAL: "偏少概率≥60%",
  NEAR_NORMAL: "无明显倾向",
  ABOVE_NORMAL: "偏多概率≥60%",
  ABOVE_P90: "偏多概率≥80%",
};

// 集合概率 → 与距平同一套色阶：强倾向用深色，明显倾向用浅色
function ensembleCategory(ens) {
  if (!ens || ens.quality_status !== "PASS") return null;
  const up = Number(ens.prob_above_normal_pct);
  const down = Number(ens.prob_below_normal_pct);
  if (up >= 80) return "ABOVE_P90";
  if (down >= 80) return "BELOW_P10";
  if (up >= 60) return "ABOVE_NORMAL";
  if (down >= 60) return "BELOW_NORMAL";
  return "NEAR_NORMAL";
}

function ensembleText(ens) {
  if (!ens || ens.quality_status !== "PASS") return "集合预报缺失";
  return `偏多概率 ${ens.prob_above_normal_pct}%、偏少概率 ${ens.prob_below_normal_pct}%（常年各约33%）；中位数 ${number(ens.median_mm, 0)} mm，10–90% 区间 ${number(ens.p10_mm, 0)}–${number(ens.p90_mm, 0)} mm`;
}
const ANOMALY_ORDER = ["BELOW_P10", "BELOW_NORMAL", "NEAR_NORMAL", "ABOVE_NORMAL", "ABOVE_P90"];
const WEIGHT_STEPS = [[8, "≥8%"], [4, "4–8%"], [2, "2–4%"], [1, "1–2%"], [0, "<1%"]];
state.mapLayer = "forecast_7d";
state.topo = {};
state.mapCache = {};

function topoFeatures(topology, name) {
  const object = topology?.objects?.[name];
  if (!object) return [];
  const { scale = [1, 1], translate = [0, 0] } = topology.transform || {};
  const arcs = topology.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * scale[0] + translate[0], y * scale[1] + translate[1]];
    });
  });
  const arcPoints = (index) => (index >= 0 ? arcs[index] : arcs[~index].slice().reverse());
  const ring = (indexes) => indexes.flatMap((index, k) => (k ? arcPoints(index).slice(1) : arcPoints(index)));
  const geometry = (g) => (g.type === "Polygon" ? { type: "Polygon", coordinates: g.arcs.map(ring) }
    : g.type === "MultiPolygon" ? { type: "MultiPolygon", coordinates: g.arcs.map((polygon) => polygon.map(ring)) } : null);
  return object.geometries.map((g) => ({ properties: g.properties || {}, geometry: geometry(g) })).filter((f) => f.geometry);
}

// 等距圆柱投影，按视窗中纬度做经向压缩，避免形状横向拉伸
function makeProjection(bounds, width) {
  const k = Math.cos(((bounds.north + bounds.south) / 2) * Math.PI / 180);
  const scale = width / ((bounds.east - bounds.west) * k);
  const height = Math.round((bounds.north - bounds.south) * scale);
  return { width, height, point: ([lon, lat]) => [(lon - bounds.west) * k * scale, (bounds.north - lat) * scale] };
}

function pathData(geometry, projection) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let d = "";
  for (const polygon of polygons) {
    for (const ringCoords of polygon) {
      let last = "";
      ringCoords.forEach((coordinate, index) => {
        const [x, y] = projection.point(coordinate);
        const key = `${x.toFixed(1)},${y.toFixed(1)}`;
        if (key === last) return;
        d += (index ? "L" : "M") + key;
        last = key;
      });
      d += "Z";
    }
  }
  return d;
}

function inBounds(geometry, b) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some((polygon) => polygon[0].some(([lon, lat]) => lon >= b.west - 1 && lon <= b.east + 1 && lat >= b.south - 1 && lat <= b.north + 1));
}

// 投影后的路径只算一次并缓存；筛选、切换图层只改 class
function mapGeometry(key, bounds, width) {
  const cacheKey = `${key}:${bounds.west},${bounds.east},${bounds.south},${bounds.north}:${width}`;
  if (state.mapCache[cacheKey]) return state.mapCache[cacheKey];
  const topology = state.topo[MAP_VIEWS[key].source];
  if (!topology) return null;
  const projection = makeProjection(bounds, width);
  const land = topoFeatures(topology, "land").filter((f) => inBounds(f.geometry, bounds)).map((f) => pathData(f.geometry, projection));
  const admin = topoFeatures(topology, "admin").filter((f) => inBounds(f.geometry, bounds)).map((f) => ({
    d: pathData(f.geometry, projection),
    name: f.properties.name,
    country: f.properties.country,
    stationIds: String(f.properties.station_ids || "").split(",").filter(Boolean),
  }));
  state.mapCache[cacheKey] = { projection, land, admin };
  return state.mapCache[cacheKey];
}

function stationAnomaly(station, layer) {
  if (layer === "ensemble") {
    const ens = station?.climate_context?.forecast_7d_ensemble;
    const category = ensembleCategory(ens);
    return category ? { ...ens, category } : null;
  }
  return station?.climate_context?.[layer] || null;
}

// 一个区内有多个代表点时（如海南4点），按产量权重取主导档位；无权重则取出现最多的档位
function regionCategory(stations, layer) {
  const votes = new Map();
  stations.forEach((station) => {
    const category = stationAnomaly(station, layer)?.category;
    if (!category) return;
    const weight = Number(productionWeight(station)?.share_of_country_pct || 1);
    votes.set(category, (votes.get(category) || 0) + weight);
  });
  return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

function weightClass(stations) {
  const shares = stations.map((station) => Number(productionWeight(station)?.share_of_country_pct)).filter(Number.isFinite);
  if (!shares.length) return "fill-none";
  const total = shares.reduce((a, b) => a + b, 0);
  const index = WEIGHT_STEPS.findIndex(([floor]) => total >= floor);
  return `fill-w${WEIGHT_STEPS.length - 1 - index}`;
}

function regionTitle(region, stations, layer) {
  const base = `${region.country} · ${region.name}`;
  if (!stations.length) return `${base}：无代表点`;
  if (layer === "weight") {
    const parts = stations.map((s) => `${s.place} ${hasNumber(productionWeight(s)?.share_of_country_pct) ? `${number(productionWeight(s).share_of_country_pct, 1)}%` : "权重缺失"}`);
    return `${base}：${parts.join("；")}（占本国产量）`;
  }
  if (layer === "ensemble") {
    return `${base}：${stations.map((s) => `${s.place} ${ensembleText(s.climate_context?.forecast_7d_ensemble)}`).join("；")}`;
  }
  const parts = stations.map((s) => {
    const item = stationAnomaly(s, layer);
    if (!item?.category) return `${s.place} 基准或数据缺失`;
    const src = item.source === "IMERG" ? "卫星" : item.source === "MODEL" ? "模式估算" : "预报";
    return `${s.place} ${number(item.value_mm, 0)} mm（常年 ${number(item.normal_mm, 0)}，${ANOMALY_LABELS[item.category]}，${src}）`;
  });
  return `${base}：${parts.join("；")}`;
}

function mapMarkup(key, bounds, stations, width) {
  const geo = mapGeometry(key, bounds, width);
  const view = MAP_VIEWS[key];
  if (!geo) return `<figure class="map-box map-${key}"><figcaption>${escapeHtml(view.title)}</figcaption><div class="loading-state"><span></span><p>正在读取界线…</p></div></figure>`;
  const { projection } = geo;
  const vb = state.mapViews[key] && state.mapViews[key].baseW === projection.width && state.mapViews[key].baseH === projection.height
    ? state.mapViews[key] : { x: 0, y: 0, w: projection.width, h: projection.height, baseW: projection.width, baseH: projection.height };
  state.mapViews[key] = vb;
  const byId = new Map(stations.map((s) => [s.station_id, s]));
  const layer = state.mapLayer;
  const regions = geo.admin.map((region) => {
    const inside = region.stationIds.map((id) => byId.get(id)).filter(Boolean);
    let cls = "fill-none";
    if (inside.length) {
      cls = layer === "weight" ? weightClass(inside) : `fill-${(regionCategory(inside, layer) || "missing").toLowerCase().replace(/_/g, "-")}`;
    }
    const target = inside.find((s) => s.station_id === state.activeId) || inside[0];
    const active = inside.some((s) => s.station_id === state.activeId) ? " is-active" : "";
    const attrs = target ? ` data-id="${escapeHtml(target.station_id)}" tabindex="0" role="button"` : "";
    const title = regionTitle(region, inside, layer);
    return `<path class="${cls}${active}" d="${region.d}"${attrs} aria-label="${escapeHtml(title)}"><title>${escapeHtml(title)}</title></path>`;
  }).join("");
  const points = stations.map((station) => {
    const [x, y] = projection.point([station.longitude, station.latitude]);
    if (x < 0 || y < 0 || x > projection.width || y > projection.height) return "";
    const weight = productionWeight(station);
    const r = weight ? Math.min(6.5, 2.6 + Math.sqrt(Number(weight.share_of_country_pct || 0)) * 0.9) : 2.6;
    const active = station.station_id === state.activeId ? " active" : "";
    const flags = (station.summary?.weather_states || []).filter((c) => c !== "NORMAL");
    const flagCls = flags.length ? ` flag-${flags[0].toLowerCase().replace("_rain", "")}` : "";
    return `<g class="map-point${active}${flagCls}" data-id="${escapeHtml(station.station_id)}" tabindex="0" role="button" transform="translate(${x.toFixed(1)},${y.toFixed(1)})" aria-label="${escapeHtml(`${station.country} ${station.place}`)}">
      <circle r="${r.toFixed(1)}"><title>${escapeHtml(`${station.place}${flags.length ? `：${flags.map((c) => LABELS[c]).join("、")}` : ""}`)}</title></circle><text x="${(r + 3).toFixed(1)}" y="3.5">${escapeHtml(station.place)}</text></g>`;
  }).join("");
  return `<figure class="map-box map-${key}${vb.w < vb.baseW / 2 ? " zoomed" : ""}">
    <figcaption>${escapeHtml(view.title)}</figcaption>
    <div class="map-controls" role="group" aria-label="地图缩放"><button type="button" data-zoom="in" aria-label="放大">+</button><button type="button" data-zoom="out" aria-label="缩小">−</button><button type="button" data-zoom="reset" aria-label="复位">⟲</button></div>
    <svg data-map="${key}" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}" style="--inv:${(vb.w / vb.baseW).toFixed(3)}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escapeHtml(view.title)}产区地图；滚轮或按钮缩放，拖动平移">
      <rect class="map-sea" width="${projection.width}" height="${projection.height}"></rect>
      <g class="map-land">${geo.land.map((d) => `<path d="${d}"></path>`).join("")}</g>
      <g class="map-regions">${regions}</g>
      <g class="map-points">${points}</g>
    </svg></figure>`;
}

function renderMapLegend() {
  const layer = state.mapLayer;
  const legend = $("#mapLegend");
  if (!legend) return;
  const items = layer === "weight"
    ? [...WEIGHT_STEPS].reverse().map(([, label], i) => `<span><i class="swatch fill-w${i}"></i>${label}</span>`)
    : ANOMALY_ORDER.map((code) => `<span><i class="swatch fill-${code.toLowerCase().replace(/_/g, "-")}"></i>${(layer === "ensemble" ? ENSEMBLE_LABELS : ANOMALY_LABELS)[code]}</span>`);
  items.push('<span><i class="swatch fill-none"></i>无代表点</span>');
  items.push('<span class="legend-points"><i class="pt flag-heavy"></i>强降雨 <i class="pt flag-dry"></i>少雨 <i class="pt flag-heat"></i>高温关注</span>');
  legend.innerHTML = items.join("");
  const def = state.data?.climate_context_definition;
  const note = $("#mapLayerNote");
  if (note) {
    note.textContent = layer === "weight"
      ? "颜色为代表点所在府/省占本国产量的比例：泰国为OAE 2025f生胶片，印尼为BPS 2024干胶，越南为省统计局2024干胶（目前仅平福、多乐两省，西宁、嘉莱待补）；中国、科特迪瓦暂无同口径权重，显示为无权重。"
      : layer === "ensemble"
      ? `${def?.ensemble?.source || "ECMWF集合预报"}：各成员未来7日降雨与校正后的常年分布比较，偏多=高于常年第67百分位、偏少=低于第33百分位；常年水平下两者各约33%。概率越集中，信号越可靠。`
      : `${MAP_LAYERS[layer].hint}；档位按同一网格点历年同期（${def?.baseline ? `ERA5 ${def.baseline.start_year}–${def.baseline.end_year}` : "季节基准未构建"}）百分位划分，已做模式/卫星偏差校正。一区多点时按产量权重取主导档位。`;
  }
  document.querySelectorAll("[data-map-layer]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.mapLayer === layer)));
}

function renderMaps() {
  const country = $("#countryFilter").value;
  const focus = MAP_FOCUS[country];
  const visible = state.filtered;
  const box = $("#maps");
  renderMapLegend();
  let html;
  if (focus) {
    const bounds = focus.bounds || MAP_VIEWS[focus.view].bounds;
    html = mapMarkup(focus.view, bounds, visible, 760);
    box.className = "maps single-map";
  } else {
    html = mapMarkup("mainland", MAP_VIEWS.mainland.bounds, visible, 520)
      + mapMarkup("indonesia", MAP_VIEWS.indonesia.bounds, visible, 520)
      + mapMarkup("africa", MAP_VIEWS.africa.bounds, visible, 300);
    box.className = "maps";
  }
  box.innerHTML = html;
  bindMapInteractions();
}

function bindMapInteractions() {
  document.querySelectorAll(".map-box").forEach((box) => {
    const svg = box.querySelector("svg");
    if (!svg) return;
    const view = state.mapViews[svg.dataset.map];
    const update = () => {
      view.x = Math.max(0, Math.min(view.baseW - view.w, view.x));
      view.y = Math.max(0, Math.min(view.baseH - view.h, view.y));
      svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
      svg.style.setProperty("--inv", (view.w / view.baseW).toFixed(3));
      box.classList.toggle("zoomed", view.w < view.baseW / 2);
    };
    const zoom = (factor, clientX, clientY) => {
      const rect = svg.getBoundingClientRect();
      const fx = (clientX - rect.left) / rect.width;
      const fy = (clientY - rect.top) / rect.height;
      const w = Math.max(view.baseW / 16, Math.min(view.baseW, view.w * factor));
      const h = w * view.baseH / view.baseW;
      view.x += fx * (view.w - w);
      view.y += fy * (view.h - h);
      view.w = w;
      view.h = h;
      update();
    };
    svg.addEventListener("wheel", (event) => {
      event.preventDefault();
      zoom(event.deltaY < 0 ? 0.8 : 1.25, event.clientX, event.clientY);
    }, { passive: false });
    const pointers = new Map();
    let drag = null;
    let pinch = null;
    let moved = false;
    svg.addEventListener("pointerdown", (event) => {
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      moved = false;
      if (pointers.size === 1) drag = { x: event.clientX, y: event.clientY, startX: view.x, startY: view.y };
      if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); drag = null; }
    });
    svg.addEventListener("pointermove", (event) => {
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch) zoom(pinch / distance, (a.x + b.x) / 2, (a.y + b.y) / 2);
        pinch = distance;
        moved = true;
        return;
      }
      if (!drag) return;
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 4 && !moved) {
        moved = true;
        svg.setPointerCapture(event.pointerId);
      }
      if (!moved) return;
      const rect = svg.getBoundingClientRect();
      view.x = drag.startX - (event.clientX - drag.x) * view.w / rect.width;
      view.y = drag.startY - (event.clientY - drag.y) * view.h / rect.height;
      update();
    });
    const end = (event) => {
      pointers.delete(event.pointerId);
      pinch = null;
      const rest = [...pointers.values()][0];
      drag = rest ? { x: rest.x, y: rest.y, startX: view.x, startY: view.y } : null;
    };
    svg.addEventListener("pointerup", end);
    svg.addEventListener("pointercancel", end);
    svg.addEventListener("click", (event) => {
      if (moved) return;
      const target = event.target.closest("[data-id]");
      if (target) selectStation(target.dataset.id);
    });
    svg.addEventListener("keydown", (event) => {
      const target = event.target.closest("[data-id]");
      if (target && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); selectStation(target.dataset.id); }
    });
    box.querySelectorAll("[data-zoom]").forEach((button) => button.addEventListener("click", () => {
      if (button.dataset.zoom === "reset") { Object.assign(view, { x: 0, y: 0, w: view.baseW, h: view.baseH }); update(); return; }
      const rect = svg.getBoundingClientRect();
      zoom(button.dataset.zoom === "in" ? 0.6 : 1 / 0.6, rect.left + rect.width / 2, rect.top + rect.height / 2);
    }));
  });
}

function loadMapLayers() {
  for (const source of ["asia", "africa"]) {
    fetch(`data/maps/${source}.topo.json`, { cache: "force-cache" })
      .then((response) => (response.ok ? response.json() : null))
      .then((topology) => { if (topology) { state.topo[source] = topology; if (state.data) renderMaps(); } })
      .catch((error) => console.warn(`map layer ${source} unavailable`, error));
  }
  document.querySelectorAll("[data-map-layer]").forEach((button) => button.addEventListener("click", () => {
    state.mapLayer = button.dataset.mapLayer;
    renderMaps();
  }));
}

function statusPills(station) {
  return (station.summary?.weather_states || ["NORMAL"]).map((code) => `<span class="pill status-${code.toLowerCase().replace("_rain", "")}">${LABELS[code] || escapeHtml(code)}</span>`).join("");
}

function renderRows() {
  const body = $("#weatherRows");
  $("#weatherTableCaption").textContent = state.filtered.length
    ? `共${state.filtered.length}个匹配地点；点击任意一行查看日度明细`
    : "当前筛选条件下没有匹配地点";
  body.innerHTML = state.filtered.map((station) => {
    const s = station.summary || {};
    const change = rainChange(station);
    const delta = change == null ? "—" : `${change > 0 ? "+" : ""}${number(change)} mm`;
    const observed = station.imerg || {};
    const verification = station.verification || {};
    const weight = productionWeight(station);
    const meta = productionMeta(station);
    return `<tr tabindex="0" data-id="${escapeHtml(station.station_id)}" class="${station.station_id === state.activeId ? "active" : ""}">
      <td><strong>${escapeHtml(station.country)}</strong><br>${escapeHtml(station.region)}</td>
      <td>${escapeHtml(station.place)}</td>
      <td class="production-weight-cell"><strong>${weight ? formatTons(weight.estimated_production_t) : "MISSING"}</strong><small>${weight ? `${meta.reference_year}年 · ${escapeHtml(weight.production_unit || "干胶吨")} · ${station.country} ${number(weight.share_of_country_pct, 2)}%${hasNumber(weight.share_of_world_pct) ? ` · 全球(${meta.global_share_denominator_year}分母) ${number(weight.share_of_world_pct, 2)}%` : " · 全球口径不可比"}` : "统一口径待核验"}</small></td>
      <td><strong>${number(s.precipitation_7d_mm)} mm</strong></td>
      <td>${anomalyBadge(station.climate_context?.forecast_7d)}</td>
      <td><div class="status-stack">${anomalyBadge(station.climate_context?.past_7d)}${anomalyBadge(station.climate_context?.past_30d)}</div></td>
      <td>${number(s.tapping_window_precipitation_7d_mm)} mm / ${s.tapping_window_rain_hours_7d ?? "—"}小时</td>
      <td>${delta}</td>
      <td>${s.rain_days_7d ?? "—"} / 7</td>
      <td>${s.heavy_rain_days_7d ?? "—"} 天</td>
      <td>${number(s.temperature_max_7d_c)} / ${number(s.temperature_min_7d_c)} ℃</td>
      <td>${number(s.soil_moisture_27_81cm_mean_7d, 3)} m³/m³</td>
      <td>${number(observed.precipitation_24h_mm)} / ${number(observed.precipitation_72h_mm)} mm</td>
      <td>${percent(verification["24h"]?.realization_pct)} / ${percent(verification["72h"]?.realization_pct)}</td>
      <td><div class="status-stack">${statusPills(station)}</div></td>
      <td class="quality-cell ${String(station.quality_status).toLowerCase()}">${escapeHtml(station.quality_status)}</td>
    </tr>`;
  }).join("");
  $("#noResults").classList.toggle("hidden", state.filtered.length > 0);
  body.querySelectorAll("tr").forEach((row) => {
    const activate = () => selectStation(row.dataset.id, true);
    row.addEventListener("click", activate);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); }
    });
  });
}

function sixHourRainClass(value) {
  if (!hasNumber(value)) return "rain-6h-missing";
  if (Number(value) >= 30) return "rain-6h-extreme";
  if (Number(value) >= 15) return "rain-6h-heavy";
  if (Number(value) >= 5) return "rain-6h-moderate";
  if (Number(value) >= 0.1) return "rain-6h-trace";
  return "rain-6h-none";
}

function sixHourLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (part) => String(part).padStart(2, "0");
  return `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}时`;
}

function renderSixHourForecast() {
  const periods = (state.data?.stations || []).find((station) => station.forecast_utc_6h?.length)?.forecast_utc_6h || [];
  const available = periods.length > 0 && state.filtered.length > 0;
  $("#sixHourHead").innerHTML = periods.length ? `<tr>
    <th>国家 · 地区</th><th>地点</th>
    ${periods.map((period) => `<th><time datetime="${escapeHtml(period.start_at_utc)}">${sixHourLabel(period.start_at_utc)}</time></th>`).join("")}
  </tr>` : "";
  $("#sixHourRows").innerHTML = available ? state.filtered.map((station) => {
    const values = new Map((station.forecast_utc_6h || []).map((period) => [period.start_at_utc, period]));
    return `<tr tabindex="0" data-id="${escapeHtml(station.station_id)}" class="${station.station_id === state.activeId ? "active" : ""}">
      <td><strong>${escapeHtml(station.country)}</strong><br>${escapeHtml(station.region)}</td>
      <td><strong>${escapeHtml(station.place)}</strong><small>纬度 ${number(station.latitude, 2)}°</small></td>
      ${periods.map((period) => {
        const item = values.get(period.start_at_utc) || {};
        const value = item.precipitation_mm;
        return `<td class="${sixHourRainClass(value)}" title="${escapeHtml(period.start_at_utc)} 至 ${escapeHtml(period.end_at_utc || "—")}">${number(value)}</td>`;
      }).join("")}
    </tr>`;
  }).join("") : "";
  $("#sixHourNoResults").classList.toggle("hidden", available);
  $("#sixHourNoResults").textContent = periods.length
    ? "当前筛选条件下没有可展示的6小时预报。"
    : "当前数据文件尚未包含6小时预报；运行一次天气更新任务后生成。";
  $("#sixHourRows").querySelectorAll("tr").forEach((row) => {
    const activate = () => selectStation(row.dataset.id, true);
    row.addEventListener("click", activate);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); }
    });
  });
}

function rainHistorySegments(byWeek, x, y) {
  const segments = [];
  let current = [];
  for (let week = 1; week <= 53; week += 1) {
    const value = byWeek.get(week);
    if (hasNumber(value)) current.push(`${x(week).toFixed(1)},${y(Number(value)).toFixed(1)}`);
    else if (current.length) { segments.push(current); current = []; }
  }
  if (current.length) segments.push(current);
  return segments;
}

function thailandRainChart(region, index) {
  const valid = (region.weekly || []).filter((item) => hasNumber(item.precipitation_mm));
  if (!valid.length) return `<article class="rain-history-card ${index === 0 ? "featured" : ""}"><h3>${escapeHtml(region.name)}</h3><p class="weekly-summary-note">当前无法确认最新数据。</p></article>`;
  const years = [...new Set(valid.map((item) => Number(item.iso_year)))].sort((a, b) => a - b);
  const latestYear = years.at(-1);
  const previousYears = years.filter((year) => year !== latestYear);
  const yearMaps = new Map(years.map((year) => [year, new Map(valid.filter((item) => Number(item.iso_year) === year).map((item) => [Number(item.iso_week), Number(item.precipitation_mm)]))]));
  const averages = new Map(Array.from({length: 53}, (_, offset) => {
    const week = offset + 1;
    const values = previousYears.map((year) => yearMaps.get(year)?.get(week)).filter(hasNumber).map(Number);
    return [week, values.length ? sum(values) / values.length : null];
  }));
  const maximum = Math.max(0, ...valid.map((item) => Number(item.precipitation_mm)), ...[...averages.values()].filter(hasNumber).map(Number));
  const yMax = Math.max(50, Math.ceil(maximum / 50) * 50);
  const width = index === 0 ? 1120 : 680, height = 250, left = 40, right = 70, top = 16, bottom = 30;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const x = (week) => left + (week - 1) / 52 * plotWidth;
  const y = (value) => top + (yMax - value) / yMax * plotHeight;
  const grid = [0, yMax / 2, yMax].map((value) => `<line x1="${left}" y1="${y(value)}" x2="${width - right}" y2="${y(value)}"/><text x="${left - 7}" y="${y(value) + 4}" text-anchor="end">${number(value, 0)}</text>`).join("");
  // 周序换成月份刻度（ISO周近似：第1、14、27、40周≈1、4、7、10月初）
  const ticks = [[1, "1月"], [14, "4月"], [27, "7月"], [40, "10月"], [53, ""]].map(([week, label]) => `<text x="${x(week)}" y="${height - 10}" text-anchor="${week === 1 ? "start" : "middle"}">${label}</text>`).join("");
  const meanPoints = [...averages].filter(([, value]) => hasNumber(value)).map(([week, value]) => `${x(week).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
  const history = previousYears.map((year) => rainHistorySegments(yearMaps.get(year), x, y).map((segment) => `<polyline class="rh-past" points="${segment.join(" ")}"><title>${year}</title></polyline>`).join("")).join("");
  const current = rainHistorySegments(yearMaps.get(latestYear), x, y).map((segment) => `<polyline class="rh-current" points="${segment.join(" ")}"/>`).join("");
  const latestPoints = [...yearMaps.get(latestYear)].map(([week, value]) => `<circle cx="${x(week)}" cy="${y(value)}" r="5" class="rh-hit"><title>${latestYear}年第${week}周：${number(value)} mm；${previousYears.length ? `往年均值 ${number(averages.get(week))} mm` : ""}</title></circle>`).join("");
  const lastEntry = [...yearMaps.get(latestYear)].at(-1);
  const lastLabel = lastEntry ? `<circle class="rh-last" cx="${x(lastEntry[0])}" cy="${y(lastEntry[1])}" r="3.2"/><text class="rh-label" x="${x(lastEntry[0]) + 6}" y="${y(lastEntry[1]) - 6}">${latestYear}：${number(lastEntry[1], 0)} mm</text>` : "";
  const bars = "";
  const lines = `${history}${meanPoints ? `<polyline class="rh-mean" points="${meanPoints}"/>` : ""}${current}`;
  const previousLabel = previousYears.length ? `${previousYears[0]}–${previousYears.at(-1)}均值` : "历史均值";
  const legend = [`<span><i class="rh-key-current"></i>${latestYear}</span>`, `<span><i class="rh-key-mean"></i>${previousLabel}</span>`, `<span><i class="rh-key-past"></i>往年各年</span>`].join("");
  return `<article class="rain-history-card ${index === 0 ? "featured" : ""}">
    <div class="rain-history-head"><h3>${escapeHtml(region.name)}</h3><span>周降雨 mm，${region.point_count}个网格点等权</span></div>
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(region.name)}2022年至今周度降雨对比图">
      <g class="rain-history-grid">${grid}${ticks}</g>
      <g class="rain-history-lines">${lines}</g><g class="rain-history-current">${lastLabel}${latestPoints}</g>
    </svg>
    <div class="rain-history-legend">${legend}</div>
  </article>`;
}

function renderThailandWeeklyRain() {
  const data = state.thailandRain;
  if (!data?.regions?.length) {
    $("#thailandRainCharts").innerHTML = '<div class="empty-state"><strong>泰国周度降雨数据尚未生成</strong><span>运行一次天气更新任务后生成。</span></div>';
    $("#thailandRainMeta").textContent = "当前无法确认最新数据。";
    return;
  }
  $("#thailandRainPeriod").textContent = `${data.period.start_date} — ${data.period.end_date} · ${data.overall_quality_status}`;
  $("#thailandRainCharts").innerHTML = data.regions.map(thailandRainChart).join("");
  $("#thailandRainMeta").innerHTML = `来源：<a href="${escapeHtml(data.source.documentation)}" target="_blank" rel="noreferrer">${escapeHtml(data.source.source_name)}</a>（${escapeHtml(data.source.upstream_model)}，0.25°再分析）。当地时间周一至周日累计，仅显示完整周；${escapeHtml(data.aggregation)}最新完整周截至 ${escapeHtml(data.period.end_date)}。`;
}

function renderDetail() {
  const station = state.filtered.find((item) => item.station_id === state.activeId);
  if (!station) {
    $("#stationDetail").innerHTML = '<div class="empty-state"><strong>没有可展示的地点</strong><span>请调整筛选条件。</span></div>';
    return;
  }
  const s = station.summary || {};
  const maxRain = Math.max(1, ...(station.daily || []).map((day) => Number(day.precipitation_sum || 0)));
  const days = (station.daily || []).map((day) => {
    const barHeight = Math.max(2, Number(day.precipitation_sum || 0) / maxRain * 70);
    const date = new Date(`${day.date}T00:00:00`);
    const label = new Intl.DateTimeFormat("zh-CN", {month:"numeric", day:"numeric", weekday:"short"}).format(date);
    return `<div class="forecast-day">
      <time datetime="${escapeHtml(day.date)}">${escapeHtml(label)}</time>
      <div class="rain-track"><span class="rain-bar" style="height:${barHeight.toFixed(1)}px"></span></div>
      <strong>${number(day.precipitation_sum)} mm</strong>
      <small>${number(day.temperature_2m_max, 0)}° / ${number(day.temperature_2m_min, 0)}°</small>
      <small>晨间割胶作业窗 ${number(day.tapping_window_precipitation_mm)} mm</small>
    </div>`;
  }).join("");
  const change = rainChange(station);
  const observed = station.imerg || {};
  const verification = station.verification || {};
  const v24 = verification["24h"] || {};
  const v72 = verification["72h"] || {};
  const weight = productionWeight(station);
  const meta = productionMeta(station);
  $("#stationDetail").className = "station-detail";
  $("#stationDetail").innerHTML = `<div class="detail-head">
      <div><p>${escapeHtml(station.country)} · ${escapeHtml(station.region)}</p><h2>${escapeHtml(station.place)}</h2><p>${number(station.latitude, 2)}°, ${number(station.longitude, 2)}° · ${escapeHtml(station.timezone || "时区待确认")}</p></div>
      <div class="status-stack">${statusPills(station)}</div>
    </div>
    <div class="detail-metrics">
      <div class="production-metric"><span>${weight ? `${meta.reference_year}年产量权重` : "产量权重"}</span><strong>${weight ? formatTons(weight.estimated_production_t) : "MISSING"}</strong><small>${weight ? `${meta.data_type} / ${weight.quality_status}` : "统一口径待核验"}</small></div>
      <div class="production-metric"><span>占${escapeHtml(station.country)}产量</span><strong>${weight ? percent(weight.share_of_country_pct) : "MISSING"}</strong></div>
      <div class="production-metric"><span>${hasNumber(weight?.share_of_world_pct) ? `占全球产量（${meta.global_share_denominator_year}分母）` : "全球占比"}</span><strong>${hasNumber(weight?.share_of_world_pct) ? percent(weight.share_of_world_pct) : "口径不可比"}</strong></div>
      <div><span>7日降雨</span><strong>${number(s.precipitation_7d_mm)} mm</strong></div>
      <div><span>晨间割胶作业窗7日降雨</span><strong>${number(s.tapping_window_precipitation_7d_mm)} mm</strong></div>
      <div><span title="雨日：当日窗口累计≥1 mm；雨小时：该小时≥0.1 mm">晨间割胶作业窗雨日 / 雨小时</span><strong>${s.tapping_window_rain_days_7d ?? "—"} 天 / ${s.tapping_window_rain_hours_7d ?? "—"} 小时</strong></div>
      <div><span>较上次更新</span><strong>${change == null ? "—" : `${change > 0 ? "+" : ""}${number(change)} mm`}</strong></div>
      <div><span>雨日 / 强降雨日</span><strong>${s.rain_days_7d ?? "—"} / ${s.heavy_rain_days_7d ?? "—"} 天</strong></div>
      <div><span>7日最高 / 最低温</span><strong>${number(s.temperature_max_7d_c)} / ${number(s.temperature_min_7d_c)} ℃</strong></div>
      <div><span>9–27cm土壤水分</span><strong>${number(s.soil_moisture_9_27cm_mean_7d, 3)}</strong></div>
      <div><span>27–81cm土壤水分</span><strong>${number(s.soil_moisture_27_81cm_mean_7d, 3)}</strong></div>
      <div><span>IMERG 过去24h</span><strong>${number(observed.precipitation_24h_mm)} mm</strong></div>
      <div><span>IMERG 过去72h</span><strong>${number(observed.precipitation_72h_mm)} mm</strong></div>
      <div><span>24h预报兑现率</span><strong>${percent(v24.realization_pct)}</strong><small>${escapeHtml(v24.status || "样本尚未形成")}</small></div>
      <div><span>72h预报兑现率</span><strong>${percent(v72.realization_pct)}</strong><small>${escapeHtml(v72.status || "样本尚未形成")}</small></div>
    </div>
    <div class="climate-context">
      <h3>与常年同期比（季节基准 ${escapeHtml(baselineLabel())}）</h3>
      <div class="detail-metrics">${[["forecast_7d", "未来7日"], ["past_7d", "过去7日"], ["past_14d", "过去14日"], ["past_30d", "过去30日"]].map(([key, label]) => {
        const item = station.climate_context?.[key];
        const src = { IMERG: "（卫星）", MODEL: "（模式估算）", FORECAST: "（预报）" }[item?.source] || "";
        return `<div><span>${label}${src}</span><strong>${number(item?.value_mm)} mm</strong><small>常年 ${number(item?.normal_mm)} mm</small><div class="anom-row">${anomalyBadge(item)}</div></div>`;
      }).join("")}</div>
    </div>
    <p class="ensemble-line"><strong>集合预报（ECMWF 51成员）</strong>${escapeHtml(ensembleText(station.climate_context?.forecast_7d_ensemble))}</p>
    <div class="forecast-strip" aria-label="${escapeHtml(station.place)}未来七天逐日预报">${days}</div>
    <p class="detail-source">预报：${escapeHtml(state.data.source?.source_name)}；实况估算：${escapeHtml(state.data.observation_source?.source_name || "当前无法确认最新数据")}。兑现率=实况/验证期前预报，不是准确率。</p>
    <p class="detail-source">距平：${escapeHtml(state.data.climate_context_definition?.caveat || "季节基准尚未构建，保持MISSING。")}</p>
    <p class="detail-source">产量权重：${weight ? escapeHtml(meta.methodology || state.productionWeights?.methodology || "当前无法确认最新数据") : "当前地点尚无同口径产量权重，保持MISSING。"}</p>`;
}

function baselineLabel() {
  const def = state.data?.climate_context_definition;
  const b = def?.baseline;
  if (!b) return "未构建";
  const o = def?.bias_correction?.status === "PASS" ? def.bias_correction.overlap : null;
  return `ERA5 ${b.start_year}–${b.end_year}${o ? `，已按${o.start_year}–${o.end_year}模式偏差校正` : "，未做模式偏差校正"}`;
}

function selectStation(id, reveal = false) {
  state.activeId = id;
  renderMaps();
  renderRows();
  renderSixHourForecast();
  renderDetail();
  if (reveal || matchMedia("(max-width: 760px)").matches) $("#detailPanel").scrollIntoView({behavior:"smooth", block:"start"});
}

function render() {
  renderMetrics();
  renderMaps();
  renderRows();
  renderSixHourForecast();
  renderDetail();
}

async function loadData() {
  $("#maps").innerHTML = $("#loadingTemplate").innerHTML;
  try {
    const [weatherResponse, historyResponse, thailandRainResponse, productionWeightsResponse] = await Promise.all([
      fetch(`data/weather.json?v=${Date.now()}`, {cache:"no-store"}),
      fetch(`data/history.json?v=${Date.now()}`, {cache:"no-store"}),
      fetch(`data/thailand-weekly-rain.json?v=${Date.now()}`, {cache:"no-store"}),
      fetch(`data/production-weights.json?v=${Date.now()}`, {cache:"no-store"}),
    ]);
    if (!weatherResponse.ok) throw new Error(`weather.json ${weatherResponse.status}`);
    state.data = await weatherResponse.json();
    state.history = historyResponse.ok ? (await historyResponse.json()).snapshots || [] : [];
    state.thailandRain = thailandRainResponse.ok ? await thailandRainResponse.json().catch(() => null) : null;
    state.productionWeights = productionWeightsResponse.ok ? await productionWeightsResponse.json().catch(() => null) : null;
    renderFreshness();
    populateProductionWeightMethod();
    $("#updatedAt").textContent = formatUpdate(state.data.generated_at_utc);
    const quality = state.data.overall_quality_status || "MISSING";
    $("#qualityBadge").textContent = quality;
    $("#qualityBadge").className = `quality ${quality.toLowerCase()}`;
    populateSources(state.data);
    renderWeeklySummary();
    renderThailandWeeklyRain();
    populateCountries(state.data.stations || []);
    state.activeId = state.activeId || state.data.stations?.[0]?.station_id || null;
    filterStations();
  } catch (error) {
    console.error(error);
    $("#updatedAt").textContent = "当前无法确认最新数据";
    $("#qualityBadge").textContent = "FAIL";
    $("#qualityBadge").className = "quality warning";
    renderFreshness();
    $("#maps").innerHTML = '<div class="empty-state"><strong>天气数据读取失败</strong><span>已保留缺失状态，请由维护者检查最近一次更新任务。</span></div>';
    $("#weatherRows").innerHTML = "";
  }
}

$("#countryFilter").addEventListener("change", filterStations);
$("#stateFilter").addEventListener("change", filterStations);
$("#searchInput").addEventListener("input", filterStations);
document.querySelectorAll("[data-weather-filter]").forEach((card) => {
  card.addEventListener("click", () => activateMetricFilter(card.dataset.weatherFilter));
});
loadMapLayers();
loadData();
loadTemperatureHistory();
setupOutlookTabs();
loadExtendedOutlooks();
