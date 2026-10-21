"""共用的天文基础设施（印度占星、西方占星都用这一份）。

负责：输入解析（时间、时区、经纬度、历法）、Swiss Ephemeris 的星历路径与线程安全、
行星 / 交点位置、宫位与四轴、日出日落、值日星、行星时。

黄道体系只在这里起作用：calculate_planets / calculate_houses 必须显式传入
ecliptic_mode（"tropical" 或 "sidereal"）。输出只是一组黄经数据，各占星体系自己决定怎么用。

依赖方向是单向的：systems/ 下的各占星体系依赖本模块，本模块绝不 import 任何体系的代码。
各体系需要用到的内部帮助函数（_SWISS_LOCK、_calc_body、_position_flags 等）也从这里引用，
改动这些函数时请照顾到所有体系。
"""

from __future__ import annotations

import os
import re
import threading
from dataclasses import asdict, dataclass
from datetime import date, datetime, time, timedelta, timezone
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

# 日出日落计算用的大气折射参数。界面上已去掉海拔/气压/气温三个输入项，
# 这里固定使用原来页面的默认值，保证去掉选项前后的日出日落结果一致。
SUNRISE_ELEVATION_M: float = 0.0
SUNRISE_ATPRESS_HPA: float = 1013.25
SUNRISE_ATTEMP_C: float = 20.0


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
    calendar: str = "g"
    ephe_path: str | None = None

    def to_dict(self, *, json_safe: bool = True) -> dict[str, Any]:
        result = asdict(self)
        if json_safe:
            result["local_dt"] = self.local_dt.isoformat()
            result["utc_dt"] = self.utc_dt.isoformat()
        return result


# Swiss Ephemeris 的内部状态（星历路径、岁差模式、打开的文件）在 pysweph 里是“每个线程一份”：
# 在一个线程里 set_ephe_path，另一个线程完全看不到，会退回默认路径
# （小行星、恒星就找不到文件；行星则可能悄悄改用 Moshier）。Flask 是多线程的，
# 每个请求都可能跑在新线程里，所以这里记住“进程级的目标路径”，
# 再在每个线程第一次用到时（或路径变了时）把它真正设置进 Swiss Ephemeris。
_THREAD_STATE = threading.local()
_DEFAULT_EPHE_PATH: str | None = None


# 星历目录：默认是本文件旁边的 ephe/（sefstars.txt、sepl_*.se1、semo_*.se1、seas_*.se1，
# 以及 ast0/、ast1/… 子目录里的单独小行星文件）。也可以用环境变量 ASTRO_EPHE_PATH 指到别处。
EPHE_DIR = Path(__file__).resolve().parent / "ephe"


def _bundled_ephe_path() -> str:
    override = os.environ.get("ASTRO_EPHE_PATH")
    if override and Path(override).is_dir():
        return str(Path(override).expanduser().resolve())
    # 显式记录“无数据目录”状态，防止旧上下文意外沿用后来设置的路径。
    return str(EPHE_DIR) if EPHE_DIR.is_dir() else ""


def set_ephemeris_path(ephe_path: str | Path | None = None) -> str | None:
    """设置星历目录并在当前线程生效；返回实际使用的目录。

    传入路径：之后整个进程默认都用这个目录；不传：用之前设置过的目录，
    从没设置过就用 common/astro/ephe（或环境变量 ASTRO_EPHE_PATH）。
    """
    global _ACTIVE_EPHE_PATH, _DEFAULT_EPHE_PATH
    with _SWISS_LOCK:
        if ephe_path is not None:
            target = "" if str(ephe_path) == "" else str(Path(ephe_path).expanduser().resolve())
            _DEFAULT_EPHE_PATH = target
        else:
            if _DEFAULT_EPHE_PATH is None:
                _DEFAULT_EPHE_PATH = _bundled_ephe_path()
            target = _DEFAULT_EPHE_PATH
        if getattr(_THREAD_STATE, "ephe_path", None) != target:
            swe.set_ephe_path(target)
            _THREAD_STATE.ephe_path = target
        _ACTIVE_EPHE_PATH = target
    return target


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


_CIVIL_RE = re.compile(
    r"^\s*(\d{1,4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d{1,6}))?)?\s*$"
)


def _days_in_month(year: int, month: int, calendar: str) -> int:
    if month == 2:
        leap = year % 4 == 0 if calendar == "j" else (year % 4 == 0 and (year % 100 != 0 or year % 400 == 0))
        return 29 if leap else 28
    return 30 if month in (4, 6, 9, 11) else 31


