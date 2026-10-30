"""印度占星：设置的默认值与校验、排盘计算（行星、宫位、KP、主宰星、Vimshottari Dasha）。"""

from __future__ import annotations

import re

import swisseph as swe

from common.astro import (
    HOUSE_SYSTEMS,
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
    describe_points,
    build_significator_maps,
    calculate_house_significators,
    calculate_planet_significators,
    get_ruling_planets,
    kp_lookup,
    kp_lookup_many,
    solve_horary_houses,
)
from .astro import dasha as dasha_engine
from .astro.panchanga import calculate_panchanga


# ---------------------------------------------------------------- 计算模块
#
# 键 = 模块名；值 = 页面上的名称。
# Vimshottari 大运永远计算。其余五个 KP 模块是一个整体：计算设置里勾选「启用 KP」时一起计算，
# 不勾选时一起跳过（KP 卜卦也只在启用 KP 时起作用）。
MODULES = {
    "kp_planet_lords": "KP 行星",
    "kp_house_lords": "KP 宫位",
    "kp_planet_sigs": "KP 行星 ABCD",
    "kp_house_sigs": "KP 宫位 1234",
    "kp_ruling": "KP 主宰星",
    "dasha": "Dasha",
}
KP_MODULES = ("kp_planet_lords", "kp_house_lords", "kp_planet_sigs", "kp_house_sigs", "kp_ruling")


def resolve_modules(kp_enabled):
    """由「启用 KP」得到完整的模块开关表：五个 KP 模块随它一起开关，大运永远开着。"""
    on = bool(kp_enabled)
    return {**{name: on for name in KP_MODULES}, "dasha": True}


# ---------------------------------------------------------------- 本体系在 settings.json 里的设置
#
# 位置：settings.json → systems.vedic。共用的设置（外观、会话、默认地点等）不在这里。

SYSTEM_ID = "vedic"
CHART_STYLES = ("north", "south")

DEFAULT_SYSTEM_SETTINGS = {
    "calculation_defaults": {
        # 页面打开时的默认选项；黄道、岁差、宫位制、月交点在网页上改了会自动记住。
        "ecliptic_mode": "sidereal",
        "ayanamsha_mode": "SIDM_KRISHNAMURTI",
        "node_mode": "mean",
        "house_system": "Regiomontanus",
        # 启用 KP：五个 KP 模块（星主表、ABCD、1234、主宰星）和 KP 卜卦作为一个整体开关。
        "kp_enabled": True,
        "KP_HORARY": {
            "is_active": False,
            "mode": "KS-N",
            "number": 78,
        },
        "sunrise_rsmi": int(swe.BIT_DISC_CENTER),
        "dasha_days_in_year": 365.25,
        # 大运从哪颗行星起算（默认月亮；可选任何行星，包括罗睺 / 计都）。所有大运体系共用。
        "dasha_start_planet": "Mo",
        # 打开 Dasha 标签页时先显示哪一种大运；只在 Dasha 标签页顶部切换，切换后自动记住。
        "dasha_system": dasha_engine.DEFAULT_SYSTEM,
    },
    # 星盘样式：north 北印度 / south 南印度。
    "chart_style": "north",
    # 分盘设置（计算设置 → 分盘）。
    "varga": {
        # Rashi 盘以哪个星座为第一宫：asc = 跟随上升点；0–11 = 白羊…双鱼（转宫）。只转星盘，结果表不变。
        "rashi_lagna": "asc",
        # Bhava 盘的宫位制（与左侧「宫位制」相互独立）；默认 Sripati。
        "bhava_house_system": "Sripati",
        # 各张 D 盘用哪种算法：{"D2": "parivritti", ...}。没写的用默认算法（vargas.js 里每张分盘的第一种）。
        # 有哪些分盘、有哪些算法都登记在 static/vargas.js，这里只检查名称的写法。
        "methods": {},
    },
    # 星盘相位：罗睺、计都是否投射第 5、7、9 个星座的相位（星盘点击高亮和 Yoga 的相位判断都按这里）。
    "aspects": {"Ra": True, "Ke": True},
    # 燃烧（Combust）：离太阳多少度以内算燃烧；Me_r、Ve_r 是水星、金星逆行时的度数。默认取 BPHS 常用值。
    "combust": {"Mo": 12.0, "Ma": 17.0, "Me": 14.0, "Me_r": 12.0, "Ju": 11.0, "Ve": 10.0, "Ve_r": 8.0, "Sa": 15.0},
    # Yoga：默认清单在 static/yogas_default.js；这里只存使用者的改动。
    #   disabled  停用的 Yoga（id 列表）
    #   removed   删掉的默认 Yoga（id 列表；可以在「管理 Yoga」里恢复）
    #   custom    自定义的 Yoga，以及改过的默认 Yoga（id 与默认的相同即覆盖默认的那一条）
    "yogas": {"disabled": [], "removed": [], "custom": []},
}

