"""西方占星：设置的默认值与校验、排盘计算（行星、宫位、小行星、恒星、特殊点、Lot、映点、相位）。"""

from __future__ import annotations

from typing import Mapping
import json
import re

import swisseph as swe

from common.astro import (
    ayanamsha_options,
    calculate_day_lord,
    calculate_houses,
    calculate_planetary_hour,
    calculate_planets,
    calculate_sunrise_sunset,
    clean_basic_calc,
    house_system_options,
    parse_time_geo,
)
from common.web import safe_json

from .astro import (
    SPECIAL_POINTS,
    calculate_asteroids,
    calculate_fixed_stars,
    calculate_special_points,
    choose_formula,
    evaluate,
    normalize_formula,
    parse_formula,
    special_point,
    sun_above_horizon,
)
from .astro.dignities import (
    EMPIRICAL_MEAN,
    EMPIRICAL_NODE,
    TRADITIONAL_MEAN,
    astronomical_mean,
    planet_rows,
    point_rows,
)
from .astro.aspects import ORB_RULES, AspectPoint, AspectType, find_aspects
from .astro.lots import LOT_CODE_RE, needs_sect
from .astro.points import MAX_ASTEROID_NUMBER


# ---------------------------------------------------------------- 星体配置
#
# 行星 / 小行星 / 恒星 / Lot / 特殊点 都属于基础算法，没有“模块开关”：
# 勾选了哪些就算哪些；某一类一个都没勾选时，页面上直接不显示那一类的标签页。
# 配置保存在 settings.json 的 points 一节，网页上修改后自动写回。

# 主行星在页面上的显示顺序。勾选列表、结果表、星盘都按这个顺序。
MAIN_PLANET_ORDER = ("Su", "Mo", "Me", "Ve", "Ma", "Ju", "Sa", "Ur", "Ne", "Pl", "Ra", "Ke")

# 行星符号（相位矩阵用）。行星的符号固定；小行星、恒星、Lot 的符号在各自的设置里可以修改。
PLANET_SYMBOLS = {
    "Su": "☉", "Mo": "☽", "Me": "☿", "Ve": "♀", "Ma": "♂", "Ju": "♃", "Sa": "♄",
    "Ur": "♅", "Ne": "♆", "Pl": "♇", "Ra": "☊", "Ke": "☋",
}

# 有标准符号的小行星（MPC 编号 → 符号）；其它小行星默认用英文名的前三个字母。
ASTEROID_SYMBOLS = {1: "⚳", 2: "⚴", 3: "⚵", 4: "⚶", 2060: "⚷"}

# 有通用符号的 Lot（代码不区分大小写）；其它 Lot 默认用代码的前三个字母。
LOT_SYMBOLS = {"fortune": "⊗"}

# 特殊点在相位表里的简写。
SPECIAL_SYMBOLS = {
    "MeanApog": "⚸", "MeanPerig": "Pri", "TrueApog": "⚸T", "TruePerig": "PriT",
    "IntpApog": "⚸N", "IntpPerig": "PriN", "Syzygy": "Syz",
    "Vertex": "Vx", "AntiVertex": "AVx", "EastPoint": "EP",
}

PLANET_LABELS = {
    "Su": "太阳", "Mo": "月亮", "Me": "水星", "Ve": "金星", "Ma": "火星",
    "Ju": "木星", "Sa": "土星", "Ur": "天王星", "Ne": "海王星", "Pl": "冥王星",
    "Ra": "罗睺（北交点）", "Ke": "计都（南交点）",
}

DEFAULT_ASTEROIDS = [
    {"number": 3, "label": "婚神星", "symbol": "⚵", "enabled": True},
    {"number": 2, "label": "智神星", "symbol": "⚴", "enabled": True},
    {"number": 1, "label": "谷神星", "symbol": "⚳", "enabled": True},
    {"number": 4, "label": "灶神星", "symbol": "⚶", "enabled": True},
    {"number": 2060, "label": "凯龙星", "symbol": "⚷", "enabled": True},
    # 爱神星不在主小行星文件 seas_*.se1 里，需要单独的 ast0/se00433s.se1，
    # 默认先不勾选；把文件放进 common/astro/ephe/ast0/ 后再勾选即可。
    {"number": 433, "label": "爱神星", "symbol": "Ero", "enabled": False},
]

# 15 颗 Behenian 恒星（阿格里帕《神秘哲学》的顺序）。query 用 sefstars.txt 里的命名，避免重名。
DEFAULT_STARS = [
    {"query": ",bePer", "label": "大陵五", "symbol": "Alg", "enabled": True},
    {"query": ",etTau", "label": "昴宿六", "symbol": "Alc", "enabled": True},
    {"query": ",alTau", "label": "毕宿五", "symbol": "Ald", "enabled": True},
    {"query": ",alAur", "label": "五车二", "symbol": "Cap", "enabled": True},
    {"query": ",alCMa", "label": "天狼星", "symbol": "Sir", "enabled": True},
    {"query": ",alCMi", "label": "南河三", "symbol": "Pro", "enabled": True},
    {"query": ",alLeo", "label": "轩辕十四", "symbol": "Reg", "enabled": True},
    {"query": ",deCrv", "label": "轸宿四", "symbol": "Alr", "enabled": True},
    {"query": ",alVir", "label": "角宿一", "symbol": "Spi", "enabled": True},
    {"query": ",alBoo", "label": "大角星", "symbol": "Arc", "enabled": True},
    {"query": ",alCrB", "label": "贯索四", "symbol": "Alp", "enabled": True},
    {"query": ",alSco", "label": "心宿二", "symbol": "Ant", "enabled": True},
    {"query": ",alLyr", "label": "织女一", "symbol": "Veg", "enabled": True},
    {"query": ",deCap", "label": "垒壁阵四", "symbol": "DAl", "enabled": True},
    {"query": ",alPsA", "label": "北落师门", "symbol": "Fom", "enabled": True},
]

# 上一版的默认名称是「中文 英文」，现在只用中文：读到没改过的旧默认名称时换成新的。
_OLD_STAR_LABELS = {",bePer": "大陵五 Algol", ",etTau": "昴宿六 Alcyone", ",alTau": "毕宿五 Aldebaran", ",alAur": "五车二 Capella", ",alCMa": "天狼星 Sirius", ",alCMi": "南河三 Procyon", ",alLeo": "轩辕十四 Regulus", ",deCrv": "轸宿四 Algorab", ",alVir": "角宿一 Spica", ",alBoo": "大角星 Arcturus", ",alCrB": "贯索四 Alphecca", ",alSco": "心宿二 Antares", ",alLyr": "织女一 Vega", ",deCap": "垒壁阵四 Deneb Algedi", ",alPsA": "北落师门 Fomalhaut"}

# 每个 Lot 有自己的日夜规则 sect_mode：
#   auto  按出生时太阳是否在地平线上选日 / 夜公式；day / night  固定用日间 / 夜间公式。
DEFAULT_LOTS = {
    "items": [
        {"code": "Fortune", "label": "福点", "symbol": "⊗", "day": "Asc + Mo - Su", "night": "Asc + Su - Mo",
         "sect_mode": "auto", "enabled": True},
        {"code": "Spirit", "label": "精神点", "symbol": "Spi", "day": "Asc + Su - Mo", "night": "Asc + Mo - Su",
         "sect_mode": "auto", "enabled": True},
    ],
}

DEFAULT_SPECIALS = ["MeanApog", "Syzygy", "Vertex"]

DEFAULT_POINTS = {
    "planets": list(MAIN_PLANET_ORDER),
    "asteroids": DEFAULT_ASTEROIDS,
    "stars": DEFAULT_STARS,
    "lots": DEFAULT_LOTS,
    "specials": DEFAULT_SPECIALS,
    # antiscia / special_styles / planet_colors / sign_colors 在下面的“配色与映点”一节里补上
}

# 旧版 settings.json 里的条目没有 symbol：默认条目沿用默认符号，其它的自动生成。
_DEFAULT_ASTEROID_SYMBOLS = {**ASTEROID_SYMBOLS, **{a["number"]: a["symbol"] for a in DEFAULT_ASTEROIDS}}
_DEFAULT_STAR_SYMBOLS = {s["query"].casefold(): s["symbol"] for s in DEFAULT_STARS}

SECT_MODES = ("auto", "day", "night")
MAX_LABEL_LEN = 30
MAX_SYMBOL_LEN = 6
MAX_ITEMS = 100


