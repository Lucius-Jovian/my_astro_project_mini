"""古典占星：先天尊贵、得时、速度、太阳光束。

由一颗行星的黄经、速度，以及整张盘的日夜和太阳位置，算出行星表的各列：
- 三分主星、界主星、面主星
- 先天尊贵记分：入庙、擢升、三分、界、面加分；失势、入弱、外来减分
- 速度与平均速度的比较
- 是否得时、东出 / 西入
- 与太阳的关系：日核、焦伤、光束下

所有可选的规则都由设置给出（settings.json → systems.western.classical，见 bridge.py），
本模块不调用 Swiss Ephemeris，只用已经算好的位置。
"""

from __future__ import annotations

import math
from typing import Any, Mapping

CLASSICAL = ("Su", "Mo", "Me", "Ve", "Ma", "Ju", "Sa")
SECT_PLANETS = ("Su", "Mo", "Me", "Ve", "Ma", "Ju", "Sa", "Ur", "Ne", "Pl")

# 入庙（传统七曜）
DOMICILE = ("Ma", "Ve", "Me", "Mo", "Su", "Me", "Ve", "Ma", "Ju", "Sa", "Sa", "Ju")

# 擢升：行星 → (星座, 擢升度数)
EXALTATION = {"Su": (0, 19), "Mo": (1, 3), "Me": (5, 15), "Ve": (11, 27), "Ma": (9, 28), "Ju": (3, 15), "Sa": (6, 21)}

# 三分主星：元素（0 火 1 土 2 风 3 水）→ (日间主星, 夜间主星, 共管)
# 共管可以是一颗星，也可以是 (日间共管, 夜间共管)。
TRIPLICITY = {
    # 多罗修斯（Dorotheus，《占星诗集》）：日、夜、共管三位。
    "dorothean": {0: ("Su", "Ju", "Sa"), 1: ("Ve", "Mo", "Ma"), 2: ("Sa", "Me", "Ju"), 3: ("Ve", "Ma", "Mo")},
    # 托勒密（《四书》I.18）：火、土、风只有日夜两位；水象由火星统辖，金星（日）、月亮（夜）共管。
    "ptolemaic": {0: ("Su", "Ju", None), 1: ("Ve", "Mo", None), 2: ("Sa", "Me", None), 3: ("Ma", "Ma", ("Ve", "Mo"))},
    # Lilly（《基督教占星》的尊贵表）：只有日夜两位，水象日夜都是火星。
    "lilly": {0: ("Su", "Ju", None), 1: ("Ve", "Mo", None), 2: ("Sa", "Me", None), 3: ("Ma", "Ma", None)},
}

# 界：每个星座 5 段，(主星, 这一段结束的度数)
TERMS = {
    "egyptian": (
        (("Ju", 6), ("Ve", 12), ("Me", 20), ("Ma", 25), ("Sa", 30)),
        (("Ve", 8), ("Me", 14), ("Ju", 22), ("Sa", 27), ("Ma", 30)),
        (("Me", 6), ("Ju", 12), ("Ve", 17), ("Ma", 24), ("Sa", 30)),
        (("Ma", 7), ("Ve", 13), ("Me", 19), ("Ju", 26), ("Sa", 30)),
        (("Ju", 6), ("Ve", 11), ("Sa", 18), ("Me", 24), ("Ma", 30)),
        (("Me", 7), ("Ve", 17), ("Ju", 21), ("Ma", 28), ("Sa", 30)),
        (("Sa", 6), ("Me", 14), ("Ju", 21), ("Ve", 28), ("Ma", 30)),
        (("Ma", 7), ("Ve", 11), ("Me", 19), ("Ju", 24), ("Sa", 30)),
        (("Ju", 12), ("Ve", 17), ("Me", 21), ("Sa", 26), ("Ma", 30)),
        (("Me", 7), ("Ju", 14), ("Ve", 22), ("Sa", 26), ("Ma", 30)),
        (("Me", 7), ("Ve", 13), ("Ju", 20), ("Ma", 25), ("Sa", 30)),
        (("Ve", 12), ("Ju", 16), ("Me", 19), ("Ma", 28), ("Sa", 30)),
    ),
    # 托勒密界（Lilly《基督教占星》所载）。
    "ptolemaic": (
        (("Ju", 6), ("Ve", 14), ("Me", 21), ("Ma", 26), ("Sa", 30)),
        (("Ve", 8), ("Me", 15), ("Ju", 22), ("Sa", 26), ("Ma", 30)),
        (("Me", 7), ("Ju", 14), ("Ve", 21), ("Sa", 25), ("Ma", 30)),
        (("Ma", 6), ("Ju", 13), ("Me", 20), ("Ve", 27), ("Sa", 30)),
        (("Sa", 6), ("Me", 13), ("Ve", 19), ("Ju", 25), ("Ma", 30)),
        (("Me", 7), ("Ve", 13), ("Ju", 18), ("Sa", 24), ("Ma", 30)),
        (("Sa", 6), ("Ve", 11), ("Ju", 19), ("Me", 24), ("Ma", 30)),
        (("Ma", 6), ("Ju", 14), ("Ve", 21), ("Me", 27), ("Sa", 30)),
        (("Ju", 8), ("Ve", 14), ("Me", 19), ("Sa", 25), ("Ma", 30)),
        (("Ve", 6), ("Me", 12), ("Ju", 19), ("Ma", 25), ("Sa", 30)),
        (("Sa", 6), ("Me", 12), ("Ve", 20), ("Ju", 25), ("Ma", 30)),
        (("Ve", 8), ("Ju", 14), ("Me", 20), ("Ma", 26), ("Sa", 30)),
    ),
}