YOGA_ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,60}$")
YOGA_TEXT_LIMITS = {"name": 80, "cn": 80, "cat": 40, "rule": 2000, "desc": 400, "effect": 400, "src": 120}
YOGA_MAX_CUSTOM = 500


def _clean_aspects(raw, *, strict):
    raw = raw if isinstance(raw, dict) else {}
    clean = {}
    for key, value in raw.items():
        if key in ("Ra", "Ke") and isinstance(value, bool):
            clean[key] = value
        elif strict:
            raise ValueError("相位设置只能是 Ra / Ke: true / false。")
    return clean


def _clean_combust(raw, *, strict):
    raw = raw if isinstance(raw, dict) else {}
    clean = {}
    for key, value in raw.items():
        if key not in DEFAULT_SYSTEM_SETTINGS["combust"]:
            if strict:
                raise ValueError(f"未知的燃烧设置：{key}")
            continue
        try:
            v = float(value)
            if isinstance(value, bool) or not 0 <= v <= 30:
                raise ValueError
            clean[key] = v
        except (TypeError, ValueError):
            if strict:
                raise ValueError("燃烧度数要在 0° 到 30° 之间。") from None
    return clean


def _clean_id_list(value, what, *, strict):
    if not isinstance(value, list):
        if strict:
            raise ValueError(f"{what}必须是列表。")
        return []
    out = []
    for item in value:
        if isinstance(item, str) and YOGA_ID_RE.match(item):
            if item not in out:
                out.append(item)
        elif strict:
            raise ValueError(f"{what}里的 id 不合法：{item!r}")
    return out[:2000]


def _clean_yoga(item, *, strict):
    if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not YOGA_ID_RE.match(item["id"]):
        if strict:
            raise ValueError("自定义 Yoga 缺少合法的 id。")
        return None
    clean = {"id": item["id"]}
    for key, limit in YOGA_TEXT_LIMITS.items():
        value = item.get(key, "")
        if not isinstance(value, str):
            if strict:
                raise ValueError(f"Yoga「{item['id']}」的 {key} 必须是文字。")
            value = ""
        if len(value) > limit:
            if strict:
                raise ValueError(f"Yoga「{item['id']}」的 {key} 太长（最多 {limit} 个字符）。")
            value = value[:limit]
        clean[key] = value
    if not clean["rule"].strip():
        if strict:
            raise ValueError(f"Yoga「{item['id']}」没有填写条件公式。")
        return None
    return clean


def _clean_yogas(raw, *, strict):
    """Yoga 设置只检查格式（公式写得对不对由页面上的引擎检查：写错的那一条只是算不出来，不影响别的）。"""
    raw = raw if isinstance(raw, dict) else {}
    clean = {}
    for key, value in raw.items():
        if key in ("disabled", "removed"):
            clean[key] = _clean_id_list(value, "停用 / 删除的 Yoga ", strict=strict)
        elif key == "custom":
            if not isinstance(value, list):
                if strict:
                    raise ValueError("自定义 Yoga 必须是列表。")
                continue
            if len(value) > YOGA_MAX_CUSTOM:
                if strict:
                    raise ValueError(f"自定义 Yoga 最多 {YOGA_MAX_CUSTOM} 条。")
                value = value[:YOGA_MAX_CUSTOM]
            items, seen = [], set()
            for item in value:
                cleaned = _clean_yoga(item, strict=strict)
                if cleaned and cleaned["id"] not in seen:
                    seen.add(cleaned["id"])
                    items.append(cleaned)
            clean[key] = items
        elif strict:
            raise ValueError(f"未知的 Yoga 设置：{key}")
    return clean

