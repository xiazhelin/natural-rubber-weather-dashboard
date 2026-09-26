# 天然橡胶产区天气跟踪面板

面向天然橡胶基本面研究的轻量静态网页。默认跟踪中国、泰国、印度尼西亚、越南和科特迪瓦的29个代表性网格点，展示未来7日天气、每6小时累计降雨、泰国分区周度降雨历史、当地晨间割胶作业窗降雨、IMERG过去24/72小时实况估算、预报兑现率、东南亚周度气温距平、第2–3周热带风险、季节降水/月度距平展望及ENSO/IOD气候背景。

## 数据来源与口径

- 天气数据：Open-Meteo Weather Forecast API，`https://api.open-meteo.com/v1/forecast`。
- 官方文档：`https://open-meteo.com/en/docs`。
- 模型：Open-Meteo Best Match，按地点自动选择可用数值天气模式。
- 性质：模式网格数据，不是地面气象站观测。
- 6小时降雨：将Open-Meteo小时降雨按UTC自然6小时累计，共28个时段；表头为时段起点，任一小时缺失则该时段保持为空。
- 泰国周度降雨：Open-Meteo Historical Weather API的ERA5再分析，0.25°网格；2022年起按泰国当地时间周一至周日累计，仅发布完整周。南部东/西海岸、东北部和北部均为代表网格点等权合成，不是行政区面积加权或地面站实测；ERA5通常约滞后5天。
- 晨间割胶作业窗：默认为各地当地时间02:00—10:00，在`config/locations.json`中可调整。这是统一研究窗口，不代表各产区统一实际班次。
- 实况估算：NASA GPM IMERG Late Run GIS 1-day / 3-day累计产品，0.1°网格；官方介绍：`https://gpm.nasa.gov/data/imerg`。
- IMERG性质：卫星与多源融合的近实时降水估算，不是地面雨量站实测。
- 预报兑现率：`IMERG实况降水 / 验证期开始前的Open-Meteo预报降水 × 100`；按完整UTC日对齐。该值不是准确率，预报低于1 mm时不计算比率。
- 东南亚周度气温距平：NOAA Climate Prediction Center以GTS地面站资料生成的周度初步分析，单位为℃；官方入口：`https://www.cpc.ncep.noaa.gov/products/JAWF_Monitoring/SEAsia/temperature.shtml`。更新脚本按图片内容去重并滚动保留最近4个官方周图；红色表示偏暖、蓝色表示偏冷，空白区不代表距平为0℃，有效期以图内标题为准。
- 中期气候观测：澳大利亚气象局（BoM）Relative Niño3.4与Indian Ocean Dipole周度指数，基准期1991—2020年；官方图表入口：`https://www.bom.gov.au/climate/influences/graphs/`。
- 中期气候展望：NOAA Climate Prediction Center官方RONI outlook；`https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/enso/roni/outlook/`。两家机构的相对指数口径不可直接混用。
- 中期与季节展望：NOAA/CPC Global Tropics Hazards Outlook、IRI季节降水概率、NOAA/CPC NMME月度降水和2米气温距平。图片与发布/起报时间由更新脚本保存到本地；单个产品失败时保留上次图片并标记`WARNING`，无历史图时标记`MISSING`。这些数据均为`ESTIMATE`，IRI与NMME不能当作两组独立证据。
- 坐标：`config/locations.json`中的WGS84研究定位点，不代表种植园或行政区种植面积边界。
- 缺失值：保持为空；不会填0或沿用前值。

天气关注状态只是筛选条件，不代表割胶、产量或价格结论。必须结合物候、持续时间、原料供应、加工利润及库存交叉验证。

## 轮胎产能与橡胶产区地图

`site/capacity.html` 在同一页展示轮胎厂普查和天然橡胶省级产量，并与天气首页互相链接。**全球75强普查进行中，不是全部厂区已核验完成。** 母表采用2025榜单（2024年销售额），暂非2026最新版。截至2026-09-26第二批，已收录56家企业的270个厂区/项目：158个企业等来源厂区、2个公司规划项目、1个待核项目、109个历史行业调查厂区；另467个登记线索分层展示。116个详细地址已核，145个城市/地区近似点，坐标不代表厂门。见[第二批交接与测算](research/global-tyre-census-2026-09-26-v2.md)。

