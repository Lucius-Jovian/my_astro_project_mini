"""可按依赖局部重算的占星底座。

本模块只负责输入解析、Swiss Ephemeris 坐标/宫位计算，以及依赖时间的
日出日落、值日星和行星时。具体占星技法（西占、印占等）的查表与象意逻辑
都不在这里：它们应该写成独立模块，单向依赖本模块，而不是反过来。
"""

from __future__ import annotations

import re
import threading
import warnings
from dataclasses import asdict, dataclass
from datetime import date, datetime, time, timedelta, timezone
from importlib.resources import files
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

import swisseph as swe


_SWISS_LOCK = threading.RLock()
_ACTIVE_EPHE_PATH: str | None = None

MAIN_PLANETS: dict[str, int] = {
    "Su": swe.SUN,
    "Mo": swe.MOON,
    "Me": swe.MERCURY,
    "Ve": swe.VENUS,
    "Ma": swe.MARS,
    "Ju": swe.JUPITER,
    "Sa": swe.SATURN,
    "Ur": swe.URANUS,
    "Ne": swe.NEPTUNE,
    "Pl": swe.PLUTO,
}

MINOR_PLANETS: dict[str, int] = {
    "Ch": swe.CHIRON,
    "Ph": swe.PHOLUS,
    "Ce": swe.CERES,
    "Pa": swe.PALLAS,
    "Jn": swe.JUNO,
    "Vs": swe.VESTA,
}

HOUSE_SYSTEMS: dict[str, bytes] = {
    "Placidus": b"P",
    "Koch": b"K",
    "Regiomontanus": b"R",
    "Whole Sign": b"W",
    "Equal": b"E",
    "Campanus": b"C",
    "Alcabitius": b"B",
    "Porphyry": b"O",
    "Morinus": b"M",
    "Topocentric": b"T",
    "Vehlow": b"V",
    "Meridian": b"X",
    "Horizon": b"H",
    "Krusinski": b"U",
    "Carter": b"F",
    "Equal/MC": b"D",
    "Equal/Zodiac": b"N",
    "APC": b"Y",
    "Sunshine": b"I",
    "Sunshine (Makransky)": b"i",
    "Pullen SD": b"L",
    "Pullen SR": b"Q",
    "Sripati": b"S",
}

# datetime.weekday(): Monday == 0
WEEKDAY_LORDS: dict[int, str] = {
    0: "Mo",
    1: "Ma",
    2: "Me",
    3: "Ju",
    4: "Ve",
    5: "Sa",
    6: "Su",
}
CHALDEAN_ORDER: tuple[str, ...] = ("Sa", "Ju", "Ma", "Su", "Ve", "Me", "Mo")


@dataclass(frozen=True)
class AstroContext:
    """一次计算共享的时间与地理底座。

    ``local_dt`` 与 ``utc_dt`` 都是带时区的 datetime；``tz_offset`` 为小时数。
    本地 Web 层需要 JSON 时可使用 :meth:`to_dict`。
    """

    jd_utc: float
    lat: float
    lon: float
    eps: float
    local_dt: datetime
    utc_dt: datetime
    tz_offset: float
    elevation: float = 0.0
    atpress: float = 1013.25
    attemp: float = 10.0
    calendar: str = "g"
    ephe_path: str | None = None

    def to_dict(self, *, json_safe: bool = True) -> dict[str, Any]:
        result = asdict(self)
        if json_safe:
            result["local_dt"] = self.local_dt.isoformat()
            result["utc_dt"] = self.utc_dt.isoformat()
        return result


