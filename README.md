# 天然橡胶产区天气跟踪面板

面向天然橡胶基本面研究的轻量静态网页。默认跟踪中国、泰国、印度尼西亚、越南和科特迪瓦的29个代表性网格点，展示未来7日天气、每6小时累计降雨、当地晨间割胶作业窗降雨、IMERG过去24/72小时实况估算、预报兑现率及ENSO/IOD中期气候背景。

## 数据来源与口径

- 天气数据：Open-Meteo Weather Forecast API，`https://api.open-meteo.com/v1/forecast`。
- 官方文档：`https://open-meteo.com/en/docs`。
- 模型：Open-Meteo Best Match，按地点自动选择可用数值天气模式。
- 性质：模式网格数据，不是地面气象站观测。
- 6小时降雨：将Open-Meteo小时降雨按UTC自然6小时累计，共28个时段；表头为时段起点，任一小时缺失则该时段保持为空。
- 晨间割胶作业窗：默认为各地当地时间02:00—10:00，在`config/locations.json`中可调整。这是统一研究窗口，不代表各产区统一实际班次。
- 实况估算：NASA GPM IMERG Late Run GIS 1-day / 3-day累计产品，0.1°网格；官方介绍：`https://gpm.nasa.gov/data/imerg`。
- IMERG性质：卫星与多源融合的近实时降水估算，不是地面雨量站实测。
- 预报兑现率：`IMERG实况降水 / 验证期开始前的Open-Meteo预报降水 × 100`；按完整UTC日对齐。该值不是准确率，预报低于1 mm时不计算比率。
- 中期气候观测：澳大利亚气象局（BoM）Relative Niño3.4与Indian Ocean Dipole周度指数，基准期1991—2020年；官方图表入口：`https://www.bom.gov.au/climate/influences/graphs/`。
- 中期气候展望：NOAA Climate Prediction Center官方RONI outlook；`https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/enso/roni/outlook/`。两家机构的相对指数口径不可直接混用。
- 坐标：`config/locations.json`中的WGS84研究定位点，不代表种植园或行政区种植面积边界。
- 缺失值：保持为空；不会填0或沿用前值。

天气关注状态只是筛选条件，不代表割胶、产量或价格结论。必须结合物候、持续时间、原料供应、加工利润及库存交叉验证。

## 更新方式

默认每周五 21:00（`Asia/Shanghai`）自动更新并重新发布。同时保留维护者手动更新：

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
site/                          GitHub Pages发布内容
.github/workflows/             手动更新与发布流程
```
