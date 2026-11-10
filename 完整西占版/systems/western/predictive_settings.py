"""推运盘的设置：日返、月返、次限、三限、日弧、小限、法达。

每张盘的设置是一组字段，字段的类型、范围、默认值、显示条件都写在下面的 SPEC 里。
同一份 SPEC 既用来校验（normalize_predictive），也原样交给网页（public_spec），
网页按它画设置浮窗，所以加一个字段只改这里，前后端不会对不上。

字段类型：
  choice    从几个值里选一个（choices: [(值, 名称)]）
  number    任意小数（lo、hi 是允许范围；presets 是旁边的快捷按钮，点一下填进数字框，用户仍可改）
  int       整数
  bool      勾选
  house     宫位制（"" = 跟随计算设置）
  point     小限的起点：Asc、MC、七颗行星，或某个 Lot（lot:代码）
  planet_years  法达：每颗星的年数
  sequence  法达：主限顺序（若干行星代码，用空格分开）
when: {字段: [值, ...]}，只有那个字段取这些值时才显示（也只在那时起作用）。
"""

from __future__ import annotations

import re
from typing import Any, Mapping

from common.astro import house_system_options

# ---------------------------------------------------------------- 常用的天文数值（单位：日 / 度）

TROPICAL_YEAR = 365.24219
SIDEREAL_YEAR = 365.256363
JULIAN_YEAR = 365.25
TROPICAL_MONTH = 27.321582
SIDEREAL_MONTH = 27.321662
SYNODIC_MONTH = 29.530589
ANOMALISTIC_MONTH = 27.554550
NAIBOD = 0.98564733            # 360° / 回归年天数：太阳每日平均行度，也是 Naibod 每年的弧

YEAR_PRESETS = [(TROPICAL_YEAR, "回归年"), (SIDEREAL_YEAR, "恒星年"), (JULIAN_YEAR, "儒略年"), (360, "360 日")]
MONTH_PRESETS = [(TROPICAL_MONTH, "回归月"), (SIDEREAL_MONTH, "恒星月"), (SYNODIC_MONTH, "朔望月"),
                 (ANOMALISTIC_MONTH, "近点月")]
RATE_PRESETS = [(NAIBOD, "Naibod"), (1, "1°")]

FIRDARIA_CODES = ("Su", "Mo", "Me", "Ve", "Ma", "Ju", "Sa", "Ra", "Ke")
FIRDARIA_YEARS = {"Su": 10, "Ve": 8, "Me": 13, "Mo": 9, "Sa": 11, "Ju": 12, "Ma": 7, "Ra": 3, "Ke": 2}
FIRDARIA_DAY = ["Su", "Ve", "Me", "Mo", "Sa", "Ju", "Ma", "Ra", "Ke"]
FIRDARIA_NIGHT_ABU_MASHAR = ["Mo", "Sa", "Ju", "Ma", "Ra", "Ke", "Su", "Ve", "Me"]
FIRDARIA_NIGHT_BONATTI = ["Mo", "Sa", "Ju", "Ma", "Su", "Ve", "Me", "Ra", "Ke"]

PROFECTION_POINTS = ("Asc", "MC", "Su", "Mo", "Me", "Ve", "Ma", "Ju", "Sa")
LOT_POINT_RE = re.compile(r"^lot:[A-Za-z0-9_]{1,24}$")

# ---------------------------------------------------------------- 各张盘共用的几组字段

def _location(label="地点", tz=False):
    fields = [
        {"key": "location", "type": "choice", "label": label, "default": "natal",
         "choices": [("natal", "出生地"), ("target", "顶栏地点"), ("custom", "自定义")]},
        {"key": "custom_lat", "type": "number", "label": "纬度", "unit": "°（北正南负）", "default": 0,
         "lo": -89.999, "hi": 89.999, "when": {"location": ["custom"]}},
        {"key": "custom_lon", "type": "number", "label": "经度", "unit": "°（东正西负）", "default": 0,
         "lo": -180, "hi": 180, "when": {"location": ["custom"]}},
    ]
    if tz:
        fields.append({"key": "custom_tz", "type": "number", "label": "时区", "unit": "小时（东正西负）", "default": 8,
                       "lo": -14, "hi": 14, "when": {"location": ["custom"]}})
    return fields