def set_ephemeris_path(ephe_path: str | Path | None = None) -> str | None:
    """设置并记住星历目录；未传路径时仅进行一次内置目录初始化。"""
    global _ACTIVE_EPHE_PATH
    with _SWISS_LOCK:
        if ephe_path is not None:
            if str(ephe_path) == "":
                swe.set_ephe_path("")
                _ACTIVE_EPHE_PATH = ""
            else:
                resolved = str(Path(ephe_path).expanduser().resolve())
                swe.set_ephe_path(resolved)
                _ACTIVE_EPHE_PATH = resolved
        elif _ACTIVE_EPHE_PATH is None:
            try:
                package_name = (__package__ or "quant_astro").split(".")[0]
                bundled = str(files(package_name).joinpath("ephe"))
                if Path(bundled).is_dir():
                    swe.set_ephe_path(bundled)
                    _ACTIVE_EPHE_PATH = bundled
            except (ModuleNotFoundError, FileNotFoundError, TypeError):
                pass
            if _ACTIVE_EPHE_PATH is None:
                # 显式记录并恢复“无数据目录”状态，防止旧上下文意外沿用后来设置的路径。
                swe.set_ephe_path("")
                _ACTIVE_EPHE_PATH = ""
    return _ACTIVE_EPHE_PATH


def decimal_to_dms(value: float) -> dict[str, float | int | str]:
    """将十进制度数转为结构化 DMS；负号保留在度数与字符串中。"""
    sign = -1 if value < 0 else 1
    absolute = abs(float(value))
    total_centiseconds = round(absolute * 3600.0 * 100.0)
    degrees, remainder = divmod(total_centiseconds, 3600 * 100)
    minutes, centiseconds = divmod(remainder, 60 * 100)
    seconds = centiseconds / 100.0
    signed_degrees = degrees * sign
    prefix = "-" if sign < 0 else ""
    return {
        "d": signed_degrees,
        "m": minutes,
        "s": seconds,
        "str": f'{prefix}{degrees}°{minutes:02d}\'{seconds:05.2f}"',
    }


def _parse_timezone(value: str | float | int) -> float:
    if isinstance(value, (int, float)):
        offset = float(value)
    else:
        text = str(value).strip()
        match = re.fullmatch(r"([+-]?)(\d{1,2})(?::(\d{1,2})|\.(\d+))?", text)
        if not match:
            raise ValueError(f"无法解析时区 {value!r}；支持 +8、-5:30、+5.5。")
        sign = -1.0 if match.group(1) == "-" else 1.0
        hours = float(match.group(2))
        if match.group(3) is not None:
            minutes = int(match.group(3))
            if minutes >= 60:
                raise ValueError("时区分钟必须小于 60。")
            hours += minutes / 60.0
        elif match.group(4) is not None:
            hours = float(f"{match.group(2)}.{match.group(4)}")
        offset = sign * hours
    if not -14.0 <= offset <= 14.0:
        raise ValueError("时区偏移必须在 -14 到 +14 小时之间。")
    return offset


def _parse_coordinate(value: str | float | int, *, latitude: bool) -> float:
    if isinstance(value, (int, float)):
        result = float(value)
    else:
        text = str(value).strip().upper()
        parts = re.findall(r"\d+(?:\.\d+)?", text)
        if not parts:
            raise ValueError(f"无法解析坐标 {value!r}。")
        degrees = float(parts[0])
        minutes = float(parts[1]) if len(parts) > 1 else 0.0
        seconds = float(parts[2]) if len(parts) > 2 else 0.0
        if minutes >= 60 or seconds >= 60:
            raise ValueError(f"坐标分、秒必须小于 60：{value!r}")
        result = degrees + minutes / 60.0 + seconds / 3600.0
        if "-" in text or any(mark in text for mark in ("S", "W", "南", "西")):
            result = -result
    limit = 90.0 if latitude else 180.0
    if not -limit <= result <= limit:
        kind = "纬度" if latitude else "经度"
        raise ValueError(f"{kind}超出有效范围：{result}")
    return result