# 面（decan）：迦勒底顺序，从白羊第一面的火星开始连续排下去。
FACE_SEQUENCE = ("Ma", "Su", "Ve", "Me", "Mo", "Sa", "Ju")

# ---------------------------------------------------------------- 平均速度（度 / 日）
#
# astronomical：平均黄经运动。外行星、月亮取 J2000 平均根数的变化率（Simon et al. 1994 / Meeus），
#   是相对固定春分点（≈ 恒星背景）的运动；回归黄道再加上岁差 50.29″/年（0.00003824°/日）。
#   水星、金星的地心平均运动等于太阳。冥王星取公转周期 90560 日。
# traditional：Lilly《基督教占星》的平均日行（太阳、水星、金星 59′08″，月亮 13°10′36″，
#   火星 31′27″，木星 4′59″，土星 2′01″）；外行星和交点没有传统数值，用 astronomical。
# empirical：Swiss Ephemeris 1900–2100 年逐日速度绝对值的平均（逆行段按大小计入），
#   数值明显大于平均黄经运动：例如土星 0.0695，约是 0.0335 的两倍。

PRECESSION_PER_DAY = 1.39688783 / 36525.0

MEAN_FIXED = {
    "Su": 0.98560912, "Mo": 13.17635823, "Me": 0.98560912, "Ve": 0.98560912, "Ma": 0.52403284,
    "Ju": 0.08309119, "Sa": 0.03345965, "Ur": 0.01173079, "Ne": 0.00598183, "Pl": 0.00397527,
    "Ra": 0.05299199, "Ke": 0.05299199,
}

TRADITIONAL_MEAN = {
    "Su": 59 / 60 + 8 / 3600, "Mo": 13 + 10 / 60 + 36 / 3600, "Me": 59 / 60 + 8 / 3600, "Ve": 59 / 60 + 8 / 3600,
    "Ma": 31 / 60 + 27 / 3600, "Ju": 4 / 60 + 59 / 3600, "Sa": 2 / 60 + 1 / 3600,
}

EMPIRICAL_MEAN = {
    "Su": 0.985646, "Mo": 13.176443, "Me": 1.217580, "Ve": 1.040696, "Ma": 0.566033,
    "Ju": 0.133057, "Sa": 0.069513, "Ur": 0.033381, "Ne": 0.021237, "Pl": 0.017200,
}
EMPIRICAL_NODE = {"mean": 0.052954, "true": 0.059264}

SPEED_PRESETS = ("astronomical", "traditional", "empirical", "custom")


def astronomical_mean(code: str, *, sidereal: bool) -> float:
    base = MEAN_FIXED[code]
    if code in ("Ra", "Ke"):
        return base if sidereal else base - PRECESSION_PER_DAY     # 交点退行：回归黄道下慢一点
    return base if sidereal else base + PRECESSION_PER_DAY