def _parse_civil_datetime(value: str | datetime, calendar: str) -> datetime:
    """把当地钟表时间解析成（格里历的）datetime。

    儒略历的日期按儒略历自己的规则校验（例如 1500-02-29 在儒略历里存在、在格里历里不存在），
    然后换算成格里历；不能先交给 datetime 解析，否则这类日期会被误判为非法。
    """
    cal = calendar.lower()
    if cal not in {"g", "j"}:
        raise ValueError("calendar 只能是 'g'（格里历）或 'j'（儒略历）。")

    if isinstance(value, datetime):
        if value.tzinfo is not None:
            raise ValueError("local_time_str 应是不带时区的当地钟表时间；时区请由 timezone_str 单独传入。")
        if cal == "g":
            return value
        parts = (value.year, value.month, value.day, value.hour, value.minute, value.second, value.microsecond)
    else:
        match = _CIVIL_RE.match(str(value))
        if not match:
            raise ValueError(f"无法解析本地时间 {value!r}，请使用 YYYY-MM-DD HH:MM:SS。")
        y, mo, d, h, mi, sec, frac = match.groups()
        parts = (
            int(y), int(mo), int(d), int(h), int(mi), int(sec or 0),
            int((frac or "0").ljust(6, "0")),
        )

    year, month, day_, hour, minute, second, micro = parts
    if not 1 <= year <= 9999:
        raise ValueError(f"年份 {year} 超出范围（1–9999）。")
    if not 1 <= month <= 12:
        raise ValueError(f"月份 {month} 不合法（1–12）。")
    if not 1 <= day_ <= _days_in_month(year, month, cal):
        name = "儒略历" if cal == "j" else "格里历"
        raise ValueError(f"{name} {year} 年 {month} 月没有 {day_} 日。")
    if not (0 <= hour <= 23 and 0 <= minute <= 59 and 0 <= second <= 59):
        raise ValueError(f"时间 {hour:02d}:{minute:02d}:{second:02d} 不合法。")

    if cal == "g":
        return datetime(year, month, day_, hour, minute, second, micro)

    hour_decimal = hour + minute / 60.0 + second / 3600.0 + micro / 3_600_000_000.0
    jd = swe.julday(year, month, day_, hour_decimal, swe.JUL_CAL)
    g_year, g_month, g_day, g_hour = swe.revjul(jd, swe.GREG_CAL)
    midnight = datetime(int(g_year), int(g_month), int(g_day))
    return midnight + timedelta(hours=g_hour)


def _datetime_to_jd(dt_utc: datetime) -> float:
    """UTC 钟表时间 → 儒略日，直接把 UTC 当作 UT（UT1）交给 swe.julday。

    这与 swetest 的 -ut 参数、以及主流占星软件的做法一致。按定义 |UT1 − UTC| < 0.9 秒。
    不用 swe.utc_to_jd：它是用 Swiss Ephemeris 内置的 ΔT 模型去“推算”UT1，
    对没有实测 ΔT 的近年和未来日期，推算值会偏离真实 UT1（2026 年约偏 0.35 秒，
    越往未来偏得越多），反而让结果和 swetest 对不上。
    """
    dt = dt_utc.astimezone(timezone.utc)
    hour = dt.hour + dt.minute / 60.0 + dt.second / 3600.0 + dt.microsecond / 3_600_000_000.0
    return swe.julday(dt.year, dt.month, dt.day, hour, swe.GREG_CAL)


def _jd_to_local(jd_utc: float, tzinfo: timezone) -> datetime:
    """儒略日 → 当地钟表时间；与 _datetime_to_jd 互为逆运算。"""
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


def _position_flags(ecliptic_mode: str, ayanamsha_mode: str | int) -> int:
    mode = ecliptic_mode.lower()
    if mode not in {"tropical", "sidereal"}:
        raise ValueError("ecliptic_mode 只能是 'tropical' 或 'sidereal'。")
    flags = swe.FLG_SWIEPH | swe.FLG_SPEED
    if mode == "sidereal":
        swe.set_sid_mode(_resolve_ayanamsha(ayanamsha_mode))
        flags |= swe.FLG_SIDEREAL
    return flags


def _check_ephemeris_result(
    ret_flag: int | None,
    requested_flags: int,
    label: str,
    serr: str = "",
) -> None:
    """Swiss Ephemeris 星历文件加载不到时直接报错，绝不悄悄回退到 Moshier。"""
    if ret_flag is None or not (requested_flags & swe.FLG_SWIEPH):
        return
    # FLG_MOSEPH 是 pysweph/pyswisseph 的标准常量，不用 getattr(..., 0) 兜底——
    # 那样万一它哪天真的取不到，这个安全检查会悄悄失效而不是报错提醒我们。
    used_moshier = bool(swe.FLG_MOSEPH & ret_flag)
    missing_swiss = not bool(ret_flag & swe.FLG_SWIEPH)
    if not (used_moshier or missing_swiss):
        return
    # pysweph >= 2.10.3.3 起，calc()/calc_ut() 等函数会在返回值里多带一条
    # serr 字符串，通常直接写明具体缺了哪个星历文件，比我们自己拼的提示更准确。
    detail = f"；Swiss Ephemeris 提示：{serr}" if serr else ""
    raise FileNotFoundError(
        f"无法加载 Swiss Ephemeris 星历文件（计算 {label} 时）。"
        f"请确认星历目录里有覆盖该日期的 .se1 文件。当前星历目录：{_ACTIVE_EPHE_PATH!r}{detail}"
    )