def _parse_civil_datetime(value: str | datetime, calendar: str) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    else:
        text = str(value).strip().replace("T", " ")
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError as exc:
            raise ValueError(f"无法解析本地时间 {value!r}，请使用 YYYY-MM-DD HH:MM:SS[.ffffff]。") from exc
    if parsed.tzinfo is not None:
        raise ValueError("local_time_str 应是不带时区的当地钟表时间；时区请由 timezone_str 单独传入。")

    cal = calendar.lower()
    if cal not in {"g", "j"}:
        raise ValueError("calendar 只能是 'g'（格里历）或 'j'（儒略历）。")
    if cal == "g":
        return parsed

    hour = (
        parsed.hour
        + parsed.minute / 60.0
        + parsed.second / 3600.0
        + parsed.microsecond / 3_600_000_000.0
    )
    jd = swe.julday(parsed.year, parsed.month, parsed.day, hour, swe.JUL_CAL)
    year, month, day_, hour_decimal = swe.revjul(jd, swe.GREG_CAL)
    midnight = datetime(int(year), int(month), int(day_))
    return midnight + timedelta(hours=hour_decimal)


def _datetime_to_jd(dt_utc: datetime) -> float:
    dt = dt_utc.astimezone(timezone.utc)
    hour = dt.hour + dt.minute / 60.0 + dt.second / 3600.0 + dt.microsecond / 3_600_000_000.0
    return swe.julday(dt.year, dt.month, dt.day, hour, swe.GREG_CAL)


def _jd_to_local(jd_utc: float, tzinfo: timezone) -> datetime:
    year, month, day_, hour_decimal = swe.revjul(jd_utc, swe.GREG_CAL)
    dt_utc = datetime(int(year), int(month), int(day_), tzinfo=timezone.utc) + timedelta(hours=hour_decimal)
    return dt_utc.astimezone(tzinfo)


def parse_time_geo(
    local_time_str: str | datetime,
    timezone_str: str | float,
    latitude_str: str | float,
    longitude_str: str | float,
    *,
    calendar: str = "g",
    elevation: float = 0.0,
    atpress: float = 1013.25,
    attemp: float = 10.0,
    ephe_path: str | Path | None = None,
) -> AstroContext:
    """解析时间与地理输入，返回所有后续函数共享的不可变上下文。"""
    tz_offset = _parse_timezone(timezone_str)
    tzinfo = timezone(timedelta(hours=tz_offset))
    civil_dt = _parse_civil_datetime(local_time_str, calendar)
    local_dt = civil_dt.replace(tzinfo=tzinfo)
    utc_dt = local_dt.astimezone(timezone.utc)
    jd_utc = _datetime_to_jd(utc_dt)
    lat = _parse_coordinate(latitude_str, latitude=True)
    lon = _parse_coordinate(longitude_str, latitude=False)
    with _SWISS_LOCK:
        active_path = set_ephemeris_path(ephe_path)
        eps = float(swe.calc_ut(jd_utc, swe.ECL_NUT, 0)[0][0])
    return AstroContext(
        jd_utc=jd_utc,
        lat=lat,
        lon=lon,
        eps=eps,
        local_dt=local_dt,
        utc_dt=utc_dt,
        tz_offset=tz_offset,
        elevation=float(elevation),
        atpress=float(atpress),
        attemp=float(attemp),
        calendar=calendar.lower(),
        ephe_path=active_path,
    )


def _resolve_ayanamsha(value: str | int) -> int:
    if isinstance(value, int):
        return value
    clean = str(value).replace("swe.", "").strip().upper()
    candidates = (clean, f"SE_{clean}", clean.replace("SIDM_", "SE_SIDM_"))
    for name in candidates:
        if hasattr(swe, name):
            return int(getattr(swe, name))
    raise ValueError(f"找不到岁差模式：{value!r}")


def _position_flags(ecliptic_mode: str, ayanamsha_mode: str | int, heliocentric: bool) -> int:
    mode = ecliptic_mode.lower()
    if mode not in {"tropical", "sidereal"}:
        raise ValueError("ecliptic_mode 只能是 'tropical' 或 'sidereal'。")
    flags = swe.FLG_SWIEPH | swe.FLG_SPEED
    if mode == "sidereal":
        swe.set_sid_mode(_resolve_ayanamsha(ayanamsha_mode))
        flags |= swe.FLG_SIDEREAL
    if heliocentric:
        flags |= swe.FLG_HELCTR
    return flags