厂区顶部汇总半钢、全钢设计/已形成/2025全年有效能力及耗胶。按用户指定半钢2.6–3.0、全钢22–23吨/千条测算区间，不额外叠加工艺损耗，不代表实际消费。默认仅年能力的A+B满负荷小计156.04–172.19万吨/年，覆盖40/270厂区；日能力可输入生产天数做额外情景，负荷百分比也仅为假设。未来/历史未形成差额28.56–31.10万吨/年单列，不并入A+B；差额不是确定投产计划。工程胎、混合未知和翻新胎不套系数，缺失不填0，集团实耗另列不分摊。原始证据和每笔纳入明细可在网页查询。

地图支持独立缩放、复位、鼠标拖动与方向按钮/键盘平移，保留现有静态SVG，不新增地图依赖。泰国覆盖77行政单元：69个有表列数值、8个未列出保持缺失；2025f生胶片合计4,837,050吨，与同版全国一致。省表使用同版年鉴阅览文本，官方大PDF完整逐页复核待完成，保留WARNING。泰国生胶片与印尼干胶不能跨国加总。

更新入口是三个版本化、可直接读取的静态 JSON：

- `site/data/capacity/tyre-factories.json`：每个厂区的国家、坐标、状态、胎种／阶段、设计与已形成能力、年度有效能力、实际产量、质量状态及原始来源。
- `site/data/capacity/tyre-manufacturers.json`：75强企业母表、榜单版次、销售年度、别名与核验状态。
- `site/data/capacity/rubber-regions.json`：省级或国家级年产量、生产性面积、单位、预测／初值状态、坐标精度及原始来源。

新增或修订一条记录时，保留同一`id`，更新数据日期和`source_ids`；核对原始公告、单位、统计口径与旧值可比性，再运行下方校验。历史行业估计放`survey_observations`，登记地址放`registry_candidates`；二者不得自动升级为在产事实。关闭产线更新状态与变更说明，不能只累加扩产。提交到发布分支`main`后，工作流对`site/**`变动自动校验并部署。Pages只提供公开读取；后续小程序或App可直接消费三份JSON，需要在线编辑审批时才增设受控写入API。本批未提交/推送。

## 更新方式

默认每天 21:00（`Asia/Shanghai`）自动更新并重新发布。同时保留维护者手动更新：

1. 在GitHub仓库进入 **Actions**。
2. 打开“更新并发布天然橡胶产区天气”。
3. 点击 **Run workflow**。

工作流额外校验`github.actor == github.repository_owner`，因此个人仓库只有仓库所有者可以手动更新。若以后迁移到组织仓库，应改为组织的受控维护者名单。

网页不显示手动更新按钮；所有手动更新都在GitHub后台的Actions页面执行。

### 配置NASA IMERG访问

IMERG GeoTIFF的NASA PPS HTTPS入口需凭据。不配置时，Open-Meteo预报仍会正常更新，IMERG和兑现率保持`MISSING`，不沿用旧值。

1. 在`https://registration.pps.eosdis.nasa.gov/registration/`注册NASA PPS。
2. 在GitHub仓库进入 **Settings → Secrets and variables → Actions**。
3. 点击 **New repository secret**。
4. Name填`NASA_PPS_EMAIL`，Secret填PPS注册邮箱；不要把邮箱写入代码或提交到仓库。
5. 在Actions手动运行一次更新。首次只会写入实况；兑现率要等历史预报与后续实况严格对齐后才会出现。

## GitHub Pages首次发布

1. 创建一个公开GitHub仓库并推送本目录。
2. 进入 **Settings → Pages**。
3. 将 **Build and deployment → Source** 设置为 **GitHub Actions**。
4. 首次推送会发布现有页面；随后在Actions中手动运行一次更新任务即可获取最新天气。

## 本地校验

```bash
python3 -m unittest discover -s tests -p "test_*.py"
node tests/test_capacity.js
python3 -m pip install -r requirements.txt
python3 scripts/update_weather.py
python3 -m http.server 8000 --directory site
```

浏览器打开`http://localhost:8000`。脚本的网络访问使用Python标准库；仅读取IMERG GeoTIFF需要Pillow。

## 目录

```text
config/locations.json          产区地点与研究阈值
scripts/update_weather.py      官方数据更新脚本
tests/test_update_weather.py   最小逻辑校验
tests/test_capacity_data.py    地图数据口径与关联校验
tests/test_capacity.js         耗胶情景最小校验
site/                          GitHub Pages发布内容
site/capacity.html             轮胎与橡胶产区地图
site/data/capacity/           地图更新入口（静态JSON）
site/data/thailand-weekly-rain.json  泰国分区周度降雨
site/assets/climate/climate-outlook-manifest.json  中期/季节展望图片元数据
.github/workflows/             手动更新与发布流程
```
