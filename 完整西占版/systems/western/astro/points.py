"""小行星、恒星和特殊点（月亮远/近地点、朔望点、Vertex、东方点）。

所有位置都通过 Swiss Ephemeris 的星历文件计算（FLG_SWIEPH），不使用 Moshier 近似算法：
- 小行星：swe.calc_ut。谷神、智神、婚神、灶神、凯龙、人龙在主小行星文件 seas_*.se1 里；
  其它编号的小行星在各自的文件里（例如 433 爱神星 = ast0/se00433s.se1），文件不在时
  Swiss Ephemeris 直接报错（小行星没有近似算法可以回退），这里把错误逐条返回，不影响其它点。
- 恒星：swe.fixstar2_ut，读取星历目录里的 sefstars.txt。
- 月亮远/近地点：swe.calc_ut 的 MEAN_APOG / OSCU_APOG / INTP_APOG / INTP_PERG。
- 朔望点：用 swe.calc_ut 的日月位置与速度，牛顿迭代求出生前最近一次朔或望的时刻。
- Vertex / AntiVertex / EastPoint：直接取自 core.calculate_houses 的 ascmc。

每个函数都在 _SWISS_LOCK 里自行恢复星历路径与岁差状态，可以单独调用。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Iterable, Mapping

import swisseph as swe

from common.astro.core import (
    AstroContext,
    _SWISS_LOCK,
    _calc_body,
    _check_ephemeris_result,
    _jd_to_local,
    _position_flags,
    set_ephemeris_path,
)

# ---------------------------------------------------------------- 小行星

#: 这几个小行星在 Swiss Ephemeris 里有专用编号，数据在 seas_*.se1 里，
#: 不需要单独的 ast*/se*.se1 文件。用户输入它们的 MPC 编号时自动换成专用编号。
BUILTIN_ASTEROIDS: dict[int, int] = {
    1: swe.CERES,
    2: swe.PALLAS,
    3: swe.JUNO,
    4: swe.VESTA,
    2060: swe.CHIRON,
    5145: swe.PHOLUS,
}

MAX_ASTEROID_NUMBER = 9_999_999


def asteroid_body_id(number: int) -> int:
    """MPC 小行星编号 → Swiss Ephemeris 的星体编号。"""
    number = int(number)
    if not 1 <= number <= MAX_ASTEROID_NUMBER:
        raise ValueError(f"小行星编号必须在 1–{MAX_ASTEROID_NUMBER} 之间。")
    return BUILTIN_ASTEROIDS.get(number, swe.AST_OFFSET + number)


def asteroid_file_hint(number: int) -> str:
    """这颗小行星的星历文件应放在星历目录下的哪个位置（主小行星文件里的返回空串）。"""
    number = int(number)
    if number in BUILTIN_ASTEROIDS:
        return ""
    name = f"s{number:06d}s.se1" if number > 99999 else f"se{number:05d}s.se1"
    return f"ast{number // 1000}/{name}"


def _friendly_error(exc: Exception, number: int | None = None) -> str:
    text = str(exc)
    text = re.sub(r"^swisseph\.\w+:\s*", "", text)
    if number is not None and "not found" in text:
        hint = asteroid_file_hint(number)
        if hint:
            return f"缺少星历文件：请把 {hint.split('/')[-1]} 放到 common/astro/ephe/{hint.rsplit('/', 1)[0]}/ 里（{text}）"
    return text


def calculate_asteroids(
    context: AstroContext,
    items: Iterable[Mapping[str, Any]],
    *,
    ecliptic_mode: str,
    ayanamsha_mode: str | int,
) -> tuple[dict[str, dict[str, Any]], list[dict[str, str]]]:
    """计算一组小行星。items 的每一项至少有 number，可带 label。

    返回 (结果, 错误列表)。结果的键是页面上显示的名字；某一颗算不出来时
    只把它放进错误列表，其余照常返回。
    """
    results: dict[str, dict[str, Any]] = {}
    errors: list[dict[str, str]] = []
    with _SWISS_LOCK:
        set_ephemeris_path(context.ephe_path)
        flags = _position_flags(ecliptic_mode, ayanamsha_mode)
        for item in items:
            number = int(item["number"])
            label = str(item.get("label") or "").strip()
            key = f"{label} #{number}" if label and label != f"#{number}" else f"#{number}"
            try:
                data = _calc_body(context.jd_utc, asteroid_body_id(number), flags, key)
            except (swe.Error, FileNotFoundError, ValueError) as exc:
                errors.append({"label": label or f"#{number}", "error": _friendly_error(exc, number)})
                continue
            results[key] = {**data, "number": number}
    return results, errors


def check_asteroid(number: int, *, ephe_path: str | Path | None = None) -> dict[str, Any]:
    """新增小行星前检查：Swiss Ephemeris 里的名字，以及星历文件是否可用。

    文件不在时 ok=False 并给出应放置的位置（仍然允许添加，放好文件后即可计算）。
    """
    body = asteroid_body_id(number)
    result: dict[str, Any] = {"number": int(number), "name": "", "ok": True, "error": "",
                              "file": asteroid_file_hint(number)}
    with _SWISS_LOCK:
        set_ephemeris_path(ephe_path)
        jd = swe.julday(2000, 1, 1, 12.0)
        try:
            xx, ret_flag, serr = _unpack_calc(swe.calc_ut(jd, body, swe.FLG_SWIEPH))
            _check_ephemeris_result(ret_flag, swe.FLG_SWIEPH, f"#{number}", serr=serr)
        except (swe.Error, FileNotFoundError) as exc:
            result["ok"] = False
            result["error"] = _friendly_error(exc, int(number))
        try:
            result["name"] = str(swe.get_planet_name(body) or "").strip()
        except swe.Error:
            pass
    return result


def _unpack_calc(raw):
    xx = raw[0]
    ret_flag = raw[1] if len(raw) > 1 and isinstance(raw[1], int) else None
    serr = raw[2] if len(raw) > 2 and isinstance(raw[2], str) else ""
    return xx, ret_flag, serr


# ---------------------------------------------------------------- 恒星

def _star_query_ok(query: str) -> str:
    query = " ".join(str(query or "").split())
    if not query:
        raise ValueError("恒星名称不能为空。")
    # Swiss Ephemeris 把纯数字当作 sefstars.txt 里的“第几颗星”，容易误用，这里不接受。
    if query.isdigit():
        raise ValueError("请输入恒星名称（如 Regulus）或命名（如 ,alLeo），不要只输入数字。")
    return query


def check_star(query: str, *, ephe_path: str | Path | None = None) -> dict[str, Any]:
    """在 sefstars.txt 里查找恒星，返回规范的查询串、文件里的名字和星等。找不到时报错。"""
    query = _star_query_ok(query)
    with _SWISS_LOCK:
        set_ephemeris_path(ephe_path)
        try:
            mag, stnam = swe.fixstar2_mag(query)
        except swe.Error as exc:
            raise ValueError(f"在 sefstars.txt 里找不到恒星「{query}」：{_friendly_error(exc)}") from exc
    traditional, _, nomenclature = str(stnam).partition(",")
    # 以命名（如 ,alLeo）作为保存的查询串：同一颗星的多个传统名都指向同一行。
    canonical = f",{nomenclature.strip()}" if nomenclature.strip() else traditional.strip()
    return {
        "query": canonical,
        "name": traditional.strip(),
        "nomenclature": nomenclature.strip(),
        "magnitude": float(mag),
    }


def calculate_fixed_stars(
    context: AstroContext,
    items: Iterable[Mapping[str, Any]],
    *,
    ecliptic_mode: str,
    ayanamsha_mode: str | int,
) -> tuple[dict[str, dict[str, Any]], list[dict[str, str]]]:
    """计算一组恒星（含岁差、自行、章动、光行差）。items 的每一项有 query，可带 label。"""
    results: dict[str, dict[str, Any]] = {}
    errors: list[dict[str, str]] = []
    with _SWISS_LOCK:
        set_ephemeris_path(context.ephe_path)
        flags = _position_flags(ecliptic_mode, ayanamsha_mode)
        eq_flags = (flags & ~swe.FLG_SIDEREAL) | swe.FLG_EQUATORIAL
        for item in items:
            query = str(item.get("query") or "")
            label = str(item.get("label") or "").strip() or query
            try:
                data = star_position(context.jd_utc, query, flags, eq_flags)
            except (swe.Error, FileNotFoundError, ValueError) as exc:
                errors.append({"label": label, "error": _friendly_error(exc)})
                continue
            results[label] = data
    return results, errors


def star_position(jd_utc: float, query: str, flags: int, eq_flags: int) -> dict[str, Any]:
    """单颗恒星的黄道 + 赤道坐标（调用方负责加锁、设置星历路径和岁差）。"""
    query = _star_query_ok(query)
    xx, stnam, ret_flag = swe.fixstar2_ut(query, jd_utc, flags)
    _check_ephemeris_result(ret_flag, flags, f"恒星 {query}")
    eq, _, _ = swe.fixstar2_ut(query, jd_utc, eq_flags)
    mag, _ = swe.fixstar2_mag(query)
    return {
        "lon": float(xx[0] % 360.0),
        "lat": float(xx[1]),
        "speed": float(xx[3]),        # 岁差与自行带来的每日黄经变化，非常小；判断入相 / 出相时用
        "ra": float(eq[0] % 360.0),
        "dec": float(eq[1]),
        "mag": float(mag),
        "star": str(stnam),
        "bayer": bayer_name(str(stnam).partition(",")[2]),
    }


# ---------------------------------------------------------------- 特殊点

#: 代码 → (名称, 说明)。代码同时用在 Lot 公式里。
SPECIAL_POINTS: dict[str, tuple[str, str]] = {
    "MeanApog": ("平均远月点", "黑月莉莉丝 Mean Lilith：月球平均轨道的远地点"),
    "MeanPerig": ("平均近月点", "平均远月点的对冲点（Mean Priapus）"),
    "TrueApog": ("真实远月点", "密切轨道远地点（Osculating / True Lilith）"),
    "TruePerig": ("真实近月点", "密切轨道近地点，即真实远月点的对冲点"),
    "IntpApog": ("插值远月点", "Swiss Ephemeris 的插值远地点（Natural / Interpolated Apogee）"),
    "IntpPerig": ("插值近月点", "Swiss Ephemeris 的插值近地点（Natural / Interpolated Perigee）"),
    "Syzygy": ("朔望点", "出生前最近一次新月或满月时月亮所在的位置"),
    "Vertex": ("宿命点", "Vertex：卯酉圈与黄道在西方的交点"),
    "AntiVertex": ("反宿命点", "Vertex 的对冲点"),
    "EastPoint": ("东方点", "East Point：赤道上升点"),
}

_APSIS_BODIES = {
    "MeanApog": swe.MEAN_APOG,
    "TrueApog": swe.OSCU_APOG,
    "IntpApog": swe.INTP_APOG,
    "IntpPerig": swe.INTP_PERG,
}
# 平均 / 密切近地点与对应的远地点位于同一条拱线的两端，三维方向严格相反，
# 投影到黄道上也就是黄经 +180°、黄纬取反（与 swe.nod_aps_ut 的结果一致）。
_OPPOSITE_OF = {"MeanPerig": "MeanApog", "TruePerig": "TrueApog"}


def _opposite(point: Mapping[str, float]) -> dict[str, float]:
    return {
        "lon": (point["lon"] + 180.0) % 360.0,
        "lat": -point["lat"],
        "speed": point["speed"],
        "ra": (point["ra"] + 180.0) % 360.0,
        "dec": -point["dec"],
    }


def special_point(
    context: AstroContext,
    code: str,
    *,
    ecliptic_mode: str,
    ayanamsha_mode: str | int,
    house_result: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """计算一个特殊点。Vertex / AntiVertex / EastPoint 需要传入 core.calculate_houses 的结果。"""
    if code not in SPECIAL_POINTS:
        raise ValueError(f"未知的特殊点：{code}")
    if code in ("Vertex", "AntiVertex", "EastPoint"):
        if not house_result or code not in (house_result.get("extra") or {}):
            raise ValueError(f"{code} 需要宫位计算结果。")
        return dict(house_result["extra"][code])
    if code == "Syzygy":
        return prenatal_syzygy(context, ecliptic_mode=ecliptic_mode, ayanamsha_mode=ayanamsha_mode)
    with _SWISS_LOCK:
        set_ephemeris_path(context.ephe_path)
        flags = _position_flags(ecliptic_mode, ayanamsha_mode)
        if code in _OPPOSITE_OF:
            base = _calc_body(context.jd_utc, _APSIS_BODIES[_OPPOSITE_OF[code]], flags, code)
            return _opposite(base)
        return _calc_body(context.jd_utc, _APSIS_BODIES[code], flags, code)


def calculate_special_points(
    context: AstroContext,
    codes: Iterable[str],
    *,
    ecliptic_mode: str,
    ayanamsha_mode: str | int,
    house_result: Mapping[str, Any] | None = None,
) -> tuple[dict[str, dict[str, Any]], list[dict[str, str]]]:
    results: dict[str, dict[str, Any]] = {}
    errors: list[dict[str, str]] = []
    for code in codes:
        label = SPECIAL_POINTS[code][0]
        try:
            results[label] = {
                **special_point(
                    context, code, ecliptic_mode=ecliptic_mode,
                    ayanamsha_mode=ayanamsha_mode, house_result=house_result,
                ),
                "code": code,
            }
        except (swe.Error, FileNotFoundError, ValueError) as exc:
            errors.append({"label": label, "error": _friendly_error(exc)})
    return results, errors


def _elongation(jd: float) -> tuple[float, float]:
    """月亮减太阳的黄经差（0–360）及其每日变化率。只是差值，与黄道体系无关。"""
    flags = swe.FLG_SWIEPH | swe.FLG_SPEED
    sun, sflag, serr = _unpack_calc(swe.calc_ut(jd, swe.SUN, flags))
    _check_ephemeris_result(sflag, flags, "朔望点（太阳）", serr=serr)
    moon, mflag, merr = _unpack_calc(swe.calc_ut(jd, swe.MOON, flags))
    _check_ephemeris_result(mflag, flags, "朔望点（月亮）", serr=merr)
    return (moon[0] - sun[0]) % 360.0, moon[3] - sun[3]


def prenatal_syzygy(
    context: AstroContext,
    *,
    ecliptic_mode: str,
    ayanamsha_mode: str | int,
) -> dict[str, Any]:
    """出生前最近一次朔（新月）或望（满月），返回那一刻月亮的位置。

    新月时日月同度，取月亮即可；满月时取月亮的位置（不采用托勒密“取地平线上的发光体”的变体）。
    """
    with _SWISS_LOCK:
        set_ephemeris_path(context.ephe_path)
        elong, _ = _elongation(context.jd_utc)
        target = 0.0 if elong < 180.0 else 180.0
        kind = "新月" if target == 0.0 else "满月"
        # 出生时刻刚好是朔望：就是它本身；否则从平均月相速度估一个起点，再用牛顿法收敛。
        jd = context.jd_utc - (elong - target) / 12.190749
        for _ in range(30):
            e, rate = _elongation(jd)
            diff = (e - target + 180.0) % 360.0 - 180.0
            step = diff / rate
            jd -= step
            if abs(step) < 1e-9:
                break
        else:
            raise RuntimeError("朔望点迭代没有收敛。")
        if jd > context.jd_utc + 1e-9:
            raise RuntimeError("朔望点计算出现异常（结果晚于出生时刻）。")
        flags = _position_flags(ecliptic_mode, ayanamsha_mode)
        moon = _calc_body(jd, swe.MOON, flags, "朔望点")
    tz = context.local_dt.tzinfo
    return {
        **moon,
        # 朔望点是一个已经过去的时刻里月亮的位置，固定不动：速度为 0（判断入相 / 出相时只看行星的运动）。
        "speed": 0.0,
        "type": kind,
        "time": _jd_to_local(jd, tz).isoformat(timespec="seconds"),
    }


# ---------------------------------------------------------------- 日夜

def sun_above_horizon(context: AstroContext, rule: str = "geometric") -> bool:
    """出生时太阳是否在地平线以上：日生盘为 True。

    rule：geometric 太阳中心的几何高度 > 0（不计大气折射）；
          apparent  太阳中心的视高度 > 0（按标准大气 1013.25 hPa、15 °C 计入折射，约提前 / 推后 2–3 分钟）。
    """
    with _SWISS_LOCK:
        set_ephemeris_path(context.ephe_path)
        flags = swe.FLG_SWIEPH | swe.FLG_EQUATORIAL
        eq, ret_flag, serr = _unpack_calc(swe.calc_ut(context.jd_utc, swe.SUN, flags))
        _check_ephemeris_result(ret_flag, flags, "太阳（日夜判断）", serr=serr)
        _, true_alt, app_alt = swe.azalt(
            context.jd_utc, swe.EQU2HOR, (context.lon, context.lat, 0.0), 1013.25, 15.0,
            (eq[0], eq[1], eq[2]),
        )
    return float(app_alt if rule == "apparent" else true_alt) > 0.0


# ---------------------------------------------------------------- 恒星的拜耳命名

_GREEK = {
    "al": "α", "be": "β", "ga": "γ", "de": "δ", "ep": "ε", "ze": "ζ", "et": "η", "th": "θ",
    "io": "ι", "ka": "κ", "la": "λ", "mu": "μ", "nu": "ν", "xi": "ξ", "omi": "ο", "pi": "π",
    "rh": "ρ", "si": "σ", "ta": "τ", "up": "υ", "ph": "φ", "ch": "χ", "ps": "ψ", "ome": "ω",
}
_SUPERSCRIPT = str.maketrans("0123456789", "⁰¹²³⁴⁵⁶⁷⁸⁹")
_BAYER_RE = re.compile(r"^(ome|omi|al|be|ga|de|ep|ze|et|th|io|ka|la|mu|nu|xi|pi|rh|si|ta|up|ph|ch|ps)(?:-(\d))?([A-Z][A-Za-z]{2})$")


def bayer_name(nomenclature: str) -> str:
    """sefstars.txt 的命名 → 拜耳命名：bePer → β Per，al-2Lib → α² Lib；
    不是拜耳命名的（弗兰斯蒂德编号、梅西耶天体等）原样返回，如 61Cyg → 61 Cyg。"""
    text = str(nomenclature or "").strip()
    m = _BAYER_RE.match(text)
    if m:
        return f"{_GREEK[m.group(1)]}{(m.group(2) or '').translate(_SUPERSCRIPT)} {m.group(3)}"
    m = re.match(r"^(\d+)([A-Z][A-Za-z]{2})$", text)
    if m:
        return f"{m.group(1)} {m.group(2)}"
    return text