def _check_ephemeris_result(
    ret_flag: int | None,
    requested_flags: int,
    label: str,
    strict: bool,
    serr: str = "",
) -> None:
    if ret_flag is None or not (requested_flags & swe.FLG_SWIEPH):
        return
    # FLG_MOSEPH 是 pysweph/pyswisseph 的标准常量，不用 getattr(..., 0) 兜底——
    # 那样万一它哪天真的取不到，会让这个 strict_ephe=True 的安全检查悄悄失效
    # 而不是报错提醒我们，反而更危险。
    used_moshier = bool(swe.FLG_MOSEPH & ret_flag)
    missing_swiss = not bool(ret_flag & swe.FLG_SWIEPH)
    if not (used_moshier or missing_swiss):
        return
    # pysweph >= 2.10.3.3 起，calc()/calc_ut() 等函数会在返回值里多带一条
    # serr 字符串，通常直接写明具体缺了哪个星历文件，比我们自己拼的提示更准确。
    detail = f"；Swiss Ephemeris 提示：{serr}" if serr else ""
    message = (
        f"{label} 未使用 Swiss Ephemeris 高精度文件，已回退到 Moshier；"
        f"当前星历目录：{_ACTIVE_EPHE_PATH!r}{detail}。"
    )
    if strict:
        raise FileNotFoundError(message)
    warnings.warn(message, RuntimeWarning, stacklevel=3)


def _calc_body(jd_utc: float, body_id: int, flags: int, label: str, strict_ephe: bool) -> dict[str, float]:
    ecliptic_result = swe.calc_ut(jd_utc, body_id, flags)
    equatorial_result = swe.calc_ut(jd_utc, body_id, flags | swe.FLG_EQUATORIAL)
    xx = ecliptic_result[0]
    eq = equatorial_result[0]
    ret_flag = ecliptic_result[1] if len(ecliptic_result) > 1 and isinstance(ecliptic_result[1], int) else None
    # pysweph >= 2.10.3.3 的 calc_ut() 返回 (xx, retflags, serr) 三元组；
    # 旧版 pyswisseph 只有二元组，len(...) > 2 的判断让两种版本都能正常工作。
    serr = ecliptic_result[2] if len(ecliptic_result) > 2 and isinstance(ecliptic_result[2], str) else ""
    _check_ephemeris_result(ret_flag, flags, label, strict_ephe, serr=serr)
    return {
        "lon": float(xx[0] % 360.0),
        "lat": float(xx[1]),
        "speed": float(xx[3]),
        "ra": float(eq[0] % 360.0),
        "dec": float(eq[1]),
    }


def calculate_planets(
    context: AstroContext,
    selected_planets: Sequence[str] | None = None,
    *,
    ecliptic_mode: str = "sidereal",
    ayanamsha_mode: str | int = "SIDM_KRISHNAMURTI",
    node_mode: str = "mean",
    heliocentric: bool = False,
    strict_ephe: bool = True,
    ephe_path: str | Path | None = None,
) -> dict[str, dict[str, float]]:
    """仅计算主行星及交点的黄经、纬度、速度、赤经和赤纬。"""
    effective_ephe_path = ephe_path if ephe_path is not None else context.ephe_path
    requested = list(MAIN_PLANETS) + ["Ra", "Ke"] if selected_planets is None or "All" in selected_planets else list(selected_planets)
    unknown = set(requested) - set(MAIN_PLANETS) - {"Ra", "Ke"}
    if unknown:
        raise ValueError(f"未知主行星代码：{sorted(unknown)}")
    node_mode = node_mode.lower()
    if node_mode not in {"mean", "true"}:
        raise ValueError("node_mode 只能是 'mean' 或 'true'。")

    result: dict[str, dict[str, float]] = {}
    with _SWISS_LOCK:
        set_ephemeris_path(effective_ephe_path)
        base_flags = _position_flags(ecliptic_mode, ayanamsha_mode, heliocentric)
        for name in requested:
            if name in {"Ra", "Ke"} or name in result:
                continue
            result[name] = _calc_body(context.jd_utc, MAIN_PLANETS[name], base_flags, name, strict_ephe)

        if "Ra" in requested or "Ke" in requested:
            node_id = swe.TRUE_NODE if node_mode == "true" else swe.MEAN_NODE
            # 月交点是地心定义；即使其余天体使用日心，也不把 HELCTR 施加到交点。
            node_flags = base_flags & ~swe.FLG_HELCTR
            north = _calc_body(context.jd_utc, node_id, node_flags, "Ra/Ke", strict_ephe)
            if "Ra" in requested:
                result["Ra"] = north
            if "Ke" in requested:
                # 南交点是北交点在天球上的严格反点；直接反转赤道坐标，
                # 避免把恒星黄经误当作热带黄经交给 cotrans。
                result["Ke"] = {
                    "lon": (north["lon"] + 180.0) % 360.0,
                    "lat": -north["lat"],
                    "speed": north["speed"],
                    "ra": (north["ra"] + 180.0) % 360.0,
                    "dec": -north["dec"],
                }
    return {name: result[name] for name in requested if name in result}