VARGA_ID_RE = re.compile(r"^D\d{1,3}$")
VARGA_METHOD_RE = re.compile(r"^[a-z0-9_-]{1,40}$")


def _clean_varga(raw, *, strict):
    """分盘设置的校验。strict=False 用于读文件：不合法的项改回默认值；strict=True 用于网页保存：直接报错。"""
    raw = raw if isinstance(raw, dict) else {}
    clean = {}
    for key, value in raw.items():
        if key == "rashi_lagna":
            if value == "asc" or (isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 11):
                clean[key] = value
            elif strict:
                raise ValueError("Rashi 第一宫只能是 asc（跟随上升点）或 0–11（白羊…双鱼）。")
        elif key == "bhava_house_system":
            if value in HOUSE_SYSTEMS:
                clean[key] = value
            elif strict:
                raise ValueError(f"未知的宫位制：{value}")
        elif key == "methods":
            if not isinstance(value, dict):
                if strict:
                    raise ValueError("分盘算法必须是 {分盘: 算法} 的形式。")
                continue
            methods = {}
            for vid, method in value.items():
                if isinstance(vid, str) and VARGA_ID_RE.match(vid) and isinstance(method, str) and VARGA_METHOD_RE.match(method):
                    methods[vid] = method
                elif strict:
                    raise ValueError(f"分盘算法的写法不合法：{vid!r}: {method!r}")
            clean[key] = methods
        elif strict:
            raise ValueError(f"未知的分盘设置：{key}")
    return clean

HORARY_MODES = {"KS-N": 249, "CIL-N": 2193}      # 卜卦模式 → 签号上限


def _clean_horary(raw, *, strict):
    raw = raw if isinstance(raw, dict) else {}
    default = DEFAULT_SYSTEM_SETTINGS["calculation_defaults"]["KP_HORARY"]
    mode = str(raw.get("mode") or default["mode"]).upper()
    if mode not in HORARY_MODES:
        if strict:
            raise ValueError("KP 卜卦模式只能是 KS-N 或 CIL-N。")
        mode = default["mode"]
    try:
        number = int(raw.get("number", default["number"]))
        if not 1 <= number <= HORARY_MODES[mode]:
            raise ValueError
    except (TypeError, ValueError):
        if strict:
            raise ValueError(f"{mode} 签号必须是 1–{HORARY_MODES[mode]} 的整数。") from None
        number = min(max(1, int(default["number"])), HORARY_MODES[mode])
    active = raw.get("is_active", default["is_active"])
    return {"is_active": active if isinstance(active, bool) else bool(default["is_active"]),
            "mode": mode, "number": number}


def _clean_vedic_calc(updates, *, strict):
    """印度占星自己的计算设置（启用 KP、KP 卜卦、大运年长度、大运起算行星）。"""
    clean = {}
    for key, value in (updates or {}).items():
        if key == "kp_enabled":
            if not isinstance(value, bool):
                if strict:
                    raise ValueError("kp_enabled 只能是 true / false。")
                continue
            clean[key] = value
        elif key == "KP_HORARY":
            clean[key] = _clean_horary(value, strict=strict)
        elif key == "dasha_days_in_year":
            try:
                days = float(value)
                if not 300 <= days <= 400:
                    raise ValueError
                clean[key] = days
            except (TypeError, ValueError):
                if strict:
                    raise ValueError("Dasha 年长度必须是 300–400 之间的天数。") from None
        elif key == "dasha_start_planet":
            if value not in MAIN_PLANET_ORDER:
                if strict:
                    raise ValueError(f"未知的大运起算行星：{value}")
                continue
            clean[key] = value
        elif key == "dasha_system":
            if value not in dasha_engine.SYSTEMS:
                if strict:
                    raise ValueError(f"未知的大运体系：{value}")
                continue
            clean[key] = value
        elif strict:
            raise ValueError(f"未知的计算设置：{key}")
    return clean


