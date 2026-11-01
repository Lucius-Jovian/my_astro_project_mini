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


# ---------------------------------------------------------------- 日出判定基准（两个体系共用）
#
# 设置写成 {"limb", "refraction", "latitude"}，排盘时换算成 Swiss Ephemeris rise_trans 的 rsmi 标志：
#   limb        upper 太阳上边缘（天文年历的标准）/ center 日心 / lower 下边缘
#   refraction  是否计入大气折射（关掉时按几何地平）
#   latitude    是否计入太阳的黄纬（关掉即 Swiss Ephemeris 的 BIT_GEOCTR_NO_ECL_LAT）
# 印度传统的 Hindu rising = 日心、不计折射、不计黄纬。
# 默认值与以前固定的 BIT_DISC_CENTER 相同（日心、计折射、计黄纬），升级后日出时刻不变。

SUNRISE_LIMBS = {"upper": 0, "center": int(swe.BIT_DISC_CENTER), "lower": int(swe.BIT_DISC_BOTTOM)}
SUNRISE_NO_ECL_LAT = 128                     # BIT_GEOCTR_NO_ECL_LAT（pysweph 没有导出这个名字）
DEFAULT_SUNRISE = {"limb": "center", "refraction": True, "latitude": True}


def sunrise_from_rsmi(rsmi):
    """旧版本保存的 sunrise_rsmi 整数 → 设置字典。"""
    try:
        value = int(rsmi)
    except (TypeError, ValueError):
        return dict(DEFAULT_SUNRISE)
    limb = "lower" if value & SUNRISE_LIMBS["lower"] else "center" if value & SUNRISE_LIMBS["center"] else "upper"
    return {"limb": limb, "refraction": not value & int(swe.BIT_NO_REFRACTION), "latitude": not value & SUNRISE_NO_ECL_LAT}


def clean_sunrise(raw, *, strict=False):
    if not isinstance(raw, dict):
        if strict:
            raise ValueError("日出设置格式不对。")
        return dict(DEFAULT_SUNRISE)
    clean = dict(DEFAULT_SUNRISE)
    for key, value in raw.items():
        if key == "limb" and value in SUNRISE_LIMBS:
            clean[key] = value
        elif key in ("refraction", "latitude") and isinstance(value, bool):
            clean[key] = value
        elif strict:
            raise ValueError(f"日出设置 {key} 的值不合法：{value!r}")
    return clean


def sunrise_rsmi(cfg):
    """日出设置 → rise_trans 的 rsmi（不含 CALC_RISE / CALC_SET，由调用处另加）。"""
    cfg = clean_sunrise(cfg)
    flags = SUNRISE_LIMBS[cfg["limb"]]
    if not cfg["refraction"]:
        flags |= int(swe.BIT_NO_REFRACTION)
    if not cfg["latitude"]:
        flags |= SUNRISE_NO_ECL_LAT
    return flags


def sunrise_option(options):
    """排盘请求里的日出设置：新写法 sunrise（字典），旧写法 sunrise_rsmi（整数）。返回 rsmi。"""
    if isinstance(options.get("sunrise"), dict):
        return sunrise_rsmi(options["sunrise"])
    return int(options.get("sunrise_rsmi", swe.BIT_DISC_CENTER))


def normalize_sunrise_defaults(calc):
    """读 settings.json 时：没有 sunrise 字典就从旧的 sunrise_rsmi 换算一份；sunrise_rsmi 不再保存。"""
    calc = dict(calc)
    old = calc.pop("sunrise_rsmi", None)
    current = clean_sunrise(calc["sunrise"]) if isinstance(calc.get("sunrise"), dict) else dict(DEFAULT_SUNRISE)
    # 默认值和文件合并后一定有 sunrise；它仍是默认值而文件里留着旧的整数时，以旧的整数为准。
    if old is not None and current == DEFAULT_SUNRISE:
        current = sunrise_from_rsmi(old)
    calc["sunrise"] = current
    return calc


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