def calculate_minor_planets(
    context: AstroContext,
    selected_minor_planets: Sequence[str] | None = None,
    *,
    ecliptic_mode: str = "sidereal",
    ayanamsha_mode: str | int = "SIDM_KRISHNAMURTI",
    heliocentric: bool = False,
    strict_ephe: bool = True,
    ephe_path: str | Path | None = None,
) -> dict[str, dict[str, float]]:
    """仅计算指定小行星的黄经、纬度、速度、赤经和赤纬。"""
    effective_ephe_path = ephe_path if ephe_path is not None else context.ephe_path
    requested = list(selected_minor_planets or ())
    unknown = set(requested) - set(MINOR_PLANETS)
    if unknown:
        raise ValueError(f"未知小行星代码：{sorted(unknown)}；可用值：{sorted(MINOR_PLANETS)}")
    result: dict[str, dict[str, float]] = {}
    with _SWISS_LOCK:
        set_ephemeris_path(effective_ephe_path)
        flags = _position_flags(ecliptic_mode, ayanamsha_mode, heliocentric)
        for name in requested:
            result[name] = _calc_body(context.jd_utc, MINOR_PLANETS[name], flags, name, strict_ephe)
    return result


def calculate_fixed_stars(
    context_or_jd: AstroContext | float,
    selected_stars: Iterable[str],
    *,
    ecliptic_mode: str = "tropical",
    ayanamsha_mode: str | int = "SIDM_KRISHNAMURTI",
    strict_ephe: bool = True,
    skip_errors: bool = False,
    ephe_path: str | Path | None = None,
) -> dict[str, dict[str, float]]:
    """仅计算恒星的黄经、纬度、速度、赤经和赤纬。"""
    context_path = context_or_jd.ephe_path if isinstance(context_or_jd, AstroContext) else None
    effective_ephe_path = ephe_path if ephe_path is not None else context_path
    jd_utc = context_or_jd.jd_utc if isinstance(context_or_jd, AstroContext) else float(context_or_jd)
    result: dict[str, dict[str, float]] = {}
    with _SWISS_LOCK:
        set_ephemeris_path(effective_ephe_path)
        flags = _position_flags(ecliptic_mode, ayanamsha_mode, False)
        for star_name in selected_stars:
            try:
                ecliptic_result = swe.fixstar2_ut(star_name, jd_utc, flags)
                equatorial_result = swe.fixstar2_ut(star_name, jd_utc, flags | swe.FLG_EQUATORIAL)
                xx, eq = ecliptic_result[0], equatorial_result[0]
                ret_flag = ecliptic_result[2] if len(ecliptic_result) > 2 else None
                _check_ephemeris_result(ret_flag, flags, f"恒星 {star_name}", strict_ephe)
                result[star_name] = {
                    "lon": float(xx[0] % 360.0),
                    "lat": float(xx[1]),
                    "speed": float(xx[3]),
                    "ra": float(eq[0] % 360.0),
                    "dec": float(eq[1]),
                }
            except Exception as exc:
                if not skip_errors:
                    raise ValueError(f"恒星 {star_name!r} 计算失败：{exc}") from exc
    return result