def mean_speed(code: str, speed_cfg: Mapping[str, Any], *, sidereal: bool, node_mode: str) -> float | None:
    if code not in MEAN_FIXED:
        return None
    preset = speed_cfg.get("preset", "astronomical")
    if preset == "custom":
        value = (speed_cfg.get("custom") or {}).get(code)
        if isinstance(value, (int, float)) and value > 0:
            return float(value)
    elif preset == "traditional" and code in TRADITIONAL_MEAN:
        return TRADITIONAL_MEAN[code]
    elif preset == "empirical":
        if code in ("Ra", "Ke"):
            return EMPIRICAL_NODE["true" if node_mode == "true" else "mean"]
        return EMPIRICAL_MEAN[code]
    return astronomical_mean(code, sidereal=sidereal)


# ---------------------------------------------------------------- 基础

_EPS = 1e-9


def norm360(lon: float) -> float:
    return float(lon) % 360.0


def sign_index(lon: float) -> int:
    return int(math.floor(norm360(lon) / 30.0 + _EPS)) % 12


def degree_in_sign(lon: float) -> float:
    x = norm360(lon)
    deg = x - sign_index(x) * 30.0
    return deg if 0.0 <= deg < 30.0 else 0.0


def dms(value: float, *, signed: bool = False) -> str:
    """十进制度 → 度分秒（截断到整秒）。"""
    v = float(value)
    total = int(math.floor(abs(v) * 3600.0 + 1e-6))
    sign = "-" if v < 0 and total else ("+" if signed else "")
    d, rest = divmod(total, 3600)
    m, s = divmod(rest, 60)
    return f"{sign}{d}°{m:02d}′{s:02d}″"


def position(lon: float) -> dict[str, Any]:
    """星座 + 星座内度分秒。"""
    return {"sign_index": sign_index(lon), "dms": dms(degree_in_sign(lon))}


def triplicity_rulers(sign: int, system: str, is_day: bool) -> dict[str, str | None]:
    day, night, part = TRIPLICITY.get(system, TRIPLICITY["dorothean"])[sign % 4]
    if isinstance(part, tuple):
        part = part[0] if is_day else part[1]
    return {"day": day, "night": night, "participating": part}


def term_ruler(lon: float, system: str = "egyptian") -> str:
    table = TERMS.get(system, TERMS["egyptian"])[sign_index(lon)]
    deg = degree_in_sign(lon)
    for ruler, end in table:
        if deg < end:
            return ruler
    return table[-1][0]


