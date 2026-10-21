"""两个体系共用的下拉选项：岁差、宫位制。"""

from __future__ import annotations

import swisseph as swe

from .core import HOUSE_SYSTEMS


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
    return [{"value": name, "label": title or name} for _, name, title in found]


def house_system_options():
    return list(HOUSE_SYSTEMS.keys())


BASIC_CALC_KEYS = ("ecliptic_mode", "ayanamsha_mode", "house_system", "node_mode")


def clean_basic_calc(updates):
    """校验计算设置里两个体系共有的四项（黄道、岁差、宫位制、月交点）。"""
    choices = {
        "ecliptic_mode": ("tropical", "sidereal"),
        "ayanamsha_mode": tuple(o["value"] for o in ayanamsha_options()),
        "house_system": tuple(HOUSE_SYSTEMS),
        "node_mode": ("mean", "true"),
    }
    clean = {}
    for key, value in (updates or {}).items():
        if key not in choices:
            raise ValueError(f"未知的计算设置：{key}")
        if value not in choices[key]:
            raise ValueError(f"计算设置 {key} 的值不合法：{value}")
        clean[key] = value
    return clean