def _extract_12(values: Sequence[float]) -> list[float]:
    if len(values) >= 13:
        return [float(value) for value in values[1:13]]
    if len(values) == 12:
        return [float(value) for value in values]
    raise RuntimeError(f"宫位函数返回了非预期长度：{len(values)}")


def _house_flags(ecliptic_mode: str, ayanamsha_mode: str | int) -> int:
    mode = ecliptic_mode.lower()
    if mode == "sidereal":
        swe.set_sid_mode(_resolve_ayanamsha(ayanamsha_mode))
        return swe.FLG_SIDEREAL
    if mode == "tropical":
        return 0
    raise ValueError("ecliptic_mode 只能是 'tropical' 或 'sidereal'。")


def _ecliptic_point(
    longitude: float,
    speed: float,
    eps: float,
    ayanamsha: float,
) -> dict[str, float]:
    """把宫头/轴点统一转换为与行星相同的坐标结构。"""
    longitude %= 360.0
    # houses_ex2 的恒星黄经先加回同一时刻、同一 flags 的岁差值，
    # 再转换为物理上对应点的赤经赤纬。
    tropical_longitude = (longitude + ayanamsha) % 360.0
    equatorial = swe.cotrans((tropical_longitude, 0.0, 1.0), -eps)
    return {
        "lon": longitude,
        "lat": 0.0,
        "speed": float(speed),
        "ra": float(equatorial[0] % 360.0),
        "dec": float(equatorial[1]),
    }


def calculate_houses(
    context: AstroContext,
    house_system: str = "Placidus",
    *,
    ecliptic_mode: str = "sidereal",
    ayanamsha_mode: str | int = "SIDM_KRISHNAMURTI",
    jd_utc: float | None = None,
    ephe_path: str | Path | None = None,
) -> dict[str, Any]:
    """独立计算 12 宫头、四轴和 Swiss Ephemeris 辅助轴点。

    返回结构：
        ``houses``: ``house 1`` 至 ``house 12``；
        ``axes``: Asc / Desc / MC / IC 四轴；
        ``auxiliary_points``: ARMC、Vertex 及 Swiss Ephemeris 其余轴点。

    Whole Sign、Equal 等宫位制下，MC 不一定等于第 10 宫宫头，因此四轴
    必须直接取 ``ascmc``，不能从宫头推断。
    """
    if house_system == "Gauquelin":
        raise ValueError("Gauquelin 返回 36 个 sector，不属于 12 宫接口。")
    if house_system not in HOUSE_SYSTEMS:
        raise ValueError(f"未知宫位制 {house_system!r}；可用值：{sorted(HOUSE_SYSTEMS)}")

    target_jd = context.jd_utc if jd_utc is None else float(jd_utc)
    effective_ephe_path = ephe_path if ephe_path is not None else context.ephe_path
    with _SWISS_LOCK:
        # 宫位是可被单独局部刷新的公开入口，因此必须自行恢复星历路径和岁差状态。
        set_ephemeris_path(effective_ephe_path)
        flags = _house_flags(ecliptic_mode, ayanamsha_mode)
        raw = swe.houses_ex2(
            target_jd,
            context.lat,
            context.lon,
            HOUSE_SYSTEMS[house_system],
            flags=flags,
        )
        cusps = _extract_12(raw[0])
        ascmc = [float(value) for value in raw[1]]
        cusp_speeds = _extract_12(raw[2])
        ascmc_speeds = [float(value) for value in raw[3]]
        target_eps = float(swe.calc_ut(target_jd, swe.ECL_NUT, 0)[0][0])
        ayanamsha = (
            float(swe.get_ayanamsa_ex_ut(target_jd, flags)[1])
            if ecliptic_mode.lower() == "sidereal"
            else 0.0
        )

        houses = {
            f"house {index}": _ecliptic_point(longitude, speed, target_eps, ayanamsha)
            for index, (longitude, speed) in enumerate(zip(cusps, cusp_speeds), start=1)
        }

        asc = _ecliptic_point(ascmc[0], ascmc_speeds[0], target_eps, ayanamsha)
        mc = _ecliptic_point(ascmc[1], ascmc_speeds[1], target_eps, ayanamsha)
        desc = _ecliptic_point(
            (ascmc[0] + 180.0) % 360.0,
            ascmc_speeds[0],
            target_eps,
            ayanamsha,
        )
        ic = _ecliptic_point(
            (ascmc[1] + 180.0) % 360.0,
            ascmc_speeds[1],
            target_eps,
            ayanamsha,
        )
        axes = {"Asc": asc, "Desc": desc, "MC": mc, "IC": ic}

        auxiliary_points = {
            # ARMC 是赤道坐标角，不是黄经，故不伪装成 lon/ra/dec 坐标结构。
            "ARMC": {"angle": ascmc[2] % 360.0, "speed": ascmc_speeds[2]},
            "Vertex": _ecliptic_point(ascmc[3], ascmc_speeds[3], target_eps, ayanamsha),
            "Equatorial Ascendant": _ecliptic_point(
                ascmc[4], ascmc_speeds[4], target_eps, ayanamsha
            ),
            "Co-Ascendant (Koch)": _ecliptic_point(
                ascmc[5], ascmc_speeds[5], target_eps, ayanamsha
            ),
            "Co-Ascendant (Munkasey)": _ecliptic_point(
                ascmc[6], ascmc_speeds[6], target_eps, ayanamsha
            ),
            "Polar Ascendant": _ecliptic_point(
                ascmc[7], ascmc_speeds[7], target_eps, ayanamsha
            ),
        }

    return {
        "house_system": house_system,
        "ecliptic_mode": ecliptic_mode.lower(),
        "jd_utc": target_jd,
        "houses": houses,
        "axes": axes,
        "auxiliary_points": auxiliary_points,
    }