def normalize_system_settings(section):
    section = dict(section)
    calc = dict(section.get("calculation_defaults") or {})
    section.pop("modules", None)       # 旧版本的 6 个模块开关已经换成「启用 KP」，不再使用
    calc.update(_clean_vedic_calc({k: calc[k] for k in ("kp_enabled", "KP_HORARY", "dasha_days_in_year",
                                                        "dasha_start_planet", "dasha_system") if k in calc},
                                  strict=False))
    defaults = DEFAULT_SYSTEM_SETTINGS["calculation_defaults"]
    for key in ("kp_enabled", "dasha_days_in_year", "dasha_start_planet", "dasha_system"):
        if not isinstance(calc.get(key), type(defaults[key])):
            calc[key] = defaults[key]
    section["calculation_defaults"] = calc
    if section.get("chart_style") not in CHART_STYLES:
        section["chart_style"] = "north"
    section["varga"] = {**DEFAULT_SYSTEM_SETTINGS["varga"], **_clean_varga(section.get("varga"), strict=False)}
    section["aspects"] = {**DEFAULT_SYSTEM_SETTINGS["aspects"], **_clean_aspects(section.get("aspects"), strict=False)}
    section["combust"] = {**DEFAULT_SYSTEM_SETTINGS["combust"], **_clean_combust(section.get("combust"), strict=False)}
    section["yogas"] = {**DEFAULT_SYSTEM_SETTINGS["yogas"], **_clean_yogas(section.get("yogas"), strict=False)}
    return section


def _keys(name):
    return ("systems", SYSTEM_ID, name)


BASIC_KEYS = ("ecliptic_mode", "ayanamsha_mode", "house_system", "node_mode")


def save_calc_defaults(store, updates):
    """计算设置里的任何一项改了就写回 settings.json，下次打开页面沿用。"""
    updates = dict(updates or {})
    clean = clean_basic_calc({k: v for k, v in updates.items() if k in BASIC_KEYS})
    clean.update(_clean_vedic_calc({k: v for k, v in updates.items() if k not in BASIC_KEYS}, strict=True))
    return dict(store.write(_keys("calculation_defaults"), clean))


def save_varga(store, updates):
    """分盘设置（Rashi 第一宫、Bhava 宫位制、各分盘算法）改了就写回；methods 整份替换。"""
    clean = _clean_varga(updates, strict=True)
    if not clean:
        raise ValueError("没有要保存的分盘设置。")
    return dict(store.write(_keys("varga"), clean))


def save_aspects(store, updates):
    clean = _clean_aspects(updates, strict=True)
    if not clean:
        raise ValueError("没有要保存的相位设置。")
    return dict(store.write(_keys("aspects"), clean))


def save_combust(store, updates):
    clean = _clean_combust(updates, strict=True)
    if not clean:
        raise ValueError("没有要保存的燃烧设置。")
    return dict(store.write(_keys("combust"), clean))


def save_yogas(store, updates):
    """Yoga 设置（停用、删除、自定义），传来的几项整项替换。"""
    clean = _clean_yogas(updates, strict=True)
    if not clean:
        raise ValueError("没有要保存的 Yoga 设置。")
    return dict(store.write(_keys("yogas"), clean))


def save_chart_style(store, value):
    if value not in CHART_STYLES:
        raise ValueError("星盘样式只能是 north（北印度）或 south（南印度）。")
    return store.write(_keys("chart_style"), value)


# 主行星在页面上的显示顺序。勾选列表按这个顺序排，而结果表的行顺序就是
# 「勾选的顺序」，所以改这一处，勾选列表和所有结果表（行星、KP 等）会一起跟着变。
MAIN_PLANET_ORDER = ("Su", "Mo", "Me", "Ve", "Ma", "Ju", "Sa", "Ra", "Ke")


def main_planet_options():
    """印度占星只用这 9 颗（共用的天文基础还能算天王星等，这里不要）。"""
    return list(MAIN_PLANET_ORDER)