def _clean_label(value, fallback=""):
    text = " ".join(str(value or "").split())[:MAX_LABEL_LEN]
    return text or fallback


def _clean_symbol(value, fallback):
    text = "".join(str(value or "").split())[:MAX_SYMBOL_LEN]
    return text or fallback[:MAX_SYMBOL_LEN]


def _ascii_abbr(text, fallback):
    """取英文名的前三个字母做默认符号；没有英文字母时用 fallback。"""
    letters = "".join(ch for ch in str(text or "") if ch.isascii() and (ch.isalnum() or ch == " ")).strip()
    word = letters.split()[-1] if letters.split() else ""
    return word[:3].capitalize() if word else fallback


def _as_bool(value, default=True):
    return value if isinstance(value, bool) else default


def _normalize_planets(raw, strict):
    if not isinstance(raw, (list, tuple)):
        if strict:
            raise ValueError("planets 必须是行星代码列表。")
        return list(MAIN_PLANET_ORDER)
    wanted = {str(code) for code in raw}
    unknown = wanted - set(MAIN_PLANET_ORDER)
    if unknown and strict:
        raise ValueError(f"未知的行星代码：{'、'.join(sorted(unknown))}")
    return [code for code in MAIN_PLANET_ORDER if code in wanted]


def _normalize_asteroids(raw, strict):
    if not isinstance(raw, list):
        if strict:
            raise ValueError("asteroids 必须是列表。")
        return json.loads(json.dumps(DEFAULT_ASTEROIDS))
    result, seen = [], set()
    for item in raw:
        try:
            number = int(item.get("number")) if isinstance(item, Mapping) else int(item)
            if not 1 <= number <= MAX_ASTEROID_NUMBER:
                raise ValueError
        except (TypeError, ValueError):
            if strict:
                raise ValueError(f"小行星编号必须是 1–{MAX_ASTEROID_NUMBER} 的整数：{item!r}")
            continue
        if number in seen:
            if strict:
                raise ValueError(f"小行星 #{number} 已经在列表里了。")
            continue
        seen.add(number)
        item = item if isinstance(item, Mapping) else {}
        label = _clean_label(item.get("label"), f"#{number}")
        result.append({
            "number": number,
            "label": label,
            "symbol": _clean_symbol(item.get("symbol"), _DEFAULT_ASTEROID_SYMBOLS.get(number) or f"#{number}"),
            "color": _clean_color(item.get("color"), DEFAULT_ASTEROID_COLORS.get(number, DEFAULT_ASTEROID_COLOR)),
            "enabled": _as_bool(item.get("enabled")),
        })
    if len(result) > MAX_ITEMS:
        raise ValueError(f"小行星最多 {MAX_ITEMS} 个。")
    return result


def _normalize_stars(raw, strict):
    if not isinstance(raw, list):
        if strict:
            raise ValueError("stars 必须是列表。")
        return json.loads(json.dumps(DEFAULT_STARS))
    result, seen = [], set()
    for item in raw:
        if not isinstance(item, Mapping):
            if strict:
                raise ValueError(f"恒星条目格式不对：{item!r}")
            continue
        query = " ".join(str(item.get("query") or "").split())
        if not query or query.isdigit() or len(query) > 60:
            if strict:
                raise ValueError(f"恒星名称不合法：{query!r}")
            continue
        if query.casefold() in seen:
            if strict:
                raise ValueError(f"恒星「{query}」已经在列表里了。")
            continue
        seen.add(query.casefold())
        label = _clean_label(item.get("label"), query)
        if _OLD_STAR_LABELS.get(query) == label:
            label = label.split(" ")[0]
        result.append({
            "query": query,
            "label": label,
            "symbol": _clean_symbol(item.get("symbol"), _DEFAULT_STAR_SYMBOLS.get(query.casefold())
                                    or _ascii_abbr(label, query.lstrip(",")[:3] or "★")),
            "color": _clean_color(item.get("color"), DEFAULT_STAR_COLOR),
            "enabled": _as_bool(item.get("enabled")),
        })
    if len(result) > MAX_ITEMS:
        raise ValueError(f"恒星最多 {MAX_ITEMS} 个。")
    return result


def _lot_refs(lot):
    """一个 Lot 的两条公式里引用到的其它 Lot 代码（小写）。"""
    refs = set()
    for key in ("day", "night"):
        text = str(lot.get(key) or "").strip()
        if text:
            refs |= {t.value.casefold() for t in parse_formula(text) if t.kind == "lot"}
    return refs


def _normalize_lots(raw, strict):
    if not isinstance(raw, Mapping):
        if strict:
            raise ValueError("lots 格式不对。")
        return json.loads(json.dumps(DEFAULT_LOTS))
    # 旧版本是所有 Lot 共用一个 sect_mode；读到旧设置时，作为每个 Lot 的初始值。
    legacy_mode = str(raw.get("sect_mode") or "auto")
    if legacy_mode not in SECT_MODES:
        legacy_mode = "auto"
    items, seen = [], set()
    for item in raw.get("items") or []:
        try:
            if not isinstance(item, Mapping):
                raise ValueError(f"Lot 条目格式不对：{item!r}")
            code = str(item.get("code") or "").strip()
            if not LOT_CODE_RE.match(code):
                raise ValueError(f"Lot 代码「{code}」不合法：以英文字母开头，只用字母、数字、下划线，最多 20 个字符。")
            if code.casefold() in seen:
                raise ValueError(f"Lot 代码「{code}」重复了。")
            day = str(item.get("day") or "").strip()
            night = str(item.get("night") or "").strip()
            label = _clean_label(item.get("label"), code)
            sect_mode = str(item.get("sect_mode") or legacy_mode)
            if sect_mode not in SECT_MODES:
                raise ValueError(f"「{label}」的日夜规则只能是 auto、day 或 night。")
            try:
                day = normalize_formula(day)
            except ValueError as exc:
                raise ValueError(f"「{label}」的日间公式：{exc}") from None
            if night:
                try:
                    night = normalize_formula(night)
                except ValueError as exc:
                    raise ValueError(f"「{label}」的夜间公式：{exc}") from None
        except ValueError:
            if strict:
                raise
            continue
        seen.add(code.casefold())
        items.append({"code": code, "label": label,
                      "symbol": _clean_symbol(item.get("symbol"), LOT_SYMBOLS.get(code.casefold(), code[:3])),
                      "color": _clean_color(item.get("color"), DEFAULT_LOT_COLORS.get(code.casefold(), DEFAULT_LOT_COLOR)),
                      "day": day, "night": night, "sect_mode": sect_mode,
                      "enabled": _as_bool(item.get("enabled"))})
    if len(items) > MAX_ITEMS:
        raise ValueError(f"Lot 最多 {MAX_ITEMS} 个。")

    # 引用检查：@代码 必须指向列表里的 Lot，且不能循环引用。
    graph = {lot["code"].casefold(): _lot_refs(lot) for lot in items}
    names = {lot["code"].casefold(): lot["code"] for lot in items}
    for code, refs in graph.items():
        missing = refs - set(graph)
        if missing and strict:
            raise ValueError(f"「{names[code]}」引用了不存在的 Lot：{'、'.join('@' + m for m in sorted(missing))}")
    state = {}

    def visit(code, path):
        if state.get(code) == 2:
            return
        if state.get(code) == 1:
            raise ValueError("Lot 之间出现了循环引用：" + " → ".join("@" + names.get(c, c) for c in path + [code]))
        state[code] = 1
        for ref in graph.get(code, ()):
            if ref in graph:
                visit(ref, path + [code])
        state[code] = 2

    for code in graph:
        try:
            visit(code, [])
        except ValueError:
            if strict:
                raise
    return {"items": items}


def _normalize_specials(raw, strict):
    if not isinstance(raw, (list, tuple)):
        if strict:
            raise ValueError("specials 必须是代码列表。")
        return list(DEFAULT_SPECIALS)
    wanted = {str(code) for code in raw}
    unknown = wanted - set(SPECIAL_POINTS)
    if unknown and strict:
        raise ValueError(f"未知的特殊点：{'、'.join(sorted(unknown))}")
    return [code for code in SPECIAL_POINTS if code in wanted]


