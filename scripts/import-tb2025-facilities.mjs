// Import the user-supplied Tire Business OCR as a dated survey, never as current formed capacity.
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {basename, resolve} from 'node:path';

const sourceDir = process.env.TB2025_SOURCE_DIR || '/Users/xzl/Downloads/闲杂/轮胎天胶测算';
const original = resolve(sourceDir, 'TireBusiness-2025全球轮胎生产设施清单.md');
const extracted = resolve(sourceDir, 'TB2025工厂清单-全文提取.txt');
const comparison = resolve(sourceDir, '全球轮胎75强产能与厂区分布全览.md');
const output = resolve('site/data/capacity/tb2025-facilities.json');
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const names = {
  CANADA: '加拿大', MEXICO: '墨西哥', 'UNITED STATES': '美国', ARGENTINA: '阿根廷', BRAZIL: '巴西', CHILE: '智利', COLOMBIA: '哥伦比亚', 'COSTA RICA': '哥斯达黎加', ECUADOR: '厄瓜多尔', PERU: '秘鲁', VENEZUELA: '委内瑞拉', BELARUS: '白俄罗斯', 'CZECH REPUBLIC': '捷克', FINLAND: '芬兰', FRANCE: '法国', GERMANY: '德国', HUNGARY: '匈牙利', ITALY: '意大利', LUXEMBOURG: '卢森堡', NETHERLANDS: '荷兰', POLAND: '波兰', PORTUGAL: '葡萄牙', ROMANIA: '罗马尼亚', RUSSIA: '俄罗斯', SERBIA: '塞尔维亚', 'SLOVAK REPUBLIC': '斯洛伐克', SLOVENIA: '斯洛文尼亚', SPAIN: '西班牙', UKRAINE: '乌克兰', 'UNITED KINGDOM': '英国', AZERBAIJAN: '阿塞拜疆', BANGLADESH: '孟加拉国', CAMBODIA: '柬埔寨', CHINA: '中国', INDIA: '印度', INDONESIA: '印度尼西亚', JAPAN: '日本', KAZAKHSTAN: '哈萨克斯坦', MALAYSIA: '马来西亚', MYANMAR: '缅甸', PAKISTAN: '巴基斯坦', PHILIPPINES: '菲律宾', 'SOUTH KOREA': '韩国', 'SRI LANKA': '斯里兰卡', TAIWAN: '中国台湾', THAILAND: '泰国', UZBEKISTAN: '乌兹别克斯坦', VIETNAM: '越南', ALGERIA: '阿尔及利亚', EGYPT: '埃及', MOROCCO: '摩洛哥', 'SOUTH AFRICA': '南非', TUNISIA: '突尼斯', IRAN: '伊朗', TURKEY: '土耳其'
};
const regions = new Set(['NORTH AMERICA', 'LATIN AMERICA', 'EUROPE', 'ASIA', 'AFRICA', 'MIDDLE EAST']);
const cap = /([\d,.]+(?:\s+mil(?:l)?)?\s*(?:u\/d|u\/y|t\/d|t\/y|t\/m))\s*$/i;
const boilerplate = /^(?:Company\/ plant location|Year|opened|DOT|code\(s\)|Employees|\(u=unionized\)|Tire|types\*|Estimated|capacity\*|Explanation of abbreviations|TIRE CONSTRUCTION:|TIRE TYPES:|Names in parentheses|P038_P045_|Visit us on the web|40th GLOBAL|WORLD$|PRODUCTION$|FACILITIES$)/i;
let country = null, region = null, company = null, page = null, pending = '', startLine = 0;
const facilities = [];
const lines = readFileSync(extracted, 'utf8').split(/\r?\n/);
function emit(raw, lineNumber) {
  const match = raw.match(cap);
  if (!match || !country || !company) return;
  const amount = match[1].match(/^([\d,.]+)(?:\s+(mil(?:l)?))?\s+(u\/d|u\/y|t\/d|t\/y|t\/m)$/i);
  if (!amount) return;
  const prefix = raw.slice(0, match.index).trim();
  const year = prefix.match(/\b(18\d{2}|19\d{2}|20\d{2})\b/);
  const siteRaw = year ? prefix.slice(0, year.index).trim() : prefix.split(/\s+[–-]{1,2}\s+/)[0].trim();
  const site = (siteRaw.startsWith('* ') && siteRaw.includes(' / ') ? siteRaw.split(' / ').at(-1).trim() : siteRaw)
    .replace(/\s+(?=[A-Z0-9, ]*\d)[A-Z0-9]{2,3}(?:,\s*[A-Z0-9]{2,3})*$/, '');
  const productTypes = prefix.match(/\b([1-9](?:\s*,\s*[1-9])*)(?:\s*\(([rb,\s]+)\))?\s*$/i);
  const value = Number(amount[1].replaceAll(',', '')) * (amount[2] ? 1_000_000 : 1);
  if (!site || !Number.isFinite(value) || value <= 0) return;
  facilities.push({
    id: `tb2025_${String(facilities.length + 1).padStart(3, '0')}`,
    region, country, source_company: company, site,
    opened: year?.[1] || null, product_types: productTypes?.[0].trim() || null,
    reported_capacity_text: match[1].trim(),
    value, unit: amount[3].toLowerCase(),
    source_page: page, source_line: lineNumber, raw_row: raw.trim(),
    as_of: '2025-08-25', data_type: 'ESTIMATE', quality: 'WARNING',
    source_ids: ['TB2025_PLANTS']
  });
}
for (let i = 0; i < lines.length; i++) {
  const originalLine = lines[i];
  const line = originalLine.trim();
  if (!line) continue;
  const newPage = line.match(/^(\d{2})\s*•\s*August 25, 2025/) || line.match(/^TIRE BUSINESS\s*,\s*August 25, 2025\s*•\s*(\d{2})/);
  if (newPage) {page = Number(newPage[1]); pending = ''; continue;}
  if (regions.has(line)) {region = line; pending = ''; continue;}
  if (names[line]) {country = names[line]; company = null; pending = ''; continue;}
  if (boilerplate.test(line) || /^TIRE BUSINESS\s*,\s*August/.test(line)) continue;
  const isPlant = /^\s{2,}\S/.test(originalLine) || /^\*\s/.test(line);
  const isHeading = !isPlant && /(?:Inc\.|Ltd\.|Co\.|Corp\.|S\.A\.|G\.m\.b\.H\.|Group|Tyres|Tire|Rubber|Pneus|Pneumaticos|MICHELIN|BRIDGESTONE|HANKOOK|CHENG SHIN|SUMITOMO|YOKOHAMA|CHEMCHINA|CEAT)/i.test(line)
    && !/\b(?:18|19|20)\d{2}\b/.test(line) && !cap.test(line);
  if (isHeading && !(pending.startsWith('* ') && !cap.test(pending))) {company = line.replace(/^\*\s*/, ''); pending = ''; continue;}
  if (!isPlant && !pending) {company = line; continue;}
  if (isPlant && !pending) {pending = line; startLine = i + 1;}
  else if (isPlant && pending && cap.test(pending)) {pending = line; startLine = i + 1;}
  else if (isPlant && pending && /\b(?:18|19|20)\d{2}\b/.test(line) && /\b(?:18|19|20)\d{2}\b/.test(pending)) {pending = line; startLine = i + 1;}
  else if (pending) pending += ` ${line}`;
  if (pending && cap.test(pending)) {emit(pending, startLine); pending = '';}
}