def public_options():
    return {
        "house_systems": house_system_options(),
        "ayanamsha_modes": ayanamsha_options(),
        "main_planets": main_planet_options(),
        "ecliptic_modes": ["tropical", "sidereal"],
        "node_modes": ["mean", "true"],
        "horary_modes": ["KS-N", "CIL-N"],
        "modules": [{"value": name, "label": label} for name, label in MODULES.items()],
        "kp_modules": list(KP_MODULES),
        "dasha_systems": dasha_engine.system_options(),
    }


def _required(payload, key):
    value = payload.get(key)
    if value is None or value == "":
        raise ValueError(f"缺少必要参数：{key}")
    return value


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
            # 所有主行星和罗睺 / 计都永远都算、都显示，不再提供勾选。
            "selected_planets": main_planet_options(),
            "KP_HORARY": dict(
                options.get(
                    "KP_HORARY",
                    {"is_active": False, "mode": "KS-N", "number": 78},
                )
            ),
            "sunrise_rsmi": int(options.get("sunrise_rsmi", swe.BIT_DISC_CENTER)),
            "dasha_days_in_year": float(options.get("dasha_days_in_year", 365.25)),
            "dasha_start_planet": str(options.get("dasha_start_planet") or "Mo"),
            "modules": resolve_modules(options.get("kp_enabled", True)),
        },
    }

    if result["birth"]["latitude_str"] in (None, ""):
        raise ValueError("缺少必要参数：latitude")
    if result["birth"]["longitude_str"] in (None, ""):
        raise ValueError("缺少必要参数：longitude")

    return result


def _format_point_map(items):
    """原样输出十进制的黄经等数值（不再附加度分秒字符串）。"""
    return {key: dict(value) for key, value in items.items()}


def _calculate_context(normalized):
    return parse_time_geo(**normalized["birth"])


def _calculate_planets(context, options):
    return calculate_planets(
        context,
        options["selected_planets"],
        ecliptic_mode=options["ecliptic_mode"],
        ayanamsha_mode=options["ayanamsha_mode"],
        node_mode=options["node_mode"],
    )


def _format_house_result(house_result):
    """宫头和四轴；四轴不在页面单独展示，但星盘的上升点（Lagna）和主宰星都依赖 axes["Asc"]。"""
    return {
        **house_result,
        "houses": _format_point_map(house_result["houses"]),
        "axes": _format_point_map(house_result["axes"]),
    }


def _calculate_house_group(context, options):
    horary = options["KP_HORARY"]
    # KP 卜卦属于 KP：只有启用 KP 时才按卜卦签号推算上升点。
    if horary.get("is_active") and options["modules"]["kp_planet_lords"]:
        return solve_horary_houses(
            context,
            int(horary["number"]),
            mode=horary.get("mode", "KS-N"),
            house_system=options["house_system"],
            ecliptic_mode=options["ecliptic_mode"],
            ayanamsha_mode=options["ayanamsha_mode"],
        )

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


def _calculate_kp_group(planet_pos, house_result, day_lord_result, modules):
    """只计算开着的 KP 模块；关掉的模块既不计算，也不出现在返回结果里。

    这里只读 planet_pos / house_result 里的黄经（lon），与黄道体系无关。
    """
    output = {}
    houses = house_result["houses"]
    axes = house_result["axes"]

    kp_planet_results = None
    kp_house_results = None
    if modules["kp_planet_lords"]:
        kp_planet_results = kp_lookup_many(planet_pos)
        output["kp_planet_results"] = kp_planet_results
    if modules["kp_house_lords"]:
        kp_house_results = kp_lookup_many(houses)
        output["kp_house_results"] = kp_house_results

    if modules["kp_planet_sigs"] or modules["kp_house_sigs"]:
        # resolve_modules 已保证此时两张星主表都开着。
        maps = build_significator_maps(planet_pos, houses, kp_planet_results, kp_house_results)
        if modules["kp_planet_sigs"]:
            output["kp_planet_sigs"] = calculate_planet_significators(
                planet_pos, houses, kp_planet_results, kp_house_results, shared_maps=maps
            )
        if modules["kp_house_sigs"]:
            output["kp_house_sigs"] = calculate_house_significators(
                planet_pos, houses, kp_planet_results, kp_house_results, shared_maps=maps
            )

    if modules["kp_ruling"]:
        asc_kp_result = kp_lookup(axes["Asc"]["lon"])
        # 主宰星只需要月亮这一处的 KP 查表：星主表开着就复用，关着就只查月亮一颗。
        if kp_planet_results is not None:
            moon_source = kp_planet_results
        elif "Mo" in planet_pos:
            moon_source = {"Mo": kp_lookup(planet_pos["Mo"]["lon"])}
        else:
            moon_source = {}
        output["asc_kp_result"] = asc_kp_result
        output["kp_ruling_planets"] = get_ruling_planets(
            moon_source,
            kp_house_results or {},
            day_lord_result,
            asc_kp_result=asc_kp_result,
        )
    return output