# ---------------------------------------------------------------- 配色与映点
#
# 星盘、相位表里每个符号的颜色都可以自定义。默认配色按深色背景设计：
# 莫兰迪色系（低饱和、带灰度），同时沿用占星传统的颜色对应——
#   星座按四元素：火象偏红橙、土象偏绿褐、风象偏黄、水象偏蓝紫；
#   行星按传统：太阳金、月亮银、水星灰绿、金星玫瑰、火星红、木星蓝、土星褐灰，
#   外行星：天王星青、海王星海蓝、冥王星暗酒红；罗睺计都灰紫。

COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")

DEFAULT_SIGN_COLORS = [
    "#d98274",  # 白羊 火
    "#9fb38a",  # 金牛 土
    "#d8c483",  # 双子 风
    "#9fb6cf",  # 巨蟹 水
    "#dfa06e",  # 狮子 火
    "#b5b07f",  # 处女 土
    "#c9c08f",  # 天秤 风
    "#8f9cc9",  # 天蝎 水
    "#c98f8a",  # 射手 火
    "#8fa596",  # 摩羯 土
    "#a9c4c0",  # 水瓶 风
    "#a6a3cf",  # 双鱼 水
]

DEFAULT_PLANET_COLORS = {
    "Su": "#e2b86a", "Mo": "#c9ced6", "Me": "#b4c48e", "Ve": "#d7a3a8", "Ma": "#d27f73",
    "Ju": "#8fa8d4", "Sa": "#ab9f8c", "Ur": "#8fc1c9", "Ne": "#8f9fd1", "Pl": "#b38a9a",
    "Ra": "#b9a6d1", "Ke": "#a99bb8",
}

DEFAULT_ASTEROID_COLORS = {1: "#c9b38a", 2: "#a9bfa3", 3: "#c9a3b8", 4: "#d9a383", 2060: "#a8b6c4", 433: "#d69aa6"}
DEFAULT_ASTEROID_COLOR = "#b7a8c9"
DEFAULT_STAR_COLOR = "#e6c46a"
DEFAULT_LOT_COLORS = {"fortune": "#e0c27a", "spirit": "#b9c6e0"}
DEFAULT_LOT_COLOR = "#e09ab3"
DEFAULT_SPECIAL_COLOR = "#d8b886"
DEFAULT_SPECIAL_STYLES = {code: {"symbol": sym, "color": DEFAULT_SPECIAL_COLOR} for code, sym in SPECIAL_SYMBOLS.items()}

# 映点（以巨蟹 0° / 摩羯 0° 为轴的镜像，黄经 = 180° − 原黄经）与反映点（以白羊 0° / 天秤 0° 为轴，黄经 = −原黄经）。
# 只对主行星（太阳到冥王星）计算；只有在「星体配置 → 行星」里启用的行星才有映点和反映点。
ANTISCIA_PLANETS = ("Su", "Mo", "Me", "Ve", "Ma", "Ju", "Sa", "Ur", "Ne", "Pl")
ANTISCIA_TYPES = {
    "antiscion": {"label": "映点", "prefix": "an", "mark": "′", "color": "#a8c4b8"},
    "contra": {"label": "反映点", "prefix": "ca", "mark": "″", "color": "#c4b0a0"},
}
DEFAULT_ANTISCIA = [
    {"planet": code, "type": kind, "enabled": True,
     "symbol": f"{PLANET_SYMBOLS[code]}{meta['mark']}", "color": meta["color"]}
    for kind, meta in ANTISCIA_TYPES.items() for code in ANTISCIA_PLANETS
]
# 星盘上逆行标志 R 的颜色（在「星体配置 → 行星」里修改）。
DEFAULT_RETRO_COLOR = "#e5776c"

DEFAULT_POINTS.update({
    "retro_color": DEFAULT_RETRO_COLOR,
    "antiscia": DEFAULT_ANTISCIA,
    "special_styles": DEFAULT_SPECIAL_STYLES,
    "planet_colors": DEFAULT_PLANET_COLORS,
    "sign_colors": DEFAULT_SIGN_COLORS,
})


def _clean_color(value, fallback):
    text = str(value or "").strip()
    return text.lower() if COLOR_RE.match(text) else fallback


def _normalize_sign_colors(raw, strict):
    if not isinstance(raw, (list, tuple)) or len(raw) != 12:
        if strict and raw is not None:
            raise ValueError("星座配色必须是 12 个颜色。")
        return list(DEFAULT_SIGN_COLORS)
    return [_clean_color(c, DEFAULT_SIGN_COLORS[i]) for i, c in enumerate(raw)]


def _normalize_planet_colors(raw, strict):
    raw = raw if isinstance(raw, Mapping) else {}
    return {code: _clean_color(raw.get(code), DEFAULT_PLANET_COLORS[code]) for code in MAIN_PLANET_ORDER}


def _normalize_retro_color(raw, strict):
    if raw is not None and strict and not COLOR_RE.match(str(raw).strip()):
        raise ValueError("逆行标志的颜色格式不对，应为 #rrggbb。")
    return _clean_color(raw, DEFAULT_RETRO_COLOR)


def _normalize_special_styles(raw, strict):
    raw = raw if isinstance(raw, Mapping) else {}
    result = {}
    for code, default in DEFAULT_SPECIAL_STYLES.items():
        item = raw.get(code) if isinstance(raw.get(code), Mapping) else {}
        result[code] = {
            "symbol": _clean_symbol(item.get("symbol"), default["symbol"]),
            "color": _clean_color(item.get("color"), default["color"]),
        }
    return result


def _normalize_antiscia(raw, strict):
    """映点 / 反映点：固定 20 项（10 颗行星 × 2 种），保留每项的勾选、符号和颜色。"""
    given = {}
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, Mapping):
                given[(str(item.get("planet")), str(item.get("type")))] = item
    elif raw is not None and strict:
        raise ValueError("映点设置格式不对。")
    result = []
    for default in DEFAULT_ANTISCIA:
        item = given.get((default["planet"], default["type"]), {})
        result.append({
            "planet": default["planet"],
            "type": default["type"],
            "enabled": _as_bool(item.get("enabled"), default["enabled"]),
            "symbol": _clean_symbol(item.get("symbol"), default["symbol"]),
            "color": _clean_color(item.get("color"), default["color"]),
        })
    return result


_POINT_SECTIONS = {
    "planets": _normalize_planets,
    "asteroids": _normalize_asteroids,
    "stars": _normalize_stars,
    "lots": _normalize_lots,
    "specials": _normalize_specials,
    "antiscia": _normalize_antiscia,
    "special_styles": _normalize_special_styles,
    "planet_colors": _normalize_planet_colors,
    "retro_color": _normalize_retro_color,
    "sign_colors": _normalize_sign_colors,
}


def normalize_points(raw, *, strict=False):
    """整理 points 配置。strict=True（网页保存时）遇到不合法的内容直接报错；
    strict=False（读 settings.json、排盘时）跳过不合法的条目，缺的部分用默认值补上。"""
    raw = raw if isinstance(raw, Mapping) else {}
    result = {}
    for key, normalize in _POINT_SECTIONS.items():
        if key in raw:
            result[key] = normalize(raw[key], strict)
        else:
            result[key] = normalize(json.loads(json.dumps(DEFAULT_POINTS[key])), False)
    return result


# ---------------------------------------------------------------- 相位设置
#
# 主相位表（矩阵）：在「星体配置」里启用的行星、小行星（集合 A），再加上四轴，两两之间算相位。
#   selection.excluded 记的是“排除了哪些”：在集合 A 里新启用的点默认参与相位。
#   四轴不在集合 A 里，selection.axes 记的是“选了哪些”。
# 其它点相位（表格）：特殊点、恒星、Lot、映点四组，每一组的元素各自与主相位表里的行星算相位。
# 每一组可以各自选用哪些相位类型（types[].groups）。

AXIS_ORDER = ("Asc", "MC", "Desc", "IC")
AXIS_LABELS = {"Asc": "上升", "MC": "中天", "Desc": "下降", "IC": "天底"}
AXIS_SYMBOLS = {"Asc": "Asc", "MC": "Mc", "Desc": "Dsc", "IC": "Ic"}

# 永远构成同一相位的点对：默认跳过（selection.skip_fixed）。
# 四轴（宫头）之间的相位一律不算，不受这个开关影响（见 _skip_main_pair）。
FIXED_PAIRS = {frozenset(("Ra", "Ke"))}