def _coerce_date(value: date | datetime | str | None, default: date) -> date:
    if value is None:
        return default
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value))


def _sun_event(
    context: AstroContext,
    target_date: date,
    event_flag: int,
    style_flags: int,
) -> tuple[float, datetime]:
    local_midnight = datetime.combine(target_date, time.min, tzinfo=context.local_dt.tzinfo)
    jd_start = _datetime_to_jd(local_midnight.astimezone(timezone.utc))
    result_flag, event_times = swe.rise_trans(
        jd_start,
        swe.SUN,
        event_flag | style_flags,
        (context.lon, context.lat, context.elevation),
        context.atpress,
        context.attemp,
        swe.FLG_SWIEPH,
    )
    event_jd = float(event_times[0])
    if result_flag < 0 or event_jd <= 1.0:
        event_name = "日出" if event_flag == swe.CALC_RISE else "日落"
        raise ValueError(f"{target_date} 无法计算{event_name}（可能处于极昼/极夜区域）。")
    return event_jd, _jd_to_local(event_jd, context.local_dt.tzinfo)


def calculate_sunrise_sunset(
    context: AstroContext,
    target_date: date | datetime | str | None = None,
    *,
    rsmi: int | None = None,
    ephe_path: str | Path | None = None,
) -> dict[str, Any]:
    """统一、精确计算指定当地日期的日出和日落。"""
    effective_ephe_path = ephe_path if ephe_path is not None else context.ephe_path
    local_date = _coerce_date(target_date, context.local_dt.date())
    user_flags = swe.BIT_DISC_CENTER if rsmi is None else int(rsmi)
    style_flags = user_flags & ~(swe.CALC_RISE | swe.CALC_SET)
    with _SWISS_LOCK:
        set_ephemeris_path(effective_ephe_path)
        rise_jd, sunrise = _sun_event(context, local_date, swe.CALC_RISE, style_flags)
        set_jd, sunset = _sun_event(context, local_date, swe.CALC_SET, style_flags)
    if sunrise.date() != local_date or sunset.date() != local_date:
        raise ValueError(
            f"{local_date} 当地并非同时存在日出和日落（可能处于极昼/极夜过渡期）；"
            "不会用相邻日期事件冒充当天事件。"
        )
    return {
        "date": local_date.isoformat(),
        "sunrise_local": sunrise,
        "sunset_local": sunset,
        "sunrise_jd_utc": rise_jd,
        "sunset_jd_utc": set_jd,
    }


