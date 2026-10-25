"""印度占星：设置的默认值与校验、排盘计算（行星、宫位、KP、主宰星、Vimshottari Dasha）。"""

from __future__ import annotations

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
}

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
        **kp,
    }
    dasha = _calculate_dasha(context, planet_pos, options)
    if dasha is not None:
        result["dasha"] = dasha
    return safe_json(result)