ASPECT_GROUPS = {
    "main": "主相位表",
    "specials": "特殊点",
    "stars": "恒星",
    "lots": "Lot",
    "antiscia": "映点与反映点",
}
_ALL_GROUPS = list(ASPECT_GROUPS)
_CONJ_OPP_GROUPS = ["main", "specials", "lots"]

BUILTIN_ASPECTS = [
    {"id": "conjunction", "name": "合相", "angle": 0, "symbol": "☌", "groups": _ALL_GROUPS},
    {"id": "sextile", "name": "六分", "angle": 60, "symbol": "⚹", "groups": _CONJ_OPP_GROUPS},
    {"id": "square", "name": "四分", "angle": 90, "symbol": "□", "groups": _CONJ_OPP_GROUPS},
    {"id": "trine", "name": "三分", "angle": 120, "symbol": "△", "groups": _CONJ_OPP_GROUPS},
    {"id": "opposition", "name": "对冲", "angle": 180, "symbol": "☍", "groups": _ALL_GROUPS},
]
_BUILTIN_IDS = [t["id"] for t in BUILTIN_ASPECTS]

# 容许度（度）。行星的数值是传统的“整圈容许度”，配合默认的古典半径法（两者各取一半相加）使用。
DEFAULT_ORBS = {
    "rule": "moiety",
    "planets": {"Su": 15, "Mo": 12, "Me": 7, "Ve": 7, "Ma": 8, "Ju": 9, "Sa": 9, "Ur": 5, "Ne": 5, "Pl": 5},
    "nodes": 3,
    "asteroids": {},          # MPC 编号 → 容许度；没写的用 asteroid_default
    "asteroid_default": 3,
    "axes": 5,
    "specials": 3,
    "stars": 1.5,
    "lots": 3,
    "antiscia": 2,
    # 勾选的组只用自己的容许度，不与行星的容许度合成（恒星、映点传统上只看很紧的容许度）。
    "exclusive": {"specials": False, "stars": True, "lots": False, "antiscia": True},
}
_SINGLE_ORB_KEYS = ("nodes", "asteroid_default", "axes", "specials", "stars", "lots", "antiscia")
_EXCLUSIVE_KEYS = ("specials", "stars", "lots", "antiscia")
ORB_PLANETS = ("Su", "Mo", "Me", "Ve", "Ma", "Ju", "Sa", "Ur", "Ne", "Pl")
MAX_ORB = 30.0

DEFAULT_ASPECTS = {
    "selection": {
        # 默认只选主行星、罗睺计都、上升和中天；默认的几颗小行星先排除，用户自己打开。
        "excluded": [f"#{a['number']}" for a in DEFAULT_ASTEROIDS],
        "axes": ["Asc", "MC"],
        "skip_fixed": True,
    },
    "orbs": DEFAULT_ORBS,
    "types": BUILTIN_ASPECTS,
    "cross_sign": True,       # False：不认跨星座的相位
}

_ASPECT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,24}$")
_POINT_ID_RE = re.compile(r"^(?:Su|Mo|Me|Ve|Ma|Ju|Sa|Ur|Ne|Pl|Ra|Ke|#\d{1,7})$")


def _copy(value):
    return json.loads(json.dumps(value))


def _orb_value(value, name, strict, default):
    try:
        number = float(value)
        if not 0 <= number <= MAX_ORB:
            raise ValueError
        return round(number, 4)
    except (TypeError, ValueError):
        if strict:
            raise ValueError(f"{name}的容许度必须是 0–{MAX_ORB:g} 之间的数字。") from None
        return default


def _normalize_selection(raw, strict):
    raw = raw if isinstance(raw, Mapping) else {}
    default = DEFAULT_ASPECTS["selection"]
    excluded = []
    for item in raw.get("excluded", default["excluded"]) or []:
        item = str(item)
        if not _POINT_ID_RE.match(item):
            if strict:
                raise ValueError(f"相位选点里有不认识的点：{item}")
            continue
        if item not in excluded:
            excluded.append(item)
    axes_raw = raw.get("axes", default["axes"])
    axes_raw = axes_raw if isinstance(axes_raw, (list, tuple)) else default["axes"]
    unknown = set(map(str, axes_raw)) - set(AXIS_ORDER)
    if unknown and strict:
        raise ValueError(f"未知的四轴：{'、'.join(sorted(unknown))}")
    return {
        "excluded": excluded,
        "axes": [a for a in AXIS_ORDER if a in set(map(str, axes_raw))],
        "skip_fixed": _as_bool(raw.get("skip_fixed"), True),
    }


def _normalize_orbs(raw, strict):
    raw = raw if isinstance(raw, Mapping) else {}
    result = _copy(DEFAULT_ORBS)
    rule = str(raw.get("rule") or "moiety")
    if rule not in ORB_RULES:
        if strict:
            raise ValueError("容许度合成规则只能是 moiety、max 或 min。")
        rule = "moiety"
    result["rule"] = rule
    planets = raw.get("planets") if isinstance(raw.get("planets"), Mapping) else {}
    for code in ORB_PLANETS:
        if code in planets:
            result["planets"][code] = _orb_value(planets[code], PLANET_LABELS[code], strict, DEFAULT_ORBS["planets"][code])
    labels = {"nodes": "罗睺计都", "asteroid_default": "新增小行星", "axes": "四轴", "specials": "特殊点",
              "stars": "恒星", "lots": "Lot", "antiscia": "映点与反映点"}
    for key in _SINGLE_ORB_KEYS:
        if key in raw:
            result[key] = _orb_value(raw[key], labels[key], strict, DEFAULT_ORBS[key])
    asteroids = raw.get("asteroids") if isinstance(raw.get("asteroids"), Mapping) else {}
    result["asteroids"] = {}
    for number, value in asteroids.items():
        if not str(number).isdigit():
            if strict:
                raise ValueError(f"小行星编号不合法：{number}")
            continue
        result["asteroids"][str(int(number))] = _orb_value(value, f"小行星 #{number} ", strict, result["asteroid_default"])
    exclusive = raw.get("exclusive") if isinstance(raw.get("exclusive"), Mapping) else {}
    for key in _EXCLUSIVE_KEYS:
        if key in exclusive:
            result["exclusive"][key] = _as_bool(exclusive[key], DEFAULT_ORBS["exclusive"][key])
    return result


def _normalize_types(raw, strict):
    if not isinstance(raw, list):
        if strict:
            raise ValueError("相位类型必须是列表。")
        return _copy(BUILTIN_ASPECTS)
    builtin = {t["id"]: t for t in BUILTIN_ASPECTS}
    result, seen_ids, seen_angles = [], set(), {}
    for item in raw:
        try:
            if not isinstance(item, Mapping):
                raise ValueError(f"相位类型格式不对：{item!r}")
            aid = str(item.get("id") or "").strip()
            if not _ASPECT_ID_RE.match(aid):
                raise ValueError(f"相位类型的 id 不合法：{aid!r}")
            if aid in seen_ids:
                raise ValueError(f"相位类型 {aid} 重复了。")
            base = builtin.get(aid)
            name = _clean_label(item.get("name"), base["name"] if base else "")[:12]
            if not name:
                raise ValueError("相位名称不能为空。")
            if base:
                angle = float(base["angle"])          # 五大相位的角度固定
            else:
                try:
                    angle = round(float(item.get("angle")), 4)
                except (TypeError, ValueError):
                    raise ValueError(f"「{name}」的角度必须是数字。") from None
                if not 0 <= angle <= 180:
                    raise ValueError(f"「{name}」的角度必须在 0–180° 之间（两点之间的角距最大就是 180°）。")
            key = round(angle, 4)
            if key in seen_angles:
                raise ValueError(f"「{name}」和「{seen_angles[key]}」的角度相同（{angle:g}°）。")
            symbol = "".join(str(item.get("symbol") or "").split())[:MAX_SYMBOL_LEN]
            if not symbol:
                if base:
                    symbol = base["symbol"]
                else:
                    raise ValueError(f"「{name}」的符号不能为空（可以填文字，例如 Q）。")
            groups_raw = item.get("groups")
            groups_raw = groups_raw if isinstance(groups_raw, (list, tuple)) else (base["groups"] if base else ["main"])
            groups = [g for g in ASPECT_GROUPS if g in set(map(str, groups_raw))]
        except ValueError:
            if strict:
                raise
            continue
        seen_ids.add(aid)
        seen_angles[key] = name
        result.append({"id": aid, "name": name, "angle": angle if not angle.is_integer() else int(angle),
                       "symbol": symbol, "groups": groups, "builtin": bool(base)})
    # 五大相位不能删除，只能在各组里取消勾选。
    for aid in _BUILTIN_IDS:
        if aid not in seen_ids:
            if strict:
                raise ValueError(f"五大相位「{builtin[aid]['name']}」不能删除，可以取消勾选来停用。")
            result.append({**_copy(builtin[aid]), "builtin": True})
    if len(result) > 40:
        raise ValueError("相位类型最多 40 种。")
    result.sort(key=lambda t: float(t["angle"]))
    return result