def calculate_day_lord(
    context: AstroContext,
    sun_events: Mapping[str, Any] | None = None,
    *,
    rsmi: int | None = None,
) -> dict[str, Any]:
    """按“日出换日”规则计算迦勒底值日星。"""
    events = dict(sun_events) if sun_events is not None else calculate_sunrise_sunset(context, rsmi=rsmi)
    sunrise = events["sunrise_local"]
    if isinstance(sunrise, str):
        sunrise = datetime.fromisoformat(sunrise)
    before_sunrise = context.local_dt < sunrise
    astrological_date = context.local_dt.date() - timedelta(days=1 if before_sunrise else 0)
    return {
        "day_lord": WEEKDAY_LORDS[astrological_date.weekday()],
        "astrological_date": astrological_date.isoformat(),
        "is_before_sunrise": before_sunrise,
        "sunrise_local": sunrise,
    }


def calculate_planetary_hour(
    context: AstroContext,
    *,
    rsmi: int | None = None,
    ephe_path: str | Path | None = None,
) -> dict[str, Any]:
    """按昼、夜各十二等分计算当前行星时。"""
    effective_ephe_path = ephe_path if ephe_path is not None else context.ephe_path
    today = calculate_sunrise_sunset(context, rsmi=rsmi, ephe_path=effective_ephe_path)
    sunrise_today = today["sunrise_local"]
    sunset_today = today["sunset_local"]

    if context.local_dt < sunrise_today:
        previous = calculate_sunrise_sunset(
            context, context.local_dt.date() - timedelta(days=1), rsmi=rsmi, ephe_path=effective_ephe_path
        )
        period_start, period_end = previous["sunset_local"], sunrise_today
        astrological_date = context.local_dt.date() - timedelta(days=1)
        daytime = False
        base_offset = 12
    elif context.local_dt >= sunset_today:
        following = calculate_sunrise_sunset(
            context, context.local_dt.date() + timedelta(days=1), rsmi=rsmi, ephe_path=effective_ephe_path
        )
        period_start, period_end = sunset_today, following["sunrise_local"]
        astrological_date = context.local_dt.date()
        daytime = False
        base_offset = 12
    else:
        period_start, period_end = sunrise_today, sunset_today
        astrological_date = context.local_dt.date()
        daytime = True
        base_offset = 0

    hour_seconds = (period_end - period_start).total_seconds() / 12.0
    elapsed = max(0.0, (context.local_dt - period_start).total_seconds())
    period_index = min(11, int(elapsed / hour_seconds))
    hour_number = base_offset + period_index + 1
    day_lord = WEEKDAY_LORDS[astrological_date.weekday()]
    lord_index = CHALDEAN_ORDER.index(day_lord)
    planetary_lord = CHALDEAN_ORDER[(lord_index + hour_number - 1) % 7]
    hour_start = period_start + timedelta(seconds=period_index * hour_seconds)
    hour_end = period_start + timedelta(seconds=(period_index + 1) * hour_seconds)

    return {
        "planetary_hour_lord": planetary_lord,
        "day_lord": day_lord,
        "astrological_date": astrological_date.isoformat(),
        "is_day_time": daytime,
        "hour_number": hour_number,
        "period_hour": period_index + 1,
        "hour_start": hour_start,
        "hour_end": hour_end,
        "hour_length_seconds": hour_seconds,
    }
