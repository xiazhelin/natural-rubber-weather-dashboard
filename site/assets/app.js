"use strict";

const state = { data: null, history: [], thailandRain: null, productionWeights: null, climateOutlooks: null, mapData: null, filtered: [], activeId: null };
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[char]);
const hasNumber = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
const number = (value, digits = 1) => hasNumber(value) ? Number(value).toFixed(digits) : "—";
const percent = (value) => hasNumber(value) ? `${number(value)}%` : "—";
const sum = (values) => values.reduce((total, value) => total + Number(value || 0), 0);
const formatTons = (value) => hasNumber(value) ? `${new Intl.NumberFormat("zh-CN").format(Math.round(Number(value)))} 吨` : "MISSING";
const MAP_DATA_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/9380cca83db5f9aef52d5e762765100745f84b27/geojson/ne_110m_admin_0_countries.geojson";

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

function productionContext(stations, country = $("#countryFilter")?.value || "all") {
  const shareKey = country === "all" ? "share_of_world_pct" : "share_of_country_pct";
  const denominator = country === "all" ? "全球产量" : `${country}产量`;
  const entries = stations.map((station) => ({station, weight: productionWeight(station)}))
    .filter((item) => hasNumber(item.weight?.[shareKey]) && hasNumber(item.weight?.estimated_production_t));
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
      date: weights.reference_year ? `基准 ${weights.reference_year}年` : "年份待确认",
      note: `${weightCount}/${weather.stations?.length ?? 0}个地点已接入；${weights.data_type || "MISSING"}，省级正式值待替换`,
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
  $("#weightWorldTotal").textContent = formatTons(d.world_2025_production_t);
  $("#weightCoverage").textContent = hasNumber(d.tracked_share_of_thailand_pct)
    ? `泰国 ${number(d.tracked_share_of_thailand_pct, 2)}% / 全球 ${number(d.tracked_share_of_world_pct, 2)}%`
    : "当前无法确认最新数据";
  $("#weightMethod").textContent = weights.methodology || "2025年统一省级正式值尚未接入，缺失时不以代表点数量替代。";
  if (weights.sources?.[0]?.url) $("#weightDocs").href = weights.sources[0].url;
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
    ? "产量权重 MISSING；上方为地点等权"
    : `产量加权 ${number(weightedRain)} mm；覆盖${number(context.coveragePct, 2)}%${context.denominator}`;
  for (const code of ["HEAVY_RAIN", "DRY", "HEAT"]) {
    const count = stations.filter((item) => item.summary?.weather_states?.includes(code)).length;
    $(`#${code === "HEAVY_RAIN" ? "heavy" : code.toLowerCase()}Count`).textContent = `${count} 个`;
    const exposure = productionExposure(stations, code);
    const exposureId = code === "HEAVY_RAIN" ? "heavyExposure" : `${code.toLowerCase()}Exposure`;
    $(`#${exposureId}`).textContent = context.entries.length
      ? `已纳入权重产量暴露 ${number(exposure.coveragePct, 2)}%${context.denominator}（${exposure.entries.length}/${count}点）`
      : "产量权重 MISSING";
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
  const weightContext = productionContext(stations, "all");
  const heavyExposure = productionExposure(stations, "HEAVY_RAIN", "all");
  const dryExposure = productionExposure(stations, "DRY", "all");
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
      <h3>【事实】0–7天 · 作业扰动</h3>
      <p>${tappingRain.length}/${stations.length}个代表点的晨间割胶作业窗至少1天有雨；强降雨关注${heavy.length}个、少雨关注${dry.length}个、高温关注${heat.length}个。</p>
      <p>已纳入权重的强降雨暴露${number(heavyExposure.coveragePct, 2)}%全球产量，少雨暴露${number(dryExposure.coveragePct, 2)}%全球产量。</p>
      <small>阈值：7日降雨 ≥ ${thresholds.heavy_rain_total_7d_mm ?? "—"} mm / &lt; ${thresholds.dry_total_7d_mm ?? "—"} mm，日最高温 ≥ ${thresholds.hot_day_max_c ?? "—"}℃。产量权重覆盖${number(weightContext.coveragePct, 2)}%全球产量。</small>
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

function projectCoordinate(coordinate, bounds, width, height) {
  const paddingX = 28;
  const paddingY = 32;
  const x = paddingX + (coordinate[0] - bounds.west) / (bounds.east - bounds.west) * (width - paddingX * 2);
  const y = paddingY + (bounds.north - coordinate[1]) / (bounds.north - bounds.south) * (height - paddingY * 2);
  return { x, y };
}

function projectPoint(station, bounds, width, height) {
  return projectCoordinate([station.longitude, station.latitude], bounds, width, height);
}

function geometryCoordinates(value, output = []) {
  if (typeof value?.[0] === "number") output.push(value);
  else value?.forEach((item) => geometryCoordinates(item, output));
  return output;
}

function intersectsMap(geometry, bounds) {
  const coordinates = geometryCoordinates(geometry?.coordinates);
  if (!coordinates.length) return false;
  const longitudes = coordinates.map((coordinate) => coordinate[0]);
  const latitudes = coordinates.map((coordinate) => coordinate[1]);
  return Math.max(...longitudes) >= bounds.west && Math.min(...longitudes) <= bounds.east
    && Math.max(...latitudes) >= bounds.south && Math.min(...latitudes) <= bounds.north;
}

function geometryPath(geometry, bounds, width, height) {
  const polygons = geometry?.type === "Polygon" ? [geometry.coordinates]
    : geometry?.type === "MultiPolygon" ? geometry.coordinates : [];
  return polygons.flatMap((polygon) => polygon.map((ring) => ring.map((coordinate, index) => {
    const point = projectCoordinate(coordinate, bounds, width, height);
    return `${index ? "L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`;
  }).join("") + "Z")).join("");
}

function landMarkup(bounds, width, height) {
  const paths = (state.mapData?.features || [])
    .filter((feature) => intersectsMap(feature.geometry, bounds))
    .map((feature) => `<path d="${geometryPath(feature.geometry, bounds, width, height)}"></path>`)
    .join("");
  return paths ? `<g class="map-land" aria-hidden="true">${paths}</g>` : "";
}

function mapMarkup(title, stations, bounds, width = 680, height = 340) {
  const verticals = [0.25, 0.5, 0.75].map((part) => `<line class="grid-line" x1="${width * part}" y1="28" x2="${width * part}" y2="${height - 20}"/>`).join("");
  const horizontals = [0.25, 0.5, 0.75].map((part) => `<line class="grid-line" x1="22" y1="${height * part}" x2="${width - 20}" y2="${height * part}"/>`).join("");
  const points = stations.map((station) => {
    const point = projectPoint(station, bounds, width, height);
    const code = primaryState(station);
    const active = station.station_id === state.activeId ? " active" : "";
    const weight = productionWeight(station);
    const radius = weight ? Math.min(10, 5 + Math.sqrt(Number(weight.share_of_country_pct || 0))) : 5;
    const weightLabel = weight ? `，2025估算产量${formatTons(weight.estimated_production_t)}，占${station.country}${number(weight.share_of_country_pct, 2)}%` : "，产量权重缺失";
    return `<g class="map-point${active}" tabindex="0" role="button" aria-label="${escapeHtml(station.country)} ${escapeHtml(station.region)} ${escapeHtml(station.place)}${escapeHtml(weightLabel)}" data-id="${escapeHtml(station.station_id)}" transform="translate(${point.x.toFixed(1)},${point.y.toFixed(1)})">
      <circle r="${radius.toFixed(1)}" fill="${COLORS[code] || COLORS.NORMAL}"><title>${escapeHtml(weightLabel.slice(1))}</title></circle>
      <text x="10" y="4">${escapeHtml(station.place)}</text>
    </g>`;
  }).join("");
  return `<div class="map-box"><h3>${escapeHtml(title)}</h3><svg viewBox="0 0 ${width} ${height}" aria-label="${escapeHtml(title)}产区地图">${landMarkup(bounds, width, height)}${verticals}${horizontals}${points}</svg></div>`;
}

function renderMaps() {
  const asia = state.filtered.filter((item) => item.longitude > 50);
  const africa = state.filtered.filter((item) => item.longitude <= 50);
  $("#maps").innerHTML = mapMarkup("亚洲产区", asia, {west: 96, east: 113, south: -7, north: 24})
    + mapMarkup("西非产区", africa, {west: -8, east: -1, south: 4, north: 8}, 300, 340);
  document.querySelectorAll(".map-point").forEach((point) => {
    const activate = () => selectStation(point.dataset.id);
    point.addEventListener("click", activate);
    point.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); }
    });
  });
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
    return `<tr tabindex="0" data-id="${escapeHtml(station.station_id)}" class="${station.station_id === state.activeId ? "active" : ""}">
      <td><strong>${escapeHtml(station.country)}</strong><br>${escapeHtml(station.region)}</td>
      <td>${escapeHtml(station.place)}</td>
      <td class="production-weight-cell"><strong>${weight ? formatTons(weight.estimated_production_t) : "MISSING"}</strong><small>${weight ? `${station.country} ${number(weight.share_of_country_pct, 2)}% · 全球 ${number(weight.share_of_world_pct, 2)}%` : "统一口径待核验"}</small></td>
      <td><strong>${number(s.precipitation_7d_mm)} mm</strong></td>
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
  const width = 680, height = 285, left = 45, right = 12, top = 14, bottom = 48;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const x = (week) => left + (week - 1) / 52 * plotWidth;
  const y = (value) => top + (yMax - value) / yMax * plotHeight;
  const colors = ["#3378ba", "#d85d55", "#69a64d", "#7665ae", "#2a9d8f"];
  const colorFor = (year) => year === latestYear ? "#f28a22" : colors[years.indexOf(year) % colors.length];
  const grid = [0, yMax / 2, yMax].map((value) => `<line x1="${left}" y1="${y(value)}" x2="${width - right}" y2="${y(value)}"/><text x="${left - 7}" y="${y(value) + 4}" text-anchor="end">${number(value, 0)}</text>`).join("");
  const ticks = [1, 9, 17, 25, 33, 41, 49, 53].map((week) => `<text x="${x(week)}" y="${height - 19}" text-anchor="middle">${week}</text>`).join("");
  const bars = [...averages].filter(([, value]) => hasNumber(value)).map(([week, value]) => `<rect x="${x(week) - 4}" y="${y(value)}" width="8" height="${y(0) - y(value)}"/>`).join("");
  const lines = years.map((year) => rainHistorySegments(yearMaps.get(year), x, y).map((segment) => `<polyline points="${segment.join(" ")}" style="stroke:${colorFor(year)};stroke-width:${year === latestYear ? 2.8 : 1.4}"/>`).join("")).join("");
  const latestPoints = [...yearMaps.get(latestYear)].map(([week, value]) => `<circle cx="${x(week)}" cy="${y(value)}" r="2.4"><title>${latestYear}年第${week}周：${number(value)} mm</title></circle>`).join("");
  const previousLabel = previousYears.length ? `${previousYears[0]}–${previousYears.at(-1)}均值` : "历史均值";
  const legend = [`<span><i class="rain-history-average"></i>${previousLabel}</span>`, ...years.map((year) => `<span><i style="background:${colorFor(year)}"></i>${year}</span>`)].join("");
  return `<article class="rain-history-card ${index === 0 ? "featured" : ""}">
    <div class="rain-history-head"><h3>${escapeHtml(region.name)}</h3><span>${region.point_count}个网格点等权 · mm</span></div>
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(region.name)}2022年至今周度降雨对比图">
      <g class="rain-history-grid">${grid}${ticks}<text x="${width / 2}" y="${height - 2}" text-anchor="middle">周序</text></g>
      <g class="rain-history-bars">${bars}</g><g class="rain-history-lines">${lines}</g><g class="rain-history-current">${latestPoints}</g>
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
  $("#stationDetail").innerHTML = `<div class="detail-head">
      <div><p>${escapeHtml(station.country)} · ${escapeHtml(station.region)}</p><h2>${escapeHtml(station.place)}</h2><p>${number(station.latitude, 2)}°, ${number(station.longitude, 2)}° · ${escapeHtml(station.timezone || "时区待确认")}</p></div>
      <div class="status-stack">${statusPills(station)}</div>
    </div>
    <div class="detail-metrics">
      <div class="production-metric"><span>2025产量权重</span><strong>${weight ? formatTons(weight.estimated_production_t) : "MISSING"}</strong><small>${weight ? `${state.productionWeights?.data_type} / ${weight.quality_status}` : "统一口径待核验"}</small></div>
      <div class="production-metric"><span>占${escapeHtml(station.country)}产量</span><strong>${weight ? percent(weight.share_of_country_pct) : "MISSING"}</strong></div>
      <div class="production-metric"><span>占全球产量</span><strong>${weight ? percent(weight.share_of_world_pct) : "MISSING"}</strong></div>
      <div><span>7日降雨</span><strong>${number(s.precipitation_7d_mm)} mm</strong></div>
      <div><span>晨间割胶作业窗7日降雨</span><strong>${number(s.tapping_window_precipitation_7d_mm)} mm</strong></div>
      <div><span>晨间割胶作业窗雨日 / 雨小时</span><strong>${s.tapping_window_rain_days_7d ?? "—"} 天 / ${s.tapping_window_rain_hours_7d ?? "—"} 小时</strong></div>
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
    <div class="forecast-strip" aria-label="${escapeHtml(station.place)}未来七天逐日预报">${days}</div>
    <p class="detail-source">预报：${escapeHtml(state.data.source?.source_name)}；实况估算：${escapeHtml(state.data.observation_source?.source_name || "当前无法确认最新数据")}。兑现率=实况/验证期前预报，不是准确率。</p>
    <p class="detail-source">产量权重：${weight ? escapeHtml(state.productionWeights?.methodology || "当前无法确认最新数据") : "当前地点尚无同口径2025产量权重，保持MISSING。"}</p>`;
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
    fetch(MAP_DATA_URL, {cache:"force-cache"})
      .then((response) => response.ok ? response.json() : null)
      .then((mapData) => { state.mapData = mapData; if (state.data) renderMaps(); })
      .catch((error) => console.warn("Natural Earth map unavailable", error));
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
loadData();
loadTemperatureHistory();
setupOutlookTabs();
loadExtendedOutlooks();
