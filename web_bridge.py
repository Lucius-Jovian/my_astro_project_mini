from __future__ import annotations

from dataclasses import asdict, is_dataclass
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping
import json

import swisseph as swe

from quant_astro import (
    HOUSE_SYSTEMS,
    MAIN_PLANETS,
    MINOR_PLANETS,
    calculate_day_lord,
    calculate_fixed_stars,
    calculate_houses,
    calculate_minor_planets,
    calculate_planetary_hour,
    calculate_planets,
    calculate_sunrise_sunset,
    decimal_to_dms,
    parse_time_geo,
)


DEFAULT_SETTINGS = {
    "server": {
        "host": "127.0.0.1",
        "port": 5000,
    },
    "default_location": {
        "latitude": 23.0331389,
        "longitude": 113.1010556,
        "timezone": "+08:00",
        "label": "默认地点",
    },
    "birth_defaults": {
        "elevation": 0.0,
        "atpress": 1013.25,
        "attemp": 20.0,
        "calendar": "g",
    },
    "calculation_defaults": {
        "ecliptic_mode": "tropical",
        "ayanamsha_mode": "SIDM_KRISHNAMURTI",
        "node_mode": "mean",
        "house_system": "Regiomontanus",
        "heliocentric": False,
        "strict_ephe": True,
        "selected_planets": ["Su", "Mo", "Me", "Ve", "Ma", "Ju", "Sa", "Ra", "Ke"],
        "selected_minor_planets": [],
        "selected_stars": [
            "Algol,bePer",
            "Alcyone,etTau",
            "Aldebaran,alTau",
            "Capella,alAur",
            "Sirius,alCMa",
            "Procyon,alCMi",
            "Regulus,alLeo",
            "Algorab,deCrv",
            "Spica,alVir",
            "Arcturus,alBoo",
            "Alphecca,alCrB",
            "Antares,alSco",
            "Vega,alLyr",
            "DenebAlgedi,deCap",
            "Fomalhaut,alPsA",
        ],
        "sunrise_rsmi": int(swe.BIT_DISC_CENTER),
    },
}