def _calc_body(jd_utc: float, body_id: int, flags: int, label: str) -> dict[str, float]:
    ecliptic_result = swe.calc_ut(jd_utc, body_id, flags)
    # 赤经赤纬是天球赤道坐标，与黄道体系无关：必须去掉 FLG_SIDEREAL 再算。
    # 带着恒星黄道标志算出的赤经赤纬会偏离真实值约 15″（不含章动）。
    equatorial_result = swe.calc_ut(jd_utc, body_id, (flags & ~swe.FLG_SIDEREAL) | swe.FLG_EQUATORIAL)
    xx = ecliptic_result[0]
    eq = equatorial_result[0]
    ret_flag = ecliptic_result[1] if len(ecliptic_result) > 1 and isinstance(ecliptic_result[1], int) else None
    # pysweph >= 2.10.3.3 的 calc_ut() 返回 (xx, retflags, serr) 三元组；
    # 旧版 pyswisseph 只有二元组，len(...) > 2 的判断让两种版本都能正常工作。
    serr = ecliptic_result[2] if len(ecliptic_result) > 2 and isinstance(ecliptic_result[2], str) else ""
    _check_ephemeris_result(ret_flag, flags, label, serr=serr)
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
    ecliptic_mode: str,
    ayanamsha_mode: str | int = "SIDM_KRISHNAMURTI",
    node_mode: str = "mean",
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
        base_flags = _position_flags(ecliptic_mode, ayanamsha_mode)
        for name in requested:
            if name in {"Ra", "Ke"} or name in result:
                continue
            result[name] = _calc_body(context.jd_utc, MAIN_PLANETS[name], base_flags, name)

        if "Ra" in requested or "Ke" in requested:
            node_id = swe.TRUE_NODE if node_mode == "true" else swe.MEAN_NODE
            north = _calc_body(context.jd_utc, node_id, base_flags, "Ra/Ke")
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
    ecliptic_mode: str,
    ayanamsha_mode: str | int = "SIDM_KRISHNAMURTI",
    jd_utc: float | None = None,
    ephe_path: str | Path | None = None,
) -> dict[str, Any]:
    """独立计算 12 宫头与四轴。

    返回结构：
        ``houses``: ``house 1`` 至 ``house 12``；
        ``axes``: Asc / Desc / MC / IC 四轴（任何宫位制下都直接取自 ascmc 计算，
        页面暂不单独展示，但星盘的上升点要用到 Asc）；
        ``extra``: Vertex / AntiVertex / EastPoint（同样取自 ascmc，供特殊点使用）。

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

        # ascmc[3] = Vertex，ascmc[4] = 赤道上升点（East Point）。与四轴一样，
        # 任何宫位制下 houses_ex2 都会给出，与所选宫位制无关。
        vertex = _ecliptic_point(ascmc[3], ascmc_speeds[3], target_eps, ayanamsha)
        extra = {
            "Vertex": vertex,
            "AntiVertex": _ecliptic_point(
                (ascmc[3] + 180.0) % 360.0, ascmc_speeds[3], target_eps, ayanamsha
            ),
            "EastPoint": _ecliptic_point(ascmc[4], ascmc_speeds[4], target_eps, ayanamsha),
        }


    return {
        "house_system": house_system,
        "ecliptic_mode": ecliptic_mode.lower(),
        "jd_utc": target_jd,
        "houses": houses,
        "axes": axes,
        "extra": extra,
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
        (context.lon, context.lat, SUNRISE_ELEVATION_M),
        SUNRISE_ATPRESS_HPA,
        SUNRISE_ATTEMP_C,
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
        # rise_trans 找不到星历文件时会悄悄改用 Moshier，所以先用太阳试算一次，缺文件就直接报错。
        probe = swe.calc_ut(context.jd_utc, swe.SUN, swe.FLG_SWIEPH)
        _check_ephemeris_result(
            probe[1] if len(probe) > 1 and isinstance(probe[1], int) else None,
            swe.FLG_SWIEPH, "日出日落",
            serr=probe[2] if len(probe) > 2 and isinstance(probe[2], str) else "",
        )
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