_HOUSE = {"key": "house_system", "type": "house", "label": "宫位制", "default": ""}

_DIRECTION = {"key": "direction", "type": "choice", "label": "方向", "default": "forward",
              "choices": [("forward", "顺推"), ("converse", "逆推")]}


def _returns(body_name, period_word):
    return [
        {"section": "时刻"},
        {"key": "frame", "type": "choice", "label": "黄道", "default": "chart",
         "choices": [("chart", "跟随计算设置"), ("tropical", "回归黄道"), ("sidereal", "恒星黄道（含岁差修正）")]},
        {"key": "offset", "type": "number", "label": f"{body_name}回到", "unit": f"本命{body_name} + 这么多度",
         "default": 0, "lo": -360, "hi": 360,
         "presets": [(0, "返照"), (180, "半返"), (90, "四分之一"), (270, "四分之三")]},
        {"key": "pick", "type": "choice", "label": "选哪一次", "default": "before",
         "choices": [("before", "顶栏时间之前最近一次"), ("after", "之后第一次"), ("nearest", "离得最近的一次")]},
        {"key": "shift", "type": "int", "label": "再往后数", "unit": f"次（负数往前；每次约{period_word}）",
         "default": 0, "lo": -999, "hi": 999},
        {"section": "地点与宫位"},
        *_location("起盘地点", tz=True),
        _HOUSE,
    ]


def _progressions(life_default, life_presets, life_word):
    return [
        {"section": "推运速率"},
        {"key": "eph_days", "type": "number", "label": "星历走", "unit": "日", "default": 1, "lo": 1e-6, "hi": 100000},
        {"key": "life_days", "type": "number", "label": "对应人生", "unit": f"日（{life_word}）",
         "default": life_default, "lo": 1e-6, "hi": 1000000, "presets": life_presets},
        _DIRECTION,
        {"section": "四轴与宫头"},
        {"key": "angles", "type": "choice", "label": "中天怎么推", "default": "solar_arc_lon",
         "choices": [("solar_arc_lon", "太阳弧（黄经）"), ("solar_arc_ra", "太阳弧（赤经）"),
                     ("naibod_lon", "固定速率（黄经）"), ("naibod_ra", "固定速率（赤经）"),
                     ("real", "推运时刻的真实恒星时"), ("natal", "保持本命")]},
        {"key": "rate", "type": "number", "label": "速率", "unit": f"° / 每个{life_word}", "default": NAIBOD,
         "lo": -360, "hi": 360, "presets": RATE_PRESETS, "when": {"angles": ["naibod_lon", "naibod_ra"]}},
        *_location("宫位地点"),
        _HOUSE,
    ]