_ASPECT_SECTIONS = {
    "selection": _normalize_selection,
    "orbs": _normalize_orbs,
    "types": _normalize_types,
    "cross_sign": lambda raw, strict: _as_bool(raw, True),
}


def normalize_aspects(raw, *, strict=False):
    raw = raw if isinstance(raw, Mapping) else {}
    return {key: normalize(raw[key] if key in raw else _copy(DEFAULT_ASPECTS[key]), strict)
            for key, normalize in _ASPECT_SECTIONS.items()}


# ---------------------------------------------------------------- 古典占星设置
#
# settings.json → systems.western.classical：
#   scores             先天尊贵各项分值（默认按 Lilly：+5 +4 +3 +2 +1 −5 −4 −5）
#   triplicity_system  三分主星体系：dorothean 多罗修斯 / ptolemaic 托勒密 / lilly
#   triplicity_mode    三分怎么计分：sect 只算当令的 / both 日夜都算 / all 连共管也算
#   term_system        界：egyptian 埃及界 / ptolemaic 托勒密界
#   sect               得时：day_rule 怎么判断日生夜生；planets 每颗行星属于哪一派
#   speed              速度：preset 平均速度取哪一套；compare 按大小还是带正负号比较；custom 自定义平均速度
#   sun                太阳光束：日核、焦伤、光束下的距离（度）

DIGNITY_SCORE_KEYS = ("domicile", "exaltation", "triplicity", "term", "face", "detriment", "fall", "peregrine")
DIGNITY_LABELS = {"domicile": "入庙", "exaltation": "擢升", "triplicity": "三分", "term": "界", "face": "面",
                  "detriment": "失势", "fall": "入弱", "peregrine": "外来"}
TRIPLICITY_SYSTEMS = {"dorothean": "多罗修斯", "ptolemaic": "托勒密", "lilly": "Lilly"}
TRIPLICITY_MODES = {"sect": "只算当令主星", "both": "日夜主星都算", "all": "日、夜、共管都算"}
TERM_SYSTEMS = {"egyptian": "埃及界", "ptolemaic": "托勒密界"}
DAY_RULES = {"geometric": "太阳中心几何高度 > 0°", "apparent": "太阳中心视高度 > 0°（计入大气折射）"}
SECT_RULES = {"diurnal": "日间派", "nocturnal": "夜间派", "none": "不参与"}
SECT_RULES_MERCURY = {"oriental": "东出为日间、西入为夜间", "chart": "随盘（日生日间、夜生夜间）",
                      **SECT_RULES}
SPEED_PRESETS = {"astronomical": "平均黄经运动", "traditional": "传统平均日行（Lilly）",
                 "empirical": "实际日行绝对值的平均（1900–2100）", "custom": "自定义"}
SPEED_COMPARE = {"abs": "按速度大小比较", "signed": "按带正负号的速度比较（逆行一律算慢）"}

DEFAULT_CLASSICAL = {
    "scores": {"domicile": 5, "exaltation": 4, "triplicity": 3, "term": 2, "face": 1,
               "detriment": -5, "fall": -4, "peregrine": -5},
    "triplicity_system": "dorothean",
    "triplicity_mode": "sect",
    "term_system": "egyptian",
    "sect": {
        "day_rule": "geometric",
        "planets": {"Su": "diurnal", "Mo": "nocturnal", "Me": "oriental", "Ve": "nocturnal", "Ma": "nocturnal",
                    "Ju": "diurnal", "Sa": "diurnal", "Ur": "none", "Ne": "none", "Pl": "none"},
    },
    "speed": {"preset": "astronomical", "compare": "abs", "custom": {}},
    # 太阳光束：若干档，名称和度数都可以自定义（按度数从小到大判断，取最先满足的一档）。
    "sun": {"phases": [
        {"label": "日核", "orb": round(17 / 60, 6)},
        {"label": "焦伤", "orb": 8.5},
        {"label": "光束下", "orb": 17.0},
    ]},
}

SPEED_PLANETS = ("Su", "Mo", "Me", "Ve", "Ma", "Ju", "Sa", "Ur", "Ne", "Pl", "Ra", "Ke")


def _choice(value, choices, default, what, strict):
    value = str(value or default)
    if value not in choices:
        if strict:
            raise ValueError(f"{what}只能是：{'、'.join(choices)}。")
        return default
    return value


def _number(value, default, lo, hi, what, strict):
    try:
        number = float(value)
        if not lo <= number <= hi:
            raise ValueError
    except (TypeError, ValueError):
        if strict:
            raise ValueError(f"{what}必须是 {lo:g} 到 {hi:g} 之间的数字。") from None
        if default is None:
            return None
        number = float(default)
    return int(number) if number.is_integer() else round(number, 6)


MAX_SUN_PHASES = 6
MAX_SUN_LABEL = 8


def _clean_sun_phases(raw, default, strict):
    """太阳光束的各档：[{"label", "orb"}]，名称不能为空、不能重复，度数 0–40，最多 6 档，按度数从小到大排列。"""
    if not isinstance(raw, list):
        if strict and raw is not None:
            raise ValueError("太阳光束的设置格式不对。")
        return [dict(p) for p in default]
    phases, seen = [], set()
    for item in raw:
        if not isinstance(item, Mapping):
            if strict:
                raise ValueError("太阳光束的设置格式不对。")
            continue
        label = " ".join(str(item.get("label") or "").split())
        if not label or len(label) > MAX_SUN_LABEL:
            if strict:
                raise ValueError(f"太阳光束每一档都要有名称，最多 {MAX_SUN_LABEL} 个字。")
            continue
        if label in seen:
            if strict:
                raise ValueError(f"太阳光束里有两档都叫「{label}」。")
            continue
        orb = _number(item.get("orb"), None, 0, 40, f"「{label}」的度数", strict)
        if orb is None:
            continue
        seen.add(label)
        phases.append({"label": label, "orb": orb})
    if len(phases) > MAX_SUN_PHASES:
        if strict:
            raise ValueError(f"太阳光束最多 {MAX_SUN_PHASES} 档。")
        phases = phases[:MAX_SUN_PHASES]
    phases.sort(key=lambda p: p["orb"])
    return phases


def normalize_classical(raw, *, strict=False):
    raw = raw if isinstance(raw, Mapping) else {}
    d = DEFAULT_CLASSICAL
    scores_raw = raw.get("scores") if isinstance(raw.get("scores"), Mapping) else {}
    scores = {k: _number(scores_raw.get(k, d["scores"][k]), d["scores"][k], -100, 100,
                         f"「{DIGNITY_LABELS[k]}」的分值", strict) for k in DIGNITY_SCORE_KEYS}

    sect_raw = raw.get("sect") if isinstance(raw.get("sect"), Mapping) else {}
    rules_raw = sect_raw.get("planets") if isinstance(sect_raw.get("planets"), Mapping) else {}
    rules = {}
    for code, default in d["sect"]["planets"].items():
        choices = SECT_RULES_MERCURY if code == "Me" else SECT_RULES
        rules[code] = _choice(rules_raw.get(code, default), choices, default, f"{code} 的派别", strict)

    speed_raw = raw.get("speed") if isinstance(raw.get("speed"), Mapping) else {}
    custom_raw = speed_raw.get("custom") if isinstance(speed_raw.get("custom"), Mapping) else {}
    custom = {}
    for code in SPEED_PLANETS:
        if custom_raw.get(code) not in (None, ""):
            custom[code] = _number(custom_raw[code], 0, 0.000001, 20, f"{code} 的平均速度", strict)
            if not custom[code]:
                custom.pop(code)

    sun = {"phases": _clean_sun_phases((raw.get("sun") or {}).get("phases") if isinstance(raw.get("sun"), Mapping)
                                        else None, d["sun"]["phases"], strict)}

    return {
        "scores": scores,
        "triplicity_system": _choice(raw.get("triplicity_system"), TRIPLICITY_SYSTEMS, "dorothean", "三分主星体系", strict),
        "triplicity_mode": _choice(raw.get("triplicity_mode"), TRIPLICITY_MODES, "sect", "三分计分方式", strict),
        "term_system": _choice(raw.get("term_system"), TERM_SYSTEMS, "egyptian", "界", strict),
        "sect": {
            "day_rule": _choice(sect_raw.get("day_rule"), DAY_RULES, "geometric", "日夜判断", strict),
            "planets": rules,
        },
        "speed": {
            "preset": _choice(speed_raw.get("preset"), SPEED_PRESETS, "astronomical", "平均速度", strict),
            "compare": _choice(speed_raw.get("compare"), SPEED_COMPARE, "abs", "比较方式", strict),
            "custom": custom,
        },
        "sun": sun,
    }


