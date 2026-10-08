# Quant Astro 本地排盘（基础版）

一个本地运行的占星排盘底座：Python 后端用 Swiss Ephemeris 计算，浏览器页面展示结果，
中间由一个很小的 Flask 服务连接。

这一版**只有通用的底座**，不包含任何具体的占星技法（没有西占的相位 / 庙旺，
也没有印占的分盘 / 大运，更没有 KP）。你要做的，是在这个干净的基础上，
自己搭出某一种技法的排盘。

## 现有功能

- 三种数据来源：当前时间 / 位置、手动输入、人物档案
- 行星、小行星、恒星位置，十二宫宫头、四轴、辅助轴点
- 日出日落、值日星、行星时
- 黄道体系（回归 / 恒星）、岁差体系、月交点（平均 / 真）、宫位制、日心制等参数
- 人物档案库：分页浏览、按名字 / 出生时间段 / 标签筛选、排序，
  可在网页里增删自定义字段（文本、数字）

## 运行

需要 Python 3.8 及以上。在项目根目录下：

```
pip install -r requirements_web.txt
python app.py
```

然后用浏览器打开 http://127.0.0.1:5000/ ，按 Ctrl + C 退出。

`quant_astro/ephe/` 里是 Swiss Ephemeris 的星历文件，请不要删。

## 目录结构

```
app.py                  Flask 入口：页面和所有 /api/... 接口
web_bridge.py           桥接层：整理前端传来的参数，调用 quant_astro，把结果转成 JSON
profile_db.py           人物档案的 SQLite 读写
quant_astro/
    core.py             计算底座：时间地理解析、星历、宫位、日出日落、值日星、行星时
    ephe/               Swiss Ephemeris 星历文件
templates/index.html    页面结构
static/app.js           前端逻辑（取参数、请求后端、渲染结果）
static/style.css        样式
user_data/
    settings.json       默认设置（默认地点、默认计算参数等）
    people.sqlite3      人物档案数据库（首次运行时自动创建）
```

## 数据是怎么流动的

```
页面参数 → static/app.js (collectPayload) → POST /api/chart/full
        → app.py → web_bridge.calculate_full_chart
        → quant_astro.core 里的 calculate_* 函数
        → 一个 JSON 字典 → app.js (renderAllResults) → 页面上的表格
```

`calculate_full_chart` 返回的字典里，每个键对应页面上的一个结果板块，
比如 `planet_pos`（行星）、`house_result`（宫位）、`sun_events`（日出日落）。

## 如何加入一种新的技法

下面以“新增一个技法模块”为例，一般需要改这几处：

1. **写计算模块**：在 `quant_astro/` 下新建一个文件（如 `western.py`、`vedic.py`），
   从 `.core` 里导入需要的东西。技法模块依赖 `core`，但 `core` 不要反过来依赖技法模块。
   函数的输入通常是 `planet_pos`、`house_result` 这类现成的计算结果，
   返回值必须能转成 JSON（字典、列表、数字、字符串）。
2. **接到后端**：在 `web_bridge.py` 里仿照 `_calculate_sun_group` 写一个新函数调用它，
   并在 `calculate_full_chart` 返回的字典里加一个新键。
3. **接到页面**：
   - 在 `templates/index.html` 的结果区加一个板块：
     `<section class="panel result-panel"><h2>标题</h2><div id="xxxResult"></div></section>`
   - 在 `static/app.js` 的 `renderAllResults()` 里加一行渲染：
     结果是“名称 → 一行数据”的字典时用 `renderObjectMap("xxxResult", ...)`，
     是简单的“名称 → 值”时用 `renderKeyValue("xxxResult", ...)`。
4. **如果技法需要自己的参数**（比如某个新的下拉菜单或数字）：
   在 `index.html` 加输入控件，在 `app.js` 的 `collectPayload()` 里取值，
   在 `web_bridge.py` 的 `_normalize_input()` 里接收，
   并在 `DEFAULT_SETTINGS` 和 `user_data/settings.json` 里补上默认值。

补充几点：

- 页面上的“排盘”按钮走的是整盘计算（`/api/chart/full`）。
  后端另有一个按参数变化只重算受影响部分的接口（`/api/chart/partial`），
  页面目前没有用它，想做增量更新的同学可以自己接回来。
- 结果表里的数组（如 `[1, 5, 9]`）会显示成“1, 5, 9”，不带方括号，
  这是 `app.js` 里的 `formatValue` 做的。

## 关于人物档案

档案库只保存**人物相关的数据标签**和**排盘必需的要素**（名字、出生时间、时区、经纬度、标签、自定义字段）。
不要把星座、度数这类排盘结果存进去，它们随时可以由出生信息重新算出来。