SPEC: dict[str, dict[str, Any]] = {
    "solar_return": {"title": "日返", "fields": _returns("太阳", "一年")},
    "lunar_return": {"title": "月返", "fields": _returns("月亮", "一个月")},
    "secondary": {"title": "次限", "fields": _progressions(TROPICAL_YEAR, YEAR_PRESETS, "年")},
    "tertiary": {"title": "三限", "fields": _progressions(TROPICAL_MONTH, MONTH_PRESETS, "月")},
    "solar_arc": {"title": "日弧", "fields": [
        {"section": "弧"},
        {"key": "arc", "type": "choice", "label": "弧的来源", "default": "true_lon",
         "choices": [("true_lon", "次限太阳的黄经弧"), ("true_ra", "次限太阳的赤经弧"), ("rate", "固定速率")]},
        {"key": "eph_days", "type": "number", "label": "星历走", "unit": "日", "default": 1, "lo": 1e-6, "hi": 100000,
         "when": {"arc": ["true_lon", "true_ra"]}},
        {"key": "life_days", "type": "number", "label": "对应人生", "unit": "日（一年的长度）", "default": TROPICAL_YEAR,
         "lo": 1e-6, "hi": 1000000, "presets": YEAR_PRESETS},
        {"key": "rate", "type": "number", "label": "速率", "unit": "° / 年", "default": NAIBOD, "lo": -360, "hi": 360,
         "presets": RATE_PRESETS, "when": {"arc": ["rate"]}},
        _DIRECTION,
        {"section": "加弧"},
        {"key": "direct_in", "type": "choice", "label": "加在", "default": "lon",
         "choices": [("lon", "黄经上"), ("ra", "赤经上")]},
        {"key": "houses", "type": "choice", "label": "宫头", "default": "arc",
         "choices": [("arc", "宫头一起加弧"), ("from_mc", "由加弧后的中天重算"), ("natal", "保持本命")]},
        {**_location("宫位地点")[0], "when": {"houses": ["from_mc"]}},
        *[{**f, "when": {**f["when"], "houses": ["from_mc"]}} for f in _location()[1:]],
        {**_HOUSE, "when": {"houses": ["from_mc"]}},
        {"key": "stars", "type": "bool", "label": "恒星也加弧", "default": False},
    ]},
    "profection": {"title": "小限", "fields": [
        {"section": "起点与跳法"},
        {"key": "start", "type": "point", "label": "起点", "default": "Asc"},
        {"key": "mode", "type": "choice", "label": "跳法", "default": "sign",
         "choices": [("sign", "整星座"), ("degree", "按度数（每步 30°）"), ("continuous", "连续移动")]},
        {"key": "rulers", "type": "choice", "label": "星座主星", "default": "traditional",
         "choices": [("traditional", "古典七星"), ("modern", "现代（天蝎冥王、水瓶天王、双鱼海王）")]},
        {"section": "年"},
        {"key": "year_start", "type": "choice", "label": "每年从", "default": "solar_return",
         "choices": [("solar_return", "太阳回归时刻"), ("anniversary", "生日（日历周年）"), ("fixed", "出生时刻 + 固定年长")]},
        {"key": "year_days", "type": "number", "label": "年长", "unit": "日", "default": TROPICAL_YEAR,
         "lo": 1, "hi": 100000, "presets": YEAR_PRESETS, "when": {"year_start": ["fixed"]}},
        {"key": "year_step", "type": "int", "label": "每年前进", "unit": "个星座（负数倒走）", "default": 1, "lo": -11, "hi": 11},
        {"section": "月"},
        {"key": "month_mode", "type": "choice", "label": "月怎么分", "default": "equal",
         "choices": [("equal", "把一年等分"), ("days", "固定天数"), ("solar", "太阳每走一段")]},
        {"key": "month_parts", "type": "number", "label": "等分成", "unit": "份", "default": 12, "lo": 1, "hi": 400,
         "when": {"month_mode": ["equal"]}},
        {"key": "month_days", "type": "number", "label": "每月", "unit": "日", "default": 30.436849, "lo": 0.01, "hi": 10000,
         "presets": [(30.436849, "年长 / 12"), (30, "30 日"), (SYNODIC_MONTH, "朔望月"), (28, "28 日")],
         "when": {"month_mode": ["days"]}},
        {"key": "month_sun_deg", "type": "number", "label": "太阳每走", "unit": "°", "default": 30, "lo": 0.01, "hi": 360,
         "when": {"month_mode": ["solar"]}},
        {"key": "month_from", "type": "choice", "label": "月小限从", "default": "year",
         "choices": [("year", "当年的年小限起"), ("start", "本命起点起")]},
        {"key": "month_step", "type": "int", "label": "每月前进", "unit": "个星座", "default": 1, "lo": -11, "hi": 11},
        {"section": "日"},
        {"key": "day_mode", "type": "choice", "label": "日怎么分", "default": "equal",
         "choices": [("equal", "把一个月等分"), ("days", "固定天数")]},
        {"key": "day_parts", "type": "number", "label": "等分成", "unit": "份", "default": 12, "lo": 1, "hi": 1000,
         "when": {"day_mode": ["equal"]}},
        {"key": "day_days", "type": "number", "label": "每段", "unit": "日", "default": 2.5, "lo": 0.001, "hi": 1000,
         "presets": [(2.5, "2.5 日"), (1, "1 日")], "when": {"day_mode": ["days"]}},
        {"key": "day_step", "type": "int", "label": "每段前进", "unit": "个星座", "default": 1, "lo": -11, "hi": 11},
        {"section": "列表"},
        {"key": "table_years", "type": "int", "label": "年表列到", "unit": "岁", "default": 100, "lo": 1, "hi": 150},
    ]},
    "firdaria": {"title": "法达", "fields": [
        {"section": "日夜与顺序"},
        {"key": "sect", "type": "choice", "label": "日生 / 夜生", "default": "chart",
         "choices": [("chart", "按本命盘"), ("day", "一律按日生"), ("night", "一律按夜生")]},
        {"key": "day_order", "type": "sequence", "label": "日生顺序", "default": FIRDARIA_DAY,
         "presets": [(FIRDARIA_DAY, "标准")]},
        {"key": "night_order", "type": "sequence", "label": "夜生顺序", "default": FIRDARIA_NIGHT_ABU_MASHAR,
         "presets": [(FIRDARIA_NIGHT_ABU_MASHAR, "Abu Ma'shar"), (FIRDARIA_NIGHT_BONATTI, "Bonatti")]},
        {"key": "years", "type": "planet_years", "label": "每颗星的年数", "default": FIRDARIA_YEARS, "lo": 0, "hi": 200},
        {"section": "子限"},
        {"key": "sub_mode", "type": "choice", "label": "子限长度", "default": "equal",
         "choices": [("equal", "七等分"), ("proportional", "按各星年数的比例")]},
        {"key": "sub_order", "type": "choice", "label": "子限顺序", "default": "chaldean",
         "choices": [("chaldean", "从主限星起，按迦勒底序"), ("sequence", "从主限星起，按主限顺序")]},
        {"key": "node_subs", "type": "bool", "label": "交点也分子限", "default": False},
        {"section": "年"},
        {"key": "year_start", "type": "choice", "label": "每年从", "default": "fixed",
         "choices": [("fixed", "出生时刻 + 固定年长"), ("solar_return", "太阳回归时刻"), ("anniversary", "生日（日历周年）")]},
        {"key": "year_days", "type": "number", "label": "年长", "unit": "日", "default": TROPICAL_YEAR,
         "lo": 1, "hi": 100000, "presets": YEAR_PRESETS, "when": {"year_start": ["fixed"]}},
    ]},
}