# ---------------------------------------------------------------- 本体系在 settings.json 里的设置
#
# 位置：settings.json → systems.western。共用的设置（外观、会话、默认地点等）不在这里。

SYSTEM_ID = "western"

DEFAULT_SYSTEM_SETTINGS = {
    "calculation_defaults": {
        # 页面打开时的默认选项；在网页上改了会自动记住。回归黄道 / 恒星黄道都完整支持。
        "ecliptic_mode": "tropical",
        "ayanamsha_mode": "SIDM_LAHIRI",
        "node_mode": "mean",
        "house_system": "Placidus",
        "sunrise_rsmi": int(swe.BIT_DISC_CENTER),
    },
    # 行星、小行星、恒星、Lot、特殊点、映点、配色：在网页上修改后自动写回。
    "points": DEFAULT_POINTS,
    # 相位：参与的点、容许度、相位类型。
    "aspects": DEFAULT_ASPECTS,
    # 古典占星：先天尊贵、得时、速度、太阳光束。
    "classical": DEFAULT_CLASSICAL,
}


def normalize_system_settings(section):
    section = dict(section)
    section["points"] = normalize_points(section.get("points"))
    section["aspects"] = normalize_aspects(section.get("aspects"))
    # 上一版叫 dignity，只有分值和三分设置：沿用它的内容。
    old = section.pop("dignity", None)
    raw = section.get("classical")
    if isinstance(old, Mapping) and not (isinstance(raw, Mapping) and raw != DEFAULT_CLASSICAL):
        raw = {**DEFAULT_CLASSICAL, **{k: v for k, v in old.items() if k in ("scores", "triplicity_system", "triplicity_mode")}}
        if raw.get("triplicity_system") == "ptolemaic":
            raw["triplicity_system"] = "lilly"         # 上一版的「托勒密」其实是 Lilly 的分配（水象日夜都是火星）
    section["classical"] = normalize_classical(raw)
    return section


def _keys(name):
    return ("systems", SYSTEM_ID, name)


def save_points(store, updates):
    """网页上修改了某几类点：校验后写回，返回整理后的完整配置。"""
    updates = dict(updates or {})
    unknown = set(updates) - set(_POINT_SECTIONS)
    if unknown:
        raise ValueError(f"未知的设置：{'、'.join(sorted(unknown))}")
    merged = {**store.system(SYSTEM_ID).get("points", {}), **updates}
    clean = normalize_points(merged, strict=True)
    return store.write(_keys("points"), clean, merge=False)


def save_aspects(store, updates):
    updates = dict(updates or {})
    unknown = set(updates) - set(_ASPECT_SECTIONS)
    if unknown:
        raise ValueError(f"未知的设置：{'、'.join(sorted(unknown))}")
    merged = {**store.system(SYSTEM_ID).get("aspects", {}), **updates}
    clean = normalize_aspects(merged, strict=True)
    return store.write(_keys("aspects"), clean, merge=False)


def save_classical(store, updates):
    merged = {**store.system(SYSTEM_ID).get("classical", {}), **dict(updates or {})}
    return store.write(_keys("classical"), normalize_classical(merged, strict=True), merge=False)


def save_calc_defaults(store, updates):
    """计算设置（黄道、岁差、宫位制、月交点）一改就写回，下次打开沿用。"""
    return dict(store.write(_keys("calculation_defaults"), clean_basic_calc(updates)))


def _required(payload, key):
    value = payload.get(key)
    if value is None or value == "":
        raise ValueError(f"缺少必要参数：{key}")
    return value


def _format_point_map(items):
    """原样输出十进制的黄经等数值（不再附加度分秒字符串）。"""
    return {key: dict(value) for key, value in items.items()}


def planet_options():
    return [{"value": code, "label": PLANET_LABELS[code]} for code in MAIN_PLANET_ORDER if code in PLANET_LABELS]


def _opts(mapping):
    return [{"value": k, "label": v} for k, v in mapping.items()]


def public_options():
    return {
        "house_systems": house_system_options(),
        "ayanamsha_modes": ayanamsha_options(),
        "planets": planet_options(),
        "ecliptic_modes": ["tropical", "sidereal"],
        "node_modes": ["mean", "true"],
        "special_points": [
            {"value": code, "label": label, "description": desc}
            for code, (label, desc) in SPECIAL_POINTS.items()
        ],
        "default_points": normalize_points({}),
        "planet_symbols": PLANET_SYMBOLS,
        "special_symbols": SPECIAL_SYMBOLS,
        "axes": [{"value": a, "label": AXIS_LABELS[a], "symbol": AXIS_SYMBOLS[a]} for a in AXIS_ORDER],
        "aspect_groups": [{"value": k, "label": v} for k, v in ASPECT_GROUPS.items()],
        "orb_rules": [{"value": k, "label": v} for k, v in ORB_RULES.items()],
        "orb_planets": list(ORB_PLANETS),
        "default_aspects": DEFAULT_ASPECTS,
        "default_classical": DEFAULT_CLASSICAL,
        "classical_options": {
            "scores": _opts({k: DIGNITY_LABELS[k] for k in DIGNITY_SCORE_KEYS}),
            "triplicity_systems": _opts(TRIPLICITY_SYSTEMS),
            "triplicity_modes": _opts(TRIPLICITY_MODES),
            "term_systems": _opts(TERM_SYSTEMS),
            "day_rules": _opts(DAY_RULES),
            "sect_rules": _opts(SECT_RULES),
            "sect_rules_mercury": _opts(SECT_RULES_MERCURY),
            "speed_presets": _opts(SPEED_PRESETS),
            "speed_compare": _opts(SPEED_COMPARE),
            "speed_planets": list(SPEED_PLANETS),
            "mean_speeds": {
                "astronomical_tropical": {c: astronomical_mean(c, sidereal=False) for c in SPEED_PLANETS},
                "astronomical_sidereal": {c: astronomical_mean(c, sidereal=True) for c in SPEED_PLANETS},
                "traditional": TRADITIONAL_MEAN,
                "empirical": {**EMPIRICAL_MEAN, "Ra": EMPIRICAL_NODE["mean"], "Ke": EMPIRICAL_NODE["mean"]},
            },
        },
    }


def _normalize_input(payload):
    birth = dict(payload.get("birth") or {})
    options = dict(payload.get("options") or {})

    ecliptic_mode = str(options.get("ecliptic_mode", "")).strip().lower()
    if ecliptic_mode not in ("tropical", "sidereal"):
        # 不替用户默认任何一种黄道：没说清楚就直接报错。
        raise ValueError("ecliptic_mode 必须是 tropical（回归黄道）或 sidereal（恒星黄道）。")

    result = {
        "birth": {
            "local_time_str": str(_required(birth, "local_time_str")),
            "timezone_str": str(_required(birth, "timezone_str")),
            "latitude_str": birth.get("latitude_str", birth.get("latitude")),
            "longitude_str": birth.get("longitude_str", birth.get("longitude")),
            "calendar": str(birth.get("calendar", "g")),
        },
        "options": {
            "ecliptic_mode": ecliptic_mode,
            "ayanamsha_mode": options.get("ayanamsha_mode", "SIDM_KRISHNAMURTI"),
            "node_mode": str(options.get("node_mode", "mean")),
            "house_system": str(options.get("house_system", "Regiomontanus")),
            "sunrise_rsmi": int(options.get("sunrise_rsmi", swe.BIT_DISC_CENTER)),
            "points": normalize_points(options.get("points")),
            "aspects": normalize_aspects(options.get("aspects")),
            "classical": normalize_classical(options.get("classical")),
        },
    }

    if result["birth"]["latitude_str"] in (None, ""):
        raise ValueError("缺少必要参数：latitude")
    if result["birth"]["longitude_str"] in (None, ""):
        raise ValueError("缺少必要参数：longitude")

    return result