def face_ruler(lon: float) -> str:
    decan = min(2, int(degree_in_sign(lon) // 10))
    return FACE_SEQUENCE[(sign_index(lon) * 3 + decan) % 7]


def angular_distance(a: float, b: float) -> float:
    d = abs(norm360(a) - norm360(b)) % 360.0
    return 360.0 - d if d > 180.0 else d


def is_oriental(lon: float, sun_lon: float) -> bool:
    """东出：行星比太阳先升起，即黄经落在太阳之前 0–180°。"""
    diff = (norm360(sun_lon) - norm360(lon)) % 360.0
    return 0.0 < diff < 180.0


def planet_sect(code: str, rule: str | None, *, oriental: bool | None, is_day: bool) -> str | None:
    """行星的昼夜派别：'diurnal' / 'nocturnal' / None（不参与）。

    rule：diurnal 日间派、nocturnal 夜间派、none 不参与；
          oriental 东出为日间派、西入为夜间派；chart 随盘（日生盘算日间派，夜生盘算夜间派）。
    """
    if rule in ("diurnal", "nocturnal"):
        return rule
    if rule == "oriental":
        return None if oriental is None else ("diurnal" if oriental else "nocturnal")
    if rule == "chart":
        return "diurnal" if is_day else "nocturnal"
    return None


def essential_dignity(code: str, lon: float, *, is_day: bool, cfg: Mapping[str, Any]) -> dict[str, Any] | None:
    """传统七曜的先天尊贵记分；外行星、交点返回 None。"""
    if code not in CLASSICAL:
        return None
    scores = cfg.get("scores") or {}
    sign = sign_index(lon)
    items: list[tuple[str, float]] = []
    positive = False

    def add(key: str, positive_item: bool) -> None:
        nonlocal positive
        items.append((key, float(scores.get(key, 0))))
        positive = positive or positive_item

    if DOMICILE[sign] == code:
        add("domicile", True)
    if EXALTATION.get(code, (None,))[0] == sign:
        add("exaltation", True)
    t = triplicity_rulers(sign, cfg.get("triplicity_system", "dorothean"), is_day)
    mode = cfg.get("triplicity_mode", "sect")
    if mode == "all":
        trip = {t["day"], t["night"], t["participating"]}
    elif mode == "both":
        trip = {t["day"], t["night"]}
    else:
        trip = {t["day"] if is_day else t["night"]}
    if code in trip:
        add("triplicity", True)
    if term_ruler(lon, cfg.get("term_system", "egyptian")) == code:
        add("term", True)
    if face_ruler(lon) == code:
        add("face", True)
    if DOMICILE[(sign + 6) % 12] == code:
        add("detriment", False)
    if EXALTATION.get(code, (None,))[0] == (sign + 6) % 12:
        add("fall", False)
    if not positive:
        add("peregrine", False)
    total = sum(v for _, v in items)
    return {"score": int(total) if float(total).is_integer() else round(total, 2), "items": items}


def solar_phase(code: str, lon: float, sun_lon: float | None, cfg: Mapping[str, Any]) -> str | None:
    """与太阳的关系，返回设置里对应那一档的名称（例如“日核”“焦伤”“光束下”）。

    cfg["phases"] 是使用者自定义的若干档 [{"label", "orb"}]，按距离从小到大排好：
    行星与太阳的黄经距离落在哪一档的度数以内，就取最先满足的那一档。
    太阳、交点，以及比最大一档还远的，返回 None。
    """
    if sun_lon is None or code in ("Su", "Ra", "Ke"):
        return None
    d = angular_distance(lon, sun_lon)
    for phase in cfg.get("phases") or []:
        if d <= float(phase["orb"]):
            return str(phase["label"])
    return None


def planet_rows(
    planet_pos: Mapping[str, Mapping[str, Any]],
    *,
    is_day: bool,
    cfg: Mapping[str, Any],
    sidereal: bool,
    node_mode: str,
) -> list[dict[str, Any]]:
    """页面行星表的每一行。cfg 即设置里的 classical 一节。"""
    sun_lon = planet_pos.get("Su", {}).get("lon")
    sect_rules = (cfg.get("sect") or {}).get("planets") or {}
    speed_cfg = cfg.get("speed") or {}
    rows = []
    for code, p in planet_pos.items():
        lon = norm360(p["lon"])
        speed = float(p.get("speed") or 0.0)
        oriental = None if sun_lon is None or code in ("Su", "Ra", "Ke") else is_oriental(lon, sun_lon)
        sect = planet_sect(code, sect_rules.get(code), oriental=oriental, is_day=is_day)
        mean = mean_speed(code, speed_cfg, sidereal=sidereal, node_mode=node_mode)
        compared = speed if speed_cfg.get("compare") == "signed" else abs(speed)
        rows.append({
            "name": code,
            **position(lon),
            "triplicity": triplicity_rulers(sign_index(lon), cfg.get("triplicity_system", "dorothean"), is_day),
            "term": term_ruler(lon, cfg.get("term_system", "egyptian")),
            "face": face_ruler(lon),
            "dignity": essential_dignity(code, lon, is_day=is_day, cfg=cfg),
            "speed": speed,
            "mean_speed": mean,
            "speed_diff": None if mean is None else compared - mean,
            "speed_percent": None if mean is None else (compared - mean) / mean * 100.0,
            "retrograde": speed < 0,
            "sect": sect,
            "in_sect": None if sect is None else (sect == "diurnal") == bool(is_day),
            "oriental": oriental,
            "solar_phase": solar_phase(code, lon, sun_lon, cfg.get("sun") or {}),
            "lat_dms": dms(float(p.get("lat") or 0.0), signed=True),
            "ra_dms": dms(norm360(p.get("ra") or 0.0)),
            "dec_dms": dms(float(p.get("dec") or 0.0), signed=True),
        })
    return rows


def point_rows(points: Mapping[str, Mapping[str, Any]], **extra_keys: str) -> list[dict[str, Any]]:
    """小行星、恒星、特殊点、宫头等：黄经、黄纬、赤经、赤纬（度分秒）和速度。"""
    rows = []
    for name, p in points.items():
        row = {
            "name": str(name),
            **position(p["lon"]),
            "speed": float(p.get("speed") or 0.0),
        }
        if "ra" in p:
            row["ra_dms"] = dms(norm360(p["ra"]))
        if "dec" in p:
            row["dec_dms"] = dms(float(p["dec"]), signed=True)
        if "lat" in p:
            row["lat_dms"] = dms(float(p["lat"]), signed=True)
        for out_key, src_key in extra_keys.items():
            if src_key in p:
                row[out_key] = p[src_key]
        rows.append(row)
    return rows