# 双盘相位：外圈（过境 / 推运盘）的点与内圈（本命）的点之间的相位。每张盘各自的容许度：
# 统一度数（每个点都用这个容许度），或按「相位 → 容许度」里的设置乘一个系数。
BIWHEEL_VIEWS = (("transit", "过境", "fixed", 2), ("solar_return", "日返", "scale", 1), ("lunar_return", "月返", "scale", 1),
                 ("secondary", "次限", "fixed", 1), ("tertiary", "三限", "fixed", 1), ("solar_arc", "日弧", "fixed", 1))


def _biwheel_fields():
    fields = []
    for view, label, mode, value in BIWHEEL_VIEWS:
        fields += [
            {"section": label},
            {"key": f"{view}_mode", "type": "choice", "label": "容许度", "default": mode,
             "choices": [("fixed", "统一度数"), ("scale", "相位设置 × 系数")]},
            {"key": f"{view}_orb", "type": "number", "label": "度数", "unit": "°", "lo": 0, "hi": 30,
             "default": value if mode == "fixed" else 2, "presets": [(1, "1°"), (2, "2°"), (3, "3°")],
             "when": {f"{view}_mode": ["fixed"]}},
            {"key": f"{view}_scale", "type": "number", "label": "系数", "unit": "倍", "lo": 0, "hi": 10,
             "default": value if mode == "scale" else 1, "presets": [(1, "1"), (0.5, "0.5")],
             "when": {f"{view}_mode": ["scale"]}},
        ]
    fields += [
        {"section": "参与的点"},
        {"key": "outer_axes", "type": "bool", "label": "外圈的四轴", "default": True},
        {"key": "inner_axes", "type": "bool", "label": "内圈的四轴", "default": True},
    ]
    return fields


SPEC["biwheel"] = {"title": "双盘相位", "fields": _biwheel_fields()}

PREDICTIVE_KINDS = tuple(SPEC)


def _fields(kind):
    return [f for f in SPEC[kind]["fields"] if "key" in f]


def _defaults(kind):
    out = {}
    for f in _fields(kind):
        value = f["default"]
        out[f["key"]] = list(value) if isinstance(value, list) else dict(value) if isinstance(value, dict) else value
    return out


DEFAULT_PREDICTIVE = {kind: _defaults(kind) for kind in PREDICTIVE_KINDS}


