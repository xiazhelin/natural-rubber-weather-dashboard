# 天然橡胶产区天气跟踪面板

面向天然橡胶基本面研究的轻量静态网页。默认跟踪中国、泰国、印度尼西亚、越南和科特迪瓦的29个代表性网格点，展示未来7日降雨、温度、土壤水分、天气关注状态及相邻两次更新的预报变化。

## 数据来源与口径

- 天气数据：Open-Meteo Weather Forecast API，`https://api.open-meteo.com/v1/forecast`。
- 官方文档：`https://open-meteo.com/en/docs`。
- 模型：Open-Meteo Best Match，按地点自动选择可用数值天气模式。
- 性质：模式网格数据，不是地面气象站观测。
- 坐标：`config/locations.json`中的WGS84研究定位点，不代表种植园或行政区种植面积边界。
- 缺失值：保持为空；不会填0或沿用前值。

天气关注状态只是筛选条件，不代表割胶、产量或价格结论。必须结合物候、持续时间、原料供应、加工利润及库存交叉验证。

## 更新方式

默认仅允许维护者手动更新：

1. 在GitHub仓库进入 **Actions**。
2. 打开“更新并发布天然橡胶产区天气”。
3. 点击 **Run workflow**。

工作流额外校验`github.actor == github.repository_owner`，因此个人仓库只有仓库所有者可以手动更新。若以后迁移到组织仓库，应改为组织的受控维护者名单。

需要定时更新时，编辑`.github/workflows/update-weather.yml`，取消`schedule`两行注释并调整cron。GitHub cron使用UTC；示例`15 0 * * *`对应北京时间每天08:15。

## GitHub Pages首次发布

1. 创建一个公开GitHub仓库并推送本目录。
2. 进入 **Settings → Pages**。
3. 将 **Build and deployment → Source** 设置为 **GitHub Actions**。
4. 首次推送会发布现有页面；随后在Actions中手动运行一次更新任务即可获取最新天气。

## 本地校验

```bash
python3 -m unittest discover -s tests -p "test_*.py"
python3 scripts/update_weather.py
python3 -m http.server 8000 --directory site
```

浏览器打开`http://localhost:8000`。更新脚本只使用Python标准库，无需安装依赖。

## 目录

```text
config/locations.json          产区地点与研究阈值
scripts/update_weather.py      官方数据更新脚本
tests/test_update_weather.py   最小逻辑校验
site/                          GitHub Pages发布内容
.github/workflows/             手动更新与发布流程
```