def _deep_merge(base, override):
    result = json.loads(json.dumps(base))
    for key, value in override.items():
        if isinstance(value, Mapping) and isinstance(result.get(key), dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def load_settings(path):
    path = Path(path)
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(DEFAULT_SETTINGS, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return json.loads(json.dumps(DEFAULT_SETTINGS))

    raw = json.loads(path.read_text(encoding="utf-8"))
    return _deep_merge(DEFAULT_SETTINGS, raw)


def safe_json(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if is_dataclass(value):
        return safe_json(asdict(value))
    if isinstance(value, Mapping):
        return {str(k): safe_json(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [safe_json(v) for v in value]
    if hasattr(value, "to_dict"):
        try:
            return safe_json(value.to_dict())
        except TypeError:
            return safe_json(value.to_dict(json_safe=True))
    return str(value)


# 主行星在页面上的显示顺序。勾选列表按这个顺序排，而结果表的行顺序就是
# 「勾选的顺序」，所以改这一处，勾选列表和所有结果表（行星等）会一起跟着变。
MAIN_PLANET_ORDER = ("Su", "Mo", "Me", "Ve", "Ma", "Ju", "Sa", "Ra", "Ke", "Ur", "Ne", "Pl")


def main_planet_options():
    available = list(MAIN_PLANETS.keys()) + ["Ra", "Ke"]
    ordered = [code for code in MAIN_PLANET_ORDER if code in available]
    # 以后 quant_astro 里新增了主行星、而这里还没排位置时，放到最后，不会丢。
    return ordered + [code for code in available if code not in ordered]


def ayanamsha_options():
    """直接从当前安装的 pysweph 里枚举全部预定义岁差（SIDM_*），不手写清单。

    这样 pysweph 将来新增岁差时，下拉菜单会自动跟着多出来，不会遗漏。
    - SIDM_USER 需要额外提供 t0 / ayan_t0 两个参数，不是一个现成的“预设”，所以不放进下拉菜单。
    - NSIDM_PREDEF 只是“预定义岁差总数”的计数值，不是岁差，同样不列入。
    """
    found = []
    for name in dir(swe):
        if not name.startswith("SIDM_") or name == "SIDM_USER":
            continue
        value = getattr(swe, name)
        if not isinstance(value, int):
            continue
        try:
            title = str(swe.get_ayanamsa_name(value) or "").strip()
        except Exception:
            title = ""
        found.append((value, name, title))

    found.sort()
    return [
        {"value": name, "label": f"{title}（{name}）" if title else name}
        for _, name, title in found
    ]


def public_options():
    return {
        "house_systems": list(HOUSE_SYSTEMS.keys()),
        "ayanamsha_modes": ayanamsha_options(),
        "main_planets": main_planet_options(),
        "minor_planets": list(MINOR_PLANETS.keys()),
        "ecliptic_modes": ["tropical", "sidereal"],
        "node_modes": ["mean", "true"],
    }


def _required(payload, key):
    value = payload.get(key)
    if value is None or value == "":
        raise ValueError(f"缺少必要参数：{key}")
    return value


def _normalize_input(payload):
    birth = dict(payload.get("birth") or {})
    options = dict(payload.get("options") or {})

    result = {
        "birth": {
            "local_time_str": str(_required(birth, "local_time_str")),
            "timezone_str": str(_required(birth, "timezone_str")),
            "latitude_str": birth.get("latitude_str", birth.get("latitude")),
            "longitude_str": birth.get("longitude_str", birth.get("longitude")),
            "elevation": float(birth.get("elevation", 0.0)),
            "atpress": float(birth.get("atpress", 1013.25)),
            "attemp": float(birth.get("attemp", 20.0)),
            "calendar": str(birth.get("calendar", "g")),
        },
        "options": {
            "ecliptic_mode": str(options.get("ecliptic_mode", "tropical")),
            "ayanamsha_mode": options.get("ayanamsha_mode", "SIDM_KRISHNAMURTI"),
            "node_mode": str(options.get("node_mode", "mean")),
            "house_system": str(options.get("house_system", "Regiomontanus")),
            "heliocentric": bool(options.get("heliocentric", False)),
            "strict_ephe": bool(options.get("strict_ephe", True)),
            "selected_planets": list(
                options.get(
                    "selected_planets",
                    ["Su", "Mo", "Me", "Ve", "Ma", "Ju", "Sa", "Ra", "Ke"],
                )
            ),
            "selected_minor_planets": list(options.get("selected_minor_planets", [])),
            "selected_stars": list(options.get("selected_stars", [])),
            "sunrise_rsmi": int(options.get("sunrise_rsmi", swe.BIT_DISC_CENTER)),
        },
    }

    if result["birth"]["latitude_str"] in (None, ""):
        raise ValueError("缺少必要参数：latitude")
    if result["birth"]["longitude_str"] in (None, ""):
        raise ValueError("缺少必要参数：longitude")

    return result


def _format_point_map(items):
    output = {}
    for key, value in items.items():
        item = dict(value)
        raw = item.get("lon", item.get("angle"))
        if raw is not None:
            item["dms"] = decimal_to_dms(float(raw))["str"]
        output[key] = item
    return output


def _calculate_context(normalized):
    return parse_time_geo(**normalized["birth"])


def _calculate_planet_group(context, options):
    planet_pos = calculate_planets(
        context,
        options["selected_planets"],
        ecliptic_mode=options["ecliptic_mode"],
        ayanamsha_mode=options["ayanamsha_mode"],
        node_mode=options["node_mode"],
        heliocentric=options["heliocentric"],
        strict_ephe=options["strict_ephe"],
    )

    minor_planet_pos = calculate_minor_planets(
        context,
        options["selected_minor_planets"],
        ecliptic_mode=options["ecliptic_mode"],
        ayanamsha_mode=options["ayanamsha_mode"],
        heliocentric=options["heliocentric"],
        strict_ephe=options["strict_ephe"],
    )

    fixed_star_pos = calculate_fixed_stars(
        context,
        options["selected_stars"],
        ecliptic_mode=options["ecliptic_mode"],
        ayanamsha_mode=options["ayanamsha_mode"],
        strict_ephe=options["strict_ephe"],
    )

    return planet_pos, minor_planet_pos, fixed_star_pos


def _calculate_house_group(context, options):
    return calculate_houses(
        context,
        options["house_system"],
        ecliptic_mode=options["ecliptic_mode"],
        ayanamsha_mode=options["ayanamsha_mode"],
    )


def _format_house_result(house_result):
    return {
        **house_result,
        "houses": _format_point_map(house_result["houses"]),
        "axes": _format_point_map(house_result["axes"]),
        "auxiliary_points": _format_point_map(house_result["auxiliary_points"]),
    }


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


def calculate_full_chart(payload):
    normalized = _normalize_input(payload)
    options = normalized["options"]
    context = _calculate_context(normalized)

    planet_pos, minor_planet_pos, fixed_star_pos = _calculate_planet_group(
        context,
        options,
    )
    house_result = _calculate_house_group(context, options)
    sun_events, day_lord_result, planetary_hour_data = _calculate_sun_group(
        context,
        options,
    )

    return safe_json(
        {
            "context": context.to_dict(json_safe=True),
            "planet_pos": _format_point_map(planet_pos),
            "minor_planet_pos": _format_point_map(minor_planet_pos),
            "fixed_star_pos": _format_point_map(fixed_star_pos),
            "house_result": _format_house_result(house_result),
            "sun_events": sun_events,
            "day_lord_result": day_lord_result,
            "planetary_hour_data": planetary_hour_data,
        }
    )


def calculate_partial_chart(payload):
    normalized = _normalize_input(payload)
    options = normalized["options"]
    changed_fields = set(payload.get("changed_fields") or [])

    if not changed_fields:
        return {}

    context_fields = {
        "local_time_str",
        "timezone_str",
        "latitude",
        "longitude",
        "latitude_str",
        "longitude_str",
        "elevation",
        "atpress",
        "attemp",
        "calendar",
    }

    planetary_fields = {
        "ecliptic_mode",
        "ayanamsha_mode",
        "node_mode",
        "heliocentric",
        "strict_ephe",
        "selected_planets",
        "selected_minor_planets",
        "selected_stars",
    }

    house_fields = {
        "house_system",
    }

    sun_fields = {
        "sunrise_rsmi",
    }

    if changed_fields & context_fields:
        return calculate_full_chart(payload)

    context = _calculate_context(normalized)
    updates = {}

    if changed_fields == {"selected_minor_planets"}:
        minor_planet_pos = calculate_minor_planets(
            context,
            options["selected_minor_planets"],
            ecliptic_mode=options["ecliptic_mode"],
            ayanamsha_mode=options["ayanamsha_mode"],
            heliocentric=options["heliocentric"],
            strict_ephe=options["strict_ephe"],
        )
        return safe_json(
            {"minor_planet_pos": _format_point_map(minor_planet_pos)}
        )

    if changed_fields == {"selected_stars"}:
        fixed_star_pos = calculate_fixed_stars(
            context,
            options["selected_stars"],
            ecliptic_mode=options["ecliptic_mode"],
            ayanamsha_mode=options["ayanamsha_mode"],
            strict_ephe=options["strict_ephe"],
        )
        return safe_json(
            {"fixed_star_pos": _format_point_map(fixed_star_pos)}
        )

    house_result = None

    if changed_fields & planetary_fields:
        planet_pos, minor_planet_pos, fixed_star_pos = _calculate_planet_group(
            context,
            options,
        )
        updates["planet_pos"] = _format_point_map(planet_pos)
        updates["minor_planet_pos"] = _format_point_map(minor_planet_pos)
        updates["fixed_star_pos"] = _format_point_map(fixed_star_pos)

        if changed_fields & {"ecliptic_mode", "ayanamsha_mode"}:
            house_result = _calculate_house_group(context, options)
            updates["house_result"] = _format_house_result(house_result)

    if changed_fields & house_fields:
        if house_result is None:
            house_result = _calculate_house_group(context, options)
            updates["house_result"] = _format_house_result(house_result)

    if changed_fields & sun_fields:
        sun_events, day_lord_result, planetary_hour_data = _calculate_sun_group(
            context,
            options,
        )
        updates["sun_events"] = sun_events
        updates["day_lord_result"] = day_lord_result
        updates["planetary_hour_data"] = planetary_hour_data

    return safe_json(updates)