# ---------------------------------------------------------------- 校验

def _bad(strict, message):
    if strict:
        raise ValueError(message)


def _clean_field(f, raw, strict, title):
    key, kind, default = f["key"], f["type"], f["default"]
    what = f"{title} · {f['label']}"
    if raw is None:
        return _defaults_value(default)
    if kind == "choice":
        values = [v for v, _ in f["choices"]]
        if raw in values:
            return raw
        _bad(strict, f"{what}只能是：{'、'.join(label for _, label in f['choices'])}。")
        return default
    if kind in ("number", "int"):
        try:
            number = float(raw)
            ok = f["lo"] <= number <= f["hi"] and (kind == "number" or number.is_integer())
        except (TypeError, ValueError):
            ok = False
        if not ok:
            unit = "整数" if kind == "int" else "数字"
            _bad(strict, f"{what}必须是 {f['lo']:g} 到 {f['hi']:g} 之间的{unit}。")
            return default
        return int(number) if kind == "int" else (int(number) if number.is_integer() else number)
    if kind == "bool":
        if isinstance(raw, bool):
            return raw
        _bad(strict, f"{what}格式不对。")
        return default
    if kind == "house":
        if raw == "" or raw in house_system_options():
            return raw
        _bad(strict, f"{what}：未知的宫位制 {raw!r}。")
        return default
    if kind == "point":
        if raw in PROFECTION_POINTS or (isinstance(raw, str) and LOT_POINT_RE.match(raw)):
            return raw
        _bad(strict, f"{what}：未知的起点 {raw!r}。")
        return default
    if kind == "planet_years":
        out = {}
        source = raw if isinstance(raw, Mapping) else {}
        for code in FIRDARIA_CODES:
            value = source.get(code, default[code])
            try:
                number = float(value)
                if not f["lo"] <= number <= f["hi"]:
                    raise ValueError
            except (TypeError, ValueError):
                _bad(strict, f"{what}：{code} 必须是 {f['lo']:g} 到 {f['hi']:g} 之间的数字。")
                number = float(default[code])
            out[code] = int(number) if number.is_integer() else number
        return out
    if kind == "sequence":
        items = raw.split() if isinstance(raw, str) else list(raw) if isinstance(raw, (list, tuple)) else None
        if items is not None:
            items = [str(x) for x in items]
            if items and all(x in FIRDARIA_CODES for x in items) and len(set(items)) == len(items):
                return items
        _bad(strict, f"{what}：只能填 {' '.join(FIRDARIA_CODES)} 里的代码，至少一个，不能重复。")
        return list(default)
    raise AssertionError(kind)


def _defaults_value(default):
    return list(default) if isinstance(default, list) else dict(default) if isinstance(default, dict) else default


def normalize_predictive(raw, *, strict=False):
    raw = raw if isinstance(raw, Mapping) else {}
    result = {}
    for kind in PREDICTIVE_KINDS:
        section = raw.get(kind) if isinstance(raw.get(kind), Mapping) else {}
        if strict and kind in raw and not isinstance(raw.get(kind), Mapping):
            raise ValueError(f"{SPEC[kind]['title']}的设置格式不对。")
        title = SPEC[kind]["title"]
        clean = {}
        for f in _fields(kind):
            clean[f["key"]] = _clean_field(f, section.get(f["key"]), strict, title)
        if kind == "firdaria" and strict:
            for key in ("day_order", "night_order"):
                if sum(float(clean["years"][c]) for c in clean[key]) <= 0:
                    raise ValueError(f"法达 · {'日生' if key == 'day_order' else '夜生'}顺序里各星的年数加起来必须大于 0。")
        result[kind] = clean
    return result


def public_spec():
    """交给网页画设置浮窗用（choices / presets 写成 [{value, label}]）。"""
    out = {}
    for kind, spec in SPEC.items():
        fields = []
        for f in spec["fields"]:
            item = dict(f)
            if "choices" in item:
                item["choices"] = [{"value": v, "label": label} for v, label in item["choices"]]
            if "presets" in item:
                item["presets"] = [{"value": v, "label": label} for v, label in item["presets"]]
            fields.append(item)
        out[kind] = {"title": spec["title"], "fields": fields}
    return out