// Only unique group + city matches may link the OCR row to an existing factory.
const known = JSON.parse(readFileSync(resolve('site/data/capacity/tyre-factories.json'), 'utf8')).factories;
const makers = JSON.parse(readFileSync(resolve('site/data/capacity/tyre-manufacturers.json'), 'utf8')).manufacturers;
const makerById = new Map(makers.map((maker) => [maker.id, maker]));
const normalize = (value) => String(value || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
for (const row of facilities) {
  const sourceName = normalize(row.source_company);
  const primaryName = normalize(row.source_company.split('(')[0]);
  const matchesGroup = (maker, name) => maker && [maker.name_en, ...(maker.aliases || [])].some((alias) => {
    const key = normalize(alias);
    return (key.length >= 4 || ['mrf', 'bkt'].includes(key)) && name.includes(key);
  });
  const primaryCandidates = makers.filter((maker) => matchesGroup(maker, primaryName));
  const makerCandidates = primaryCandidates.length ? primaryCandidates : makers.filter((maker) => matchesGroup(maker, sourceName));
  row.manufacturer_id = makerCandidates.length === 1 ? makerCandidates[0].id : null;
  const city = normalize(row.site.split(',')[0]);
  const candidates = known.filter((factory) => {
    if (factory.country !== row.country || city.length < 4 || (row.manufacturer_id ? factory.manufacturer_id !== row.manufacturer_id : !matchesGroup(makerById.get(factory.manufacturer_id), sourceName))) return false;
    const place = normalize(factory.place), site = normalize(factory.site);
    return place === city || site === city || site.includes(city);
  });
  row.matched_factory_id = candidates.length === 1 ? candidates[0].id : null;
  if (!row.matched_factory_id && row.country === '柬埔寨' && row.manufacturer_id === 'doublestar' && /snuol|snoul|kratie/i.test(row.site)) row.matched_factory_id = 'kh_doublestar_kratie';
  if (!row.matched_factory_id && row.country === '柬埔寨' && row.manufacturer_id === 'tongyong' && /sihanouk/i.test(row.site)) row.matched_factory_id = 'kh_tongyong_sihanouk';
  delete row.raw_row; // Preserve source line + checksum, not a wholesale copy of the source table.
}

const byCountry = Object.fromEntries([...new Set(facilities.map((row) => row.country))].sort().map((name) => [name, facilities.filter((row) => row.country === name).length]));
const result = {
  schema_version: 1,
  source: {id: 'TB2025_PLANTS', title: 'Tire Business, 40th Global Tire Report, World Tire Production Facilities', published: '2025-08-25', pages: '38–45', url: 'https://www.tirebusiness.com/news/40th-global-tire-report-available-download', original_file: basename(original), original_sha256: sha256(original), extracted_file: basename(extracted), extracted_sha256: sha256(extracted), comparison_file: basename(comparison), comparison_sha256: sha256(comparison)},
  scope: '仅导入OCR可提取且有数值的逐厂产能；包括75强以外厂商。不等于当前开工、已形成能力、全年有效能力或天然橡胶耗用。未导入/无法解析的行保持缺失。',
  row_count: facilities.length, by_country: byCountry, facilities
};
const json = `${JSON.stringify(result, null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(output, 'utf8') !== json) throw new Error('TB2025 output differs from source extraction');
} else if (process.argv.includes('--write')) {
  writeFileSync(output, json);
} else {
  process.stdout.write(`Parsed ${facilities.length} numeric facility rows across ${Object.keys(byCountry).length} countries.\n`);
  process.stdout.write(JSON.stringify(byCountry) + '\n');
  for (const row of facilities.slice(0, 5)) process.stdout.write(JSON.stringify(row) + '\n');
}