def _calculate_context(normalized):
    return parse_time_geo(**normalized["birth"])


def _calculate_planets(context, options, codes=None):
    return calculate_planets(
        context,
        options["points"]["planets"] if codes is None else codes,
        ecliptic_mode=options["ecliptic_mode"],
        ayanamsha_mode=options["ayanamsha_mode"],
        node_mode=options["node_mode"],
    )


def _format_house_result(house_result):
    """宫头、四轴（Asc / Desc / MC / IC）和 Vertex 等附加点。

    四轴在任何宫位制下都直接取自 Swiss Ephemeris 的 ascmc，页面暂不单独展示，
    但星盘的上升点、Lot 公式里的 Asc / MC / Desc / IC 都依赖它们。
    """
    return {
        **house_result,
        "houses": _format_point_map(house_result["houses"]),
        "axes": _format_point_map(house_result["axes"]),
        "extra": _format_point_map(house_result.get("extra") or {}),
    }


def _calculate_house_group(context, options):
    return calculate_houses(
        context,
        options["house_system"],
        ecliptic_mode=options["ecliptic_mode"],
        ayanamsha_mode=options["ayanamsha_mode"],
    )


def _calculate_sun_group(context, options):
    sun_events = calculate_sunrise_sunset(
        context,
        rsmi=options["sunrise_rsmi"],
    )
    day_lord_result = calculate_day_lord(
        context,
        sun_events=sun_events,
    )
    planetary_hour_data = calculate_planetary_hour(
        context,
        rsmi=options["sunrise_rsmi"],
    )
    return sun_events, day_lord_result, planetary_hour_data


class PointResolver:
    """给 Lot 公式取各个点的 (黄经, 速度)。公式里引用到的点即使没有勾选，也会单独算出来（结果缓存）。"""

    def __init__(self, context, options, planet_pos, house_result):
        self.context = context
        self.options = options
        self.planet_pos = dict(planet_pos)
        self.house_result = house_result
        self.lots = {lot["code"].casefold(): lot for lot in options["points"]["lots"]["items"]}
        self.cache = {}
        self.stack = []
        self._is_day = None

    @property
    def is_day(self):
        if self._is_day is None:
            self._is_day = sun_above_horizon(self.context, self.options["classical"]["sect"]["day_rule"])
        return self._is_day

    def _mode(self):
        return {"ecliptic_mode": self.options["ecliptic_mode"], "ayanamsha_mode": self.options["ayanamsha_mode"]}

    def __call__(self, kind, value):
        key = (kind, str(value).casefold())
        if key not in self.cache:
            self.cache[key] = self._resolve(kind, value)
        return self.cache[key]

    def _resolve(self, kind, value):
        point = self._point(kind, value)
        return float(point["lon"]), float(point.get("speed") or 0.0)

    def _point(self, kind, value):
        if kind == "planet":
            if value not in self.planet_pos:
                self.planet_pos.update(_calculate_planets(self.context, self.options, [value]))
            return self.planet_pos[value]
        if kind == "axis":
            return self.house_result["axes"][value]
        if kind == "cusp":
            return self.house_result["houses"][f"house {str(value)[1:]}"]
        if kind == "special":
            return special_point(self.context, value, house_result=self.house_result, **self._mode())
        if kind == "asteroid":
            found, errors = calculate_asteroids(self.context, [{"number": value}], **self._mode())
            if errors:
                raise ValueError(errors[0]["error"])
            return next(iter(found.values()))
        if kind == "star":
            found, errors = calculate_fixed_stars(self.context, [{"query": value}], **self._mode())
            if errors:
                raise ValueError(errors[0]["error"])
            return next(iter(found.values()))
        if kind == "lot":
            return self.lot(value)
        raise ValueError(f"未知的引用：{kind} {value}")

    def lot(self, code):
        lot = self.lots.get(str(code).casefold())
        if lot is None:
            raise ValueError(f"没有代码为 @{code} 的 Lot。")
        if lot["code"].casefold() in self.stack:
            raise ValueError("Lot 之间出现了循环引用：" + " → ".join("@" + c for c in self.stack + [lot["code"]]))
        # 只有这个 Lot 按日夜自动选公式、且确实分日夜公式时，才需要算太阳高度。
        formula, used = choose_formula(lot, is_day=self.is_day if needs_sect(lot) else None)
        self.stack.append(lot["code"].casefold())
        try:
            lon, speed = evaluate(parse_formula(formula), self)
        finally:
            self.stack.pop()
        return {"lon": lon, "speed": speed, "formula": formula, "sect": used, "code": lot["code"]}


_SECT_LABELS = {"day": "日间公式", "night": "夜间公式", "single": "不分日夜"}


def _calculate_lots(resolver, lots_config):
    results, errors = {}, []
    for lot in lots_config["items"]:
        if not lot["enabled"]:
            continue
        try:
            data = resolver.lot(lot["code"])
        except (ValueError, KeyError, FileNotFoundError, RuntimeError, swe.Error) as exc:
            errors.append({"label": lot["label"], "error": str(exc)})
            continue
        results[lot["label"]] = {
            "lon": data["lon"],
            "speed": data["speed"],
            "formula": data["formula"],
            "sect": _SECT_LABELS[data["sect"]],
        }
    return results, errors


def _calculate_extra_points(context, options, planet_pos, house_result):
    """小行星、恒星、特殊点、Lot。某一类一个都没勾选时，结果里就没有这一类。"""
    points = options["points"]
    mode = {"ecliptic_mode": options["ecliptic_mode"], "ayanamsha_mode": options["ayanamsha_mode"]}
    output, errors = {}, {}

    asteroids = [a for a in points["asteroids"] if a["enabled"]]
    if asteroids:
        output["asteroids"], errors["asteroids"] = calculate_asteroids(context, asteroids, **mode)

    stars = [s for s in points["stars"] if s["enabled"]]
    if stars:
        output["fixed_stars"], errors["fixed_stars"] = calculate_fixed_stars(context, stars, **mode)

    if points["specials"]:
        output["special_points"], errors["special_points"] = calculate_special_points(
            context, points["specials"], house_result=house_result, **mode
        )

    if any(lot["enabled"] for lot in points["lots"]["items"]):
        resolver = PointResolver(context, options, planet_pos, house_result)
        output["lots"], errors["lots"] = _calculate_lots(resolver, points["lots"])
        output["sect"] = {"is_day": resolver._is_day}      # 只有真的用到日夜判断时才有值

    antiscia = _calculate_antiscia(points, planet_pos)
    if antiscia:
        output["antiscia"] = antiscia

    output["point_errors"] = {k: v for k, v in errors.items() if v}
    return output


# ---------------------------------------------------------------- 相位计算

def _aspect_types(cfg, group):
    return [AspectType(t["id"], t["name"], float(t["angle"]), t["symbol"])
            for t in cfg["types"] if group in t["groups"]]


def _planet_orb(code, orbs):
    return float(orbs["nodes"] if code in ("Ra", "Ke") else orbs["planets"][code])


AXIS_COLOR = "#d6cbbd"


def _main_aspect_points(options, planet_pos, house_result, extra):
    """主相位表的点：(集合 A ∩ 相位选择) + 选中的四轴，按 行星 → 小行星 → 四轴 的顺序。"""
    cfg = options["aspects"]
    orbs = cfg["orbs"]
    pts = options["points"]
    excluded = set(cfg["selection"]["excluded"])
    points, info = [], []

    for code in pts["planets"]:
        if code in excluded or code not in planet_pos:
            continue
        p = planet_pos[code]
        points.append(AspectPoint(code, p["lon"], p.get("speed", 0.0), _planet_orb(code, orbs)))
        info.append({"id": code, "label": PLANET_LABELS[code], "symbol": PLANET_SYMBOLS[code],
                     "color": pts["planet_colors"][code], "kind": "planet"})

    computed = {v.get("number"): v for v in (extra.get("asteroids") or {}).values()}
    for a in pts["asteroids"]:
        pid = f"#{a['number']}"
        if not a["enabled"] or pid in excluded or a["number"] not in computed:
            continue
        p = computed[a["number"]]
        orb = float(orbs["asteroids"].get(str(a["number"]), orbs["asteroid_default"]))
        points.append(AspectPoint(pid, p["lon"], p.get("speed", 0.0), orb))
        info.append({"id": pid, "label": a["label"], "symbol": a["symbol"], "color": a["color"], "kind": "asteroid"})

    for axis in cfg["selection"]["axes"]:
        p = house_result["axes"][axis]
        points.append(AspectPoint(axis, p["lon"], p.get("speed", 0.0), float(orbs["axes"])))
        info.append({"id": axis, "label": AXIS_LABELS[axis], "symbol": AXIS_SYMBOLS[axis], "color": AXIS_COLOR, "kind": "axis"})
    return points, info