def _calculate_dasha(context, planet_pos, options):
    """全部大运体系的第一层（每种只有十几段，一起算好，标签页里切换不必重新排盘）。"""
    if not options["modules"]["dasha"]:
        return None
    start_planet = options["dasha_start_planet"]
    if start_planet not in planet_pos:
        raise ValueError(f"未知的大运起算行星：{start_planet}")
    # 起算点的黄经就是当前所选黄道体系下这颗行星的黄经。
    lon = float(planet_pos[start_planet]["lon"])
    systems = []
    for item in dasha_engine.system_options():
        periods = dasha_engine.level1(context, lon, item["value"], days_in_year=options["dasha_days_in_year"])
        systems.append({**item, "periods": [p.to_dict() for p in periods]})
    return {
        "start_planet": start_planet,
        "days_in_year": options["dasha_days_in_year"],
        "systems": systems,
    }


def calculate_bhava_houses(payload):
    """Bhava 盘用的宫头：与本命盘同一时刻、同样的黄道和岁差（KP 卜卦开着时同样按签号定上升点），
    只是宫位制换成 Bhava 盘自己的（payload["house_system"]）。只在页面上点开 Bhava 盘、
    而且它的宫位制与本命盘不同时才会请求。"""
    house_system = str(payload.get("house_system") or "")
    if house_system not in HOUSE_SYSTEMS:
        raise ValueError(f"未知的宫位制：{house_system}")
    normalized = _normalize_input(payload)
    options = {**normalized["options"], "house_system": house_system}
    context = _calculate_context(normalized)
    house_result = _calculate_house_group(context, options)
    return safe_json({"house_system": house_system,
                      "houses": _format_point_map(house_result["houses"]),
                      "axes": _format_point_map(house_result["axes"])})


def calculate_full_chart(payload):
    normalized = _normalize_input(payload)
    options = normalized["options"]
    modules = options["modules"]
    context = _calculate_context(normalized)

    planet_pos = _calculate_planets(context, options)
    house_result = _calculate_house_group(context, options)
    sun_events, day_lord_result, planetary_hour_data = _calculate_sun_group(context, options)
    kp = _calculate_kp_group(planet_pos, house_result, day_lord_result, modules)

    result = {
        "context": context.to_dict(json_safe=True),
        "ecliptic_mode": options["ecliptic_mode"],
        "modules": modules,
        "dasha_start_planet": options["dasha_start_planet"],
        "dasha_days_in_year": options["dasha_days_in_year"],
        "planet_pos": _format_point_map(planet_pos),
        "house_result": _format_house_result(house_result),
        # 页面上的行星 / 宫位表：星座度分秒、星宿、宿主星、Pada（行星另有顺行 / 逆行）。
        "planet_table": describe_points(planet_pos, with_motion=True),
        "house_table": describe_points(house_result["houses"], with_motion=False),
        "sun_events": sun_events,
        "day_lord_result": day_lord_result,
        "planetary_hour_data": planetary_hour_data,
        # Panchanga：Nakshatra、Yoga 一律按恒星黄道（用所选岁差），与星盘选哪种黄道无关。
        "panchanga": calculate_panchanga(context, day_lord_result["day_lord"], options["ayanamsha_mode"]),
        **kp,
    }
    dasha = _calculate_dasha(context, planet_pos, options)
    if dasha is not None:
        result["dasha"] = dasha
    return safe_json(result)
