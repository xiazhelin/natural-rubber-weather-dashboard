"use strict";

const state = { data: null, history: [], mapData: null, filtered: [], activeId: null };
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[char]);
const hasNumber = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
const number = (value, digits = 1) => hasNumber(value) ? Number(value).toFixed(digits) : "—";
const percent = (value) => hasNumber(value) ? `${number(value)}%` : "—";
const sum = (values) => values.reduce((total, value) => total + Number(value || 0), 0);
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

function populateCountries(stations) {
  const select = $("#countryFilter");
  const current = select.value;
  const countries = [...new Set(stations.map((item) => item.country))];
  select.innerHTML = '<option value="all">全部国家</option>' + countries.map((country) => `<option value="${escapeHtml(country)}">${escapeHtml(country)}</option>`).join("");
  select.value = countries.includes(current) ? current : "all";
}

function filterStations() {
  const country = $("#countryFilter").value;
  const status = $("#stateFilter").value;
  const query = $("#searchInput").value.trim().toLowerCase();
  state.filtered = (state.data?.stations || []).filter((station) => {
    const states = station.summary?.weather_states || [];
    const haystack = `${station.country} ${station.region} ${station.place}`.toLowerCase();
    return (country === "all" || station.country === country)
      && (status === "all" || states.includes(status))
      && (!query || haystack.includes(query));
  });
  if (!state.filtered.some((item) => item.station_id === state.activeId)) {
    state.activeId = state.filtered[0]?.station_id || null;
  }
  render();
}

function renderMetrics() {
  const stations = state.filtered;
  const rain = stations.map((item) => item.summary?.precipitation_7d_mm).filter((value) => value != null);
  $("#avgRain").textContent = rain.length ? `${number(sum(rain) / rain.length)} mm` : "—";
  for (const code of ["HEAVY_RAIN", "DRY", "HEAT"]) {
    const count = stations.filter((item) => item.summary?.weather_states?.includes(code)).length;
    $(`#${code === "HEAVY_RAIN" ? "heavy" : code.toLowerCase()}Count`).textContent = `${count} 个`;
  }
  $("#resultCount").textContent = `${stations.length}个地点`;
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
    return `<g class="map-point${active}" tabindex="0" role="button" aria-label="${escapeHtml(station.country)} ${escapeHtml(station.region)} ${escapeHtml(station.place)}" data-id="${escapeHtml(station.station_id)}" transform="translate(${point.x.toFixed(1)},${point.y.toFixed(1)})">
      <circle r="7" fill="${COLORS[code] || COLORS.NORMAL}"></circle>
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
  body.innerHTML = state.filtered.map((station) => {
    const s = station.summary || {};
    const change = rainChange(station);
    const delta = change == null ? "—" : `${change > 0 ? "+" : ""}${number(change)} mm`;
    const observed = station.imerg || {};
    const verification = station.verification || {};
    return `<tr tabindex="0" data-id="${escapeHtml(station.station_id)}" class="${station.station_id === state.activeId ? "active" : ""}">
      <td><strong>${escapeHtml(station.country)}</strong><br>${escapeHtml(station.region)}</td>
      <td>${escapeHtml(station.place)}</td>
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
    const activate = () => selectStation(row.dataset.id);
    row.addEventListener("click", activate);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); }
    });
  });
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
      <small>割胶窗 ${number(day.tapping_window_precipitation_mm)} mm</small>
    </div>`;
  }).join("");
  const change = rainChange(station);
  const observed = station.imerg || {};
  const verification = station.verification || {};
  const v24 = verification["24h"] || {};
  const v72 = verification["72h"] || {};
  $("#stationDetail").innerHTML = `<div class="detail-head">
      <div><p>${escapeHtml(station.country)} · ${escapeHtml(station.region)}</p><h2>${escapeHtml(station.place)}</h2><p>${number(station.latitude, 2)}°, ${number(station.longitude, 2)}° · ${escapeHtml(station.timezone || "时区待确认")}</p></div>
      <div class="status-stack">${statusPills(station)}</div>
    </div>
    <div class="detail-metrics">
      <div><span>7日降雨</span><strong>${number(s.precipitation_7d_mm)} mm</strong></div>
      <div><span>割胶窗7日降雨</span><strong>${number(s.tapping_window_precipitation_7d_mm)} mm</strong></div>
      <div><span>割胶窗雨日 / 雨小时</span><strong>${s.tapping_window_rain_days_7d ?? "—"} 天 / ${s.tapping_window_rain_hours_7d ?? "—"} 小时</strong></div>
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
    <p class="detail-source">预报：${escapeHtml(state.data.source?.source_name)}；实况估算：${escapeHtml(state.data.observation_source?.source_name || "当前无法确认最新数据")}。兑现率=实况/验证期前预报，不是准确率。</p>`;
}

function selectStation(id) {
  state.activeId = id;
  renderMaps();
  renderRows();
  renderDetail();
  if (matchMedia("(max-width: 760px)").matches) $("#detailPanel").scrollIntoView({behavior:"smooth", block:"start"});
}

function render() {
  renderMetrics();
  renderMaps();
  renderRows();
  renderDetail();
}

async function loadData() {
  $("#maps").innerHTML = $("#loadingTemplate").innerHTML;
  try {
    fetch(MAP_DATA_URL, {cache:"force-cache"})
      .then((response) => response.ok ? response.json() : null)
      .then((mapData) => { state.mapData = mapData; if (state.data) renderMaps(); })
      .catch((error) => console.warn("Natural Earth map unavailable", error));
    const [weatherResponse, historyResponse] = await Promise.all([
      fetch(`data/weather.json?v=${Date.now()}`, {cache:"no-store"}),
      fetch(`data/history.json?v=${Date.now()}`, {cache:"no-store"}),
    ]);
    if (!weatherResponse.ok) throw new Error(`weather.json ${weatherResponse.status}`);
    state.data = await weatherResponse.json();
    state.history = historyResponse.ok ? (await historyResponse.json()).snapshots || [] : [];
    $("#updatedAt").textContent = formatUpdate(state.data.generated_at_utc);
    const quality = state.data.overall_quality_status || "MISSING";
    $("#qualityBadge").textContent = quality;
    $("#qualityBadge").className = `quality ${quality.toLowerCase()}`;
    populateSources(state.data);
    populateCountries(state.data.stations || []);
    state.activeId = state.activeId || state.data.stations?.[0]?.station_id || null;
    filterStations();
  } catch (error) {
    console.error(error);
    $("#updatedAt").textContent = "当前无法确认最新数据";
    $("#qualityBadge").textContent = "FAIL";
    $("#qualityBadge").className = "quality warning";
    $("#maps").innerHTML = '<div class="empty-state"><strong>天气数据读取失败</strong><span>已保留缺失状态，请由维护者检查最近一次更新任务。</span></div>';
    $("#weatherRows").innerHTML = "";
  }
}

$("#countryFilter").addEventListener("change", filterStations);
$("#stateFilter").addEventListener("change", filterStations);
$("#searchInput").addEventListener("input", filterStations);
loadData();