def _calculate_antiscia(points, planet_pos):
    """映点 / 反映点：只对在「星体配置」里启用、并且勾选了的行星。返回 {名称: 数据}。"""
    result = {}
    for item in points["antiscia"]:
        code = item["planet"]
        if not item["enabled"] or code not in planet_pos:
            continue
        p = planet_pos[code]
        meta = ANTISCIA_TYPES[item["type"]]
        lon = (180.0 - p["lon"]) % 360.0 if item["type"] == "antiscion" else (360.0 - p["lon"]) % 360.0
        result[f"{PLANET_LABELS[code]}{meta['label']}"] = {
            "lon": lon,
            "speed": -float(p.get("speed", 0.0)),
            "planet": code,
            "type": item["type"],
            "id": f"{meta['prefix']}:{code}",
            "symbol": item["symbol"],
            "color": item["color"],
        }
    return result


def _calculate_aspects(options, planet_pos, house_result, extra):
    cfg = options["aspects"]
    orbs = cfg["orbs"]
    rule = orbs["rule"]
    cross_sign = cfg["cross_sign"]
    pts = options["points"]

    main_points, main_info = _main_aspect_points(options, planet_pos, house_result, extra)
    skip_fixed = cfg["selection"]["skip_fixed"]

    def _skip_main_pair(a, b):
        if a.id in AXIS_LABELS and b.id in AXIS_LABELS:
            return True                    # 宫头与宫头之间不算相位
        return skip_fixed and frozenset((a.id, b.id)) in FIXED_PAIRS

    main_aspects = find_aspects(
        main_points, None, _aspect_types(cfg, "main"), rule=rule, cross_sign=cross_sign, skip=_skip_main_pair,
    )

    # 其它点相位：每组的元素各自与主相位表里的行星（含罗睺计都）算相位。
    planets = [p for p in main_points if p.id in PLANET_SYMBOLS]
    planet_ids = {p.id for p in planets}
    order = {code: i for i, code in enumerate(MAIN_PLANET_ORDER)}
    groups = []

    def add_group(key, items, skip=None):
        """items: [(AspectPoint, info)]。没有任何元素时不输出这一组。"""
        if not items:
            return
        group_points = [p for p, _ in items]
        found = find_aspects(group_points, planets, _aspect_types(cfg, key),
                             rule=rule, cross_sign=cross_sign, skip=skip) if planets else []
        groups.append({"key": key, "title": ASPECT_GROUPS[key],
                       "points": [i for _, i in items], "aspects": found})

    exclusive = orbs["exclusive"]
    if pts["specials"]:
        items = []
        for label, p in (extra.get("special_points") or {}).items():
            pid = f"sp:{p['code']}"
            style = pts["special_styles"][p["code"]]
            items.append((AspectPoint(pid, p["lon"], p.get("speed", 0.0), float(orbs["specials"]), exclusive["specials"]),
                          {"id": pid, "label": label, "symbol": style["symbol"], "color": style["color"]}))
        add_group("specials", items)

    if any(s["enabled"] for s in pts["stars"]):
        meta = {s["label"]: s for s in pts["stars"]}
        items = []
        for label, p in (extra.get("fixed_stars") or {}).items():
            pid = f"st:{label}"
            m = meta.get(label, {})
            items.append((AspectPoint(pid, p["lon"], p.get("speed", 0.0), float(orbs["stars"]), exclusive["stars"]),
                          {"id": pid, "label": label, "symbol": m.get("symbol", label[:3]),
                           "color": m.get("color", DEFAULT_STAR_COLOR)}))
        add_group("stars", items)

    if any(lot["enabled"] for lot in pts["lots"]["items"]):
        meta = {lot["label"]: lot for lot in pts["lots"]["items"]}
        items = []
        for label, p in (extra.get("lots") or {}).items():
            pid = f"lot:{label}"
            m = meta.get(label, {})
            items.append((AspectPoint(pid, p["lon"], p.get("speed", 0.0), float(orbs["lots"]), exclusive["lots"]),
                          {"id": pid, "label": label, "symbol": m.get("symbol", label[:3]),
                           "color": m.get("color", DEFAULT_LOT_COLOR)}))
        add_group("lots", items)

    # 映点与反映点：同一组，同一套相位类型和容许度。
    antiscia = extra.get("antiscia") or {}
    items = [
        (AspectPoint(p["id"], p["lon"], p["speed"], float(orbs["antiscia"]), exclusive["antiscia"]),
         {"id": p["id"], "label": label, "symbol": p["symbol"], "color": p["color"], "source": p["planet"]})
        for label, p in antiscia.items()
    ]
    present = {p["id"] for p in antiscia.values()}

    def skip_antiscia(a, b):
        # X 的映点（反映点）与 X 自己不算。X 的映点对 Y 与 Y 的映点对 X 完全等价（反映点同理）：
        # 两者都会算到时只保留 X 排在 Y 前面的那一个。
        prefix, src = a.id.split(":", 1)
        if b.id == src:
            return True
        mirrored = f"{prefix}:{b.id}" in present and src in planet_ids
        return mirrored and order[b.id] < order[src]

    add_group("antiscia", items, skip_antiscia)

    return {
        "main": {"points": main_info, "aspects": main_aspects},
        "groups": groups,
        "planets": [p.id for p in planets],
    }


def _point_tables(options, house_result, extra):
    """宫位、小行星、恒星、特殊点、Lot、映点与反映点的显示表（位置、赤经、赤纬为度分秒）。"""
    labels = {a["number"]: a["label"] for a in options["points"]["asteroids"]}
    asteroids = {labels.get(p.get("number"), name): p for name, p in (extra.get("asteroids") or {}).items()}
    return {
        "house_table": point_rows(house_result["houses"]),
        "asteroid_table": point_rows(asteroids),
        "star_table": point_rows(extra.get("fixed_stars") or {}, mag="mag", bayer="bayer"),
        "special_table": point_rows(extra.get("special_points") or {}),
        "lot_table": point_rows(extra.get("lots") or {}, formula="formula", sect="sect"),
        "antiscia_table": point_rows(extra.get("antiscia") or {}, symbol="symbol", color="color"),
    }


def calculate_full_chart(payload):
    normalized = _normalize_input(payload)
    options = normalized["options"]
    context = _calculate_context(normalized)

    planet_pos = _calculate_planets(context, options)
    house_result = _calculate_house_group(context, options)
    sun_events, day_lord_result, planetary_hour_data = _calculate_sun_group(context, options)

    result = {
        "context": context.to_dict(json_safe=True),
        "ecliptic_mode": options["ecliptic_mode"],
        "points": options["points"],
        "planet_pos": _format_point_map(planet_pos),
        "house_result": _format_house_result(house_result),
        "sun_events": sun_events,
        "day_lord_result": day_lord_result,
        "planetary_hour_data": planetary_hour_data,
    }
    extra = _calculate_extra_points(context, options, planet_pos, house_result)
    result.update(extra)
    result["aspects"] = _calculate_aspects(options, planet_pos, house_result, extra)
    # 行星表：星座度分秒、三分 / 界 / 面主星、先天记分、速度、得时、东出西入、黄纬赤经赤纬。
    classical = options["classical"]
    is_day = sun_above_horizon(context, classical["sect"]["day_rule"])
    result["is_day"] = is_day
    result.update(_point_tables(options, house_result, extra))
    result["planet_table"] = planet_rows(
        planet_pos, is_day=is_day, cfg=classical,
        sidereal=options["ecliptic_mode"] == "sidereal", node_mode=options["node_mode"],
    )
    return safe_json(result)


def check_lot_formula(text):
    """网页上编辑 Lot 公式时的即时校验：返回规范写法。"""
    return {"formula": normalize_formula(text)}
