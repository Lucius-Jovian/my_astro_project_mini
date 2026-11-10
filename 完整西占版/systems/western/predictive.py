"""推运盘的计算：日返、月返、次限、三限、日弧，以及小限、法达两种时间主星。

所有推运都以「本命盘」和「目标时刻」为输入。目标时刻就是顶栏（过境）的时间与地点。

  日返 / 月返   太阳（月亮）回到本命位置 + offset 度的时刻，在所选地点起盘。
  次限 / 三限   推运时刻 = 出生时刻 ± (目标 − 出生) × 星历日数 / 人生日数。
                行星取推运时刻的位置；中天按所选方法推出（太阳弧、固定速率、真实恒星时或保持本命），
                上升和宫头由中天在所选地点的纬度上算出。
  日弧          本命盘的各点一律加上同一段弧（次限太阳走过的弧，或固定速率 × 年数）。
  小限          起点（默认上升）每年前进一个星座；年里再分月、月里再分日，各自继续前进。
  法达          日生 / 夜生各一套主限顺序，主限再分七个子限。

实现上，推运盘的中天只由 ARMC（中天的赤经）决定。要得到「某个推运时刻 + 指定 ARMC」的宫位，
只需把起盘经度换成 ARMC − 那一刻的格林尼治恒星时，于是可以直接复用本命排盘的全部代码。
"""

from __future__ import annotations

import dataclasses
import math
from typing import Any, Mapping

import swisseph as swe

from common.astro import calculate_houses, parse_time_geo
from common.astro.core import _SWISS_LOCK, _resolve_ayanamsha, set_ephemeris_path

from . import bridge
from .astro import sun_above_horizon
from .astro.dignities import DOMICILE
from .predictive_settings import FIRDARIA_CODES, SPEC, normalize_predictive

CHART_KINDS = ("solar_return", "lunar_return", "secondary", "tertiary", "solar_arc")
GREGORIAN_START = 2299160.5          # 1582-10-15 0h UT
SUN_MEAN = 0.98564733
MOON_MEAN = 13.176358
CHALDEAN = ("Sa", "Ju", "Ma", "Su", "Ve", "Me", "Mo")
MODERN_RULERS = {7: "Pl", 10: "Ur", 11: "Ne"}
SIGN_NAMES = ("白羊", "金牛", "双子", "巨蟹", "狮子", "处女", "天秤", "天蝎", "射手", "摩羯", "水瓶", "双鱼")
PLANET_NAMES = {"Su": "太阳", "Mo": "月亮", "Me": "水星", "Ve": "金星", "Ma": "火星", "Ju": "木星", "Sa": "土星",
                "Ur": "天王星", "Ne": "海王星", "Pl": "冥王星", "Ra": "北交点", "Ke": "南交点"}


# ---------------------------------------------------------------- 小工具

def wrap180(x: float) -> float:
    return (x + 180.0) % 360.0 - 180.0


def _frame(options, frame="chart"):
    """返回 (是否恒星黄道, 岁差模式)。frame：chart 跟随计算设置 / tropical / sidereal。"""
    mode = options["ecliptic_mode"] if frame == "chart" else frame
    return mode == "sidereal", options["ayanamsha_mode"]


def body_position(jd: float, body: int, sidereal: bool, ayanamsha) -> tuple[float, float]:
    """某一刻某颗星的黄经和日速度（度）。"""
    with _SWISS_LOCK:
        set_ephemeris_path()
        flags = swe.FLG_SWIEPH | swe.FLG_SPEED
        if sidereal:
            swe.set_sid_mode(_resolve_ayanamsha(ayanamsha))
            flags |= swe.FLG_SIDEREAL
        xx = swe.calc_ut(jd, body, flags)[0]
    return float(xx[0]) % 360.0, float(xx[3])


def body_ra(jd: float, body: int) -> float:
    with _SWISS_LOCK:
        set_ephemeris_path()
        return float(swe.calc_ut(jd, body, swe.FLG_SWIEPH | swe.FLG_EQUATORIAL)[0][0]) % 360.0


def ayanamsa(jd: float, sidereal: bool, ayanamsha_mode) -> float:
    if not sidereal:
        return 0.0
    with _SWISS_LOCK:
        set_ephemeris_path()
        swe.set_sid_mode(_resolve_ayanamsha(ayanamsha_mode))
        return float(swe.get_ayanamsa_ex_ut(jd, swe.FLG_SWIEPH | swe.FLG_SIDEREAL)[1])


def obliquity(jd: float) -> float:
    with _SWISS_LOCK:
        set_ephemeris_path()
        return float(swe.calc_ut(jd, swe.ECL_NUT, 0)[0][0])


def sidereal_time_deg(jd: float) -> float:
    with _SWISS_LOCK:
        return float(swe.sidtime(jd)) * 15.0


def ecl_to_ra(lon: float, eps: float, lat: float = 0.0) -> tuple[float, float]:
    """回归黄经 / 黄纬 → 赤经 / 赤纬。"""
    ra, dec, _ = swe.cotrans((lon % 360.0, lat, 1.0), -eps)
    return float(ra) % 360.0, float(dec)


def ra_to_ecl(ra: float, eps: float) -> float:
    """赤经 → 黄道上同一赤经的点的回归黄经。"""
    r, e = math.radians(ra), math.radians(eps)
    return math.degrees(math.atan2(math.sin(r), math.cos(r) * math.cos(e))) % 360.0


def solve_body(body: int, target: float, guess: float, sidereal: bool, ayanamsha) -> float:
    """星体黄经等于 target 的时刻（牛顿法，从 guess 附近找）。"""
    jd = guess
    for _ in range(60):
        lon, speed = body_position(jd, body, sidereal, ayanamsha)
        diff = wrap180(lon - target)
        if abs(diff) < 1e-8:
            return jd
        if abs(speed) < 1e-6:
            speed = SUN_MEAN if body == swe.SUN else MOON_MEAN
        step = diff / speed
        # 防止一步跳得太远（月亮速度变化大）
        limit = 5.0 if body == swe.MOON else 40.0
        jd -= max(-limit, min(limit, step))
    return jd


def _calendar_for(jd: float, natal_calendar: str) -> str:
    return "j" if natal_calendar == "j" and jd < GREGORIAN_START else "g"


def local_parts(jd: float, tz: float, calendar: str) -> tuple[int, int, int, int, int, int, int]:
    """儒略日 → 当地 (年, 月, 日, 时, 分, 秒, 毫秒)，四舍五入到毫秒。"""
    x = jd + tz / 24.0 + 0.5
    day = math.floor(x)
    ms = round((x - day) * 86_400_000)
    if ms >= 86_400_000:
        day += 1
        ms -= 86_400_000
    y, m, d, _ = swe.revjul(day - 0.5, swe.JUL_CAL if calendar == "j" else swe.GREG_CAL)
    h, rem = divmod(ms, 3_600_000)
    mi, rem = divmod(rem, 60_000)
    s, msec = divmod(rem, 1000)
    return int(y), int(m), int(d), int(h), int(mi), int(s), int(msec)


def local_string(jd: float, tz: float, calendar: str) -> str:
    y, m, d, h, mi, s, ms = local_parts(jd, tz, calendar)
    if not 1 <= y <= 9999:
        raise ValueError(f"推算出的时刻超出了 1–9999 年的范围（{y} 年）。")
    return f"{y:04d}-{m:02d}-{d:02d} {h:02d}:{mi:02d}:{s:02d}.{ms:03d}"


def display_time(jd: float, tz: float, calendar: str, *, seconds: bool = False) -> str:
    y, m, d, h, mi, s, _ = local_parts(jd, tz, calendar)
    text = f"{y:04d}-{m:02d}-{d:02d} {h:02d}:{mi:02d}"
    return f"{text}:{s:02d}" if seconds else text


def tz_text(tz: float) -> str:
    sign = "+" if tz >= 0 else "−"
    minutes = round(abs(tz) * 60)
    h, m = divmod(minutes, 60)
    return f"UTC{sign}{h}" + (f":{m:02d}" if m else "")


def coord_text(lat: float, lon: float) -> str:
    return f"{abs(lat):.2f}°{'N' if lat >= 0 else 'S'} {abs(lon):.2f}°{'E' if lon >= 0 else 'W'}"


def _fmt_deg(x: float) -> str:
    sign = "−" if x < 0 else ""
    total = round(abs(x) * 60)
    return f"{sign}{total // 60}°{total % 60:02d}′"


def _num(x: float) -> str:
    return f"{x:.7f}"


# ---------------------------------------------------------------- 输入

class Natal:
    """本命盘的原始数据（只算一次）。"""

    def __init__(self, payload: Mapping[str, Any]):
        self.payload = {"birth": dict(payload.get("birth") or {}), "options": dict(payload.get("options") or {})}
        self.options, self.context, self.planets, self.houses, self.extra = bridge.chart_parts(self.payload)
        self.jd = self.context.jd_utc
        self.tz = self.context.tz_offset
        self.calendar = self.context.calendar
        self.sidereal, self.ayanamsha = _frame(self.options)
        self._is_day = None

    @property
    def sun_lon(self) -> float:
        """本命太阳在盘面黄道上的黄经（太阳没有勾选显示时也能用）。"""
        if "Su" in self.planets:
            return float(self.planets["Su"]["lon"])
        return body_position(self.jd, swe.SUN, self.sidereal, self.ayanamsha)[0]

    @property
    def is_day(self) -> bool:
        if self._is_day is None:
            self._is_day = sun_above_horizon(self.context, self.options["classical"]["sect"]["day_rule"])
        return self._is_day

    def chart_at(self, jd: float, lat: float, lon: float, tz: float, house_system: str = ""):
        """某个时刻、某个地点的完整排盘（用本命盘的全部计算设置）。"""
        options = dict(self.payload["options"])
        if house_system:
            options["house_system"] = house_system
        birth = {
            "local_time_str": local_string(jd, tz, _calendar_for(jd, self.calendar)),
            "timezone_str": f"{tz:+.6f}",
            "latitude": _num(lat),
            "longitude": _num(((lon + 180.0) % 360.0) - 180.0),
            "calendar": _calendar_for(jd, self.calendar),
        }
        return bridge.calculate_full_chart({"birth": birth, "options": options})


def _target_context(target: Mapping[str, Any], natal: Natal):
    birth = bridge._normalize_input({"birth": target, "options": natal.payload["options"]})["birth"]
    return parse_time_geo(**birth)


def _place(cfg, natal: Natal, target):
    """(纬度, 经度, 时区, 说明)。"""
    where = cfg.get("location", "natal")
    if where == "target":
        return target.lat, target.lon, target.tz_offset, f"顶栏地点 {coord_text(target.lat, target.lon)}"
    if where == "custom":
        tz = float(cfg.get("custom_tz", natal.tz))
        return float(cfg["custom_lat"]), float(cfg["custom_lon"]), tz, f"自定义地点 {coord_text(cfg['custom_lat'], cfg['custom_lon'])}"
    return natal.context.lat, natal.context.lon, natal.tz, "出生地"


# ---------------------------------------------------------------- 日返 / 月返

def find_return(body: int, target_lon: float, jd_target: float, pick: str, shift: int,
                sidereal: bool, ayanamsha) -> float:
    period = 365.2422 if body == swe.SUN else 27.3216
    mean = 360.0 / period
    lon, _ = body_position(jd_target, body, sidereal, ayanamsha)
    jd = solve_body(body, target_lon, jd_target - wrap180(lon - target_lon) / mean, sidereal, ayanamsha)
    if pick == "before":
        while jd > jd_target:
            jd = solve_body(body, target_lon, jd - period, sidereal, ayanamsha)
        nxt = solve_body(body, target_lon, jd + period, sidereal, ayanamsha)
        if nxt <= jd_target:
            jd = nxt
    elif pick == "after":
        while jd < jd_target:
            jd = solve_body(body, target_lon, jd + period, sidereal, ayanamsha)
        prev = solve_body(body, target_lon, jd - period, sidereal, ayanamsha)
        if prev >= jd_target:
            jd = prev
    else:
        for guess in (jd - period, jd + period):
            other = solve_body(body, target_lon, guess, sidereal, ayanamsha)
            if abs(other - jd_target) < abs(jd - jd_target):
                jd = other
    step = 1 if shift > 0 else -1
    for _ in range(abs(int(shift))):
        jd = solve_body(body, target_lon, jd + step * period, sidereal, ayanamsha)
    return jd


def calc_return(kind: str, natal: Natal, target, cfg) -> dict:
    body = swe.SUN if kind == "solar_return" else swe.MOON
    sidereal, ayan = _frame(natal.options, cfg["frame"])
    natal_lon, _ = body_position(natal.jd, body, sidereal, ayan)
    goal = (natal_lon + float(cfg["offset"])) % 360.0
    jd = find_return(body, goal, target.jd_utc, cfg["pick"], int(cfg["shift"]), sidereal, ayan)
    lat, lon, tz, place = _place(cfg, natal, target)
    chart = natal.chart_at(jd, lat, lon, tz, cfg["house_system"])
    name = SPEC[kind]["title"]
    frame = {"chart": "", "tropical": " · 回归黄道", "sidereal": " · 恒星黄道"}[cfg["frame"]]
    offset = float(cfg["offset"])
    caption = (f"{name}{'' if offset == 0 else f'（+{offset:g}°）'} {display_time(jd, tz, _calendar_for(jd, natal.calendar), seconds=True)}"
               f" {tz_text(tz)} · {place}{frame}")
    chart["predictive"] = {"kind": kind, "jd": jd, "caption": caption}
    return chart


# ---------------------------------------------------------------- 次限 / 三限

def _sun_arc(natal: Natal, pjd: float, expected: float, in_ra: bool) -> float:
    """次限太阳走过的弧（黄经或赤经），按预期的大小展开成连续的度数（可超过 360°，可为负）。"""
    if in_ra:
        moved = body_ra(pjd, swe.SUN) - body_ra(natal.jd, swe.SUN)
    else:
        moved = body_position(pjd, swe.SUN, natal.sidereal, natal.ayanamsha)[0] - natal.sun_lon
    return expected + wrap180(moved - expected)


def _armc_from_mc_lon(natal: Natal, mc_lon: float) -> float:
    """盘面黄经（可能是恒星黄经）上的中天 → ARMC。"""
    tropical = mc_lon + ayanamsa(natal.jd, natal.sidereal, natal.ayanamsha)
    return ecl_to_ra(tropical, natal.context.eps)[0]


def calc_progressed(kind: str, natal: Natal, target, cfg) -> dict:
    elapsed = target.jd_utc - natal.jd
    sign = -1.0 if cfg["direction"] == "converse" else 1.0
    ratio = float(cfg["eph_days"]) / float(cfg["life_days"])
    pjd = natal.jd + sign * elapsed * ratio
    units = elapsed / float(cfg["life_days"])            # 过了多少个人生单位（年 / 月）
    lat, lon, _, place = _place(cfg, natal, target)
    natal_armc = natal.houses["axes"]["MC"]["ra"]
    natal_mc = natal.houses["axes"]["MC"]["lon"]
    method = cfg["angles"]
    arc = None
    if method in ("solar_arc_lon", "solar_arc_ra"):
        arc = _sun_arc(natal, pjd, sign * elapsed * ratio * SUN_MEAN, method == "solar_arc_ra")
        armc = natal_armc + arc if method == "solar_arc_ra" else _armc_from_mc_lon(natal, natal_mc + arc)
    elif method in ("naibod_lon", "naibod_ra"):
        arc = sign * float(cfg["rate"]) * units
        armc = natal_armc + arc if method == "naibod_ra" else _armc_from_mc_lon(natal, natal_mc + arc)
    elif method == "natal":
        armc = natal_armc
    else:
        armc = None                                        # real：推运时刻在所选地点的真实恒星时
    geo = lon if armc is None else armc - sidereal_time_deg(pjd)
    chart = natal.chart_at(pjd, lat, geo, natal.tz, cfg["house_system"])
    name = SPEC[kind]["title"]
    unit = "年" if kind == "secondary" else "月"
    method_text = {"solar_arc_lon": "中天按太阳弧（黄经）", "solar_arc_ra": "中天按太阳弧（赤经）",
                   "naibod_lon": "中天按固定速率（黄经）", "naibod_ra": "中天按固定速率（赤经）",
                   "real": "中天按真实恒星时", "natal": "中天保持本命"}[method]
    parts = [f"{name}{'（逆推）' if sign < 0 else ''} 推运时刻 {display_time(pjd, natal.tz, _calendar_for(pjd, natal.calendar))}"
             f" {tz_text(natal.tz)}", f"{units:.2f} {unit}", method_text + (f" {_fmt_deg(arc)}" if arc is not None else ""), place]
    chart["predictive"] = {"kind": kind, "jd": pjd, "arc": arc, "units": units, "caption": " · ".join(parts)}
    return chart


# ---------------------------------------------------------------- 日弧

def calc_solar_arc(natal: Natal, target, cfg) -> dict:
    elapsed = target.jd_utc - natal.jd
    sign = -1.0 if cfg["direction"] == "converse" else 1.0
    units = elapsed / float(cfg["life_days"])
    if cfg["arc"] == "rate":
        arc = sign * float(cfg["rate"]) * units
    else:
        ratio = float(cfg["eph_days"]) / float(cfg["life_days"])
        pjd = natal.jd + sign * elapsed * ratio
        arc = _sun_arc(natal, pjd, sign * elapsed * ratio * SUN_MEAN, cfg["arc"] == "true_ra")

    eps = natal.context.eps
    ayan = ayanamsa(natal.jd, natal.sidereal, natal.ayanamsha)
    in_ra = cfg["direct_in"] == "ra"

    def direct(lon: float) -> float:
        if not in_ra:
            return (lon + arc) % 360.0
        ra = ecl_to_ra(lon + ayan, eps)[0]
        return (ra_to_ecl(ra + arc, eps) - ayan) % 360.0

    def moved(point: Mapping[str, Any]) -> dict:
        out = dict(point)
        out["lon"] = direct(float(point["lon"]))
        lat = float(point.get("lat") or 0.0)
        out["ra"], out["dec"] = ecl_to_ra(out["lon"] + ayan, eps, lat)
        return out

    planets = {code: moved(p) for code, p in natal.planets.items()}
    houses = natal.houses
    if cfg["houses"] == "arc":
        houses = {**houses,
                  "houses": {k: moved(v) for k, v in houses["houses"].items()},
                  "axes": {k: moved(v) for k, v in houses["axes"].items()},
                  "extra": {k: moved(v) for k, v in (houses.get("extra") or {}).items()}}
    elif cfg["houses"] == "from_mc":
        lat, _, _, _ = _place(cfg, natal, target)
        armc = ecl_to_ra(direct(houses["axes"]["MC"]["lon"]) + ayan, eps)[0]
        ctx = dataclasses.replace(natal.context, lat=lat, lon=wrap180(armc - sidereal_time_deg(natal.jd)))
        houses = calculate_houses(ctx, cfg["house_system"] or natal.options["house_system"],
                                  ecliptic_mode=natal.options["ecliptic_mode"], ayanamsha_mode=natal.ayanamsha)

    extra = dict(natal.extra)
    for key in ("asteroids", "special_points", "lots") + (("fixed_stars",) if cfg["stars"] else ()):
        if key in extra:
            extra[key] = {name: moved(p) for name, p in extra[key].items()}
    antiscia = bridge._calculate_antiscia(natal.options["points"], planets)
    if antiscia:
        extra["antiscia"] = antiscia
    chart = bridge.safe_json(bridge.assemble_chart(natal.options, natal.context, planets, houses, extra))
    arc_text = {"true_lon": "次限太阳黄经弧", "true_ra": "次限太阳赤经弧", "rate": "固定速率"}[cfg["arc"]]
    houses_text = {"arc": "宫头加弧", "from_mc": "宫头由中天重算", "natal": "宫头保持本命"}[cfg["houses"]]
    caption = (f"日弧{'（逆推）' if sign < 0 else ''} 弧 {_fmt_deg(arc)}（{arc_text}，{units:.2f} 年）"
               f" · {'赤经加弧' if in_ra else '黄经加弧'} · {houses_text}")
    chart["predictive"] = {"kind": "solar_arc", "arc": arc, "units": units, "caption": caption}
    return chart


# ---------------------------------------------------------------- 年的起止：小限、法达共用

class YearClock:
    """年龄（可带小数）↔ 时刻。三种算法：

    fixed         出生时刻 + 年龄 × 年长
    anniversary   每年的生日（与出生同月同日同一钟点；2 月 29 日出生的平年取 2 月 28 日）
    solar_return  每年太阳回到本命位置的时刻
    年内按比例插值。
    """

    def __init__(self, natal: Natal, mode: str, days: float):
        self.natal, self.mode, self.days = natal, mode, float(days)
        self.cache: dict[int, float] = {}
        if mode == "anniversary":
            self.civil = local_parts(natal.jd, natal.tz, natal.calendar)
        if mode == "solar_return":
            self.sun = natal.sun_lon

    def start(self, n: int) -> float:
        """第 n 年开始的时刻（n = 0 就是出生）。"""
        if n in self.cache:
            return self.cache[n]
        natal = self.natal
        if n == 0 or self.mode == "fixed":
            jd = natal.jd + n * self.days
        elif self.mode == "anniversary":
            y, m, d, h, mi, s, ms = self.civil
            year = y + n
            cal = swe.JUL_CAL if natal.calendar == "j" else swe.GREG_CAL
            first = swe.julday(year, m, 1, 0.0, cal)
            nxt = swe.julday(year + (m == 12), m % 12 + 1, 1, 0.0, cal)
            day = min(d, int(round(nxt - first)))
            jd = swe.julday(year, m, day, h + mi / 60 + (s + ms / 1000) / 3600, cal) - natal.tz / 24.0
        else:
            jd = solve_body(swe.SUN, self.sun, natal.jd + n * 365.2422, natal.sidereal, natal.ayanamsha)
        self.cache[n] = jd
        return jd

    def jd(self, age: float) -> float:
        n = math.floor(age)
        a, b = self.start(n), self.start(n + 1)
        return a + (age - n) * (b - a)

    def age(self, jd: float) -> float:
        n = math.floor((jd - self.natal.jd) / 365.2422)
        while self.start(n) > jd:
            n -= 1
        while self.start(n + 1) <= jd:
            n += 1
        a, b = self.start(n), self.start(n + 1)
        return n + (jd - a) / (b - a)


# ---------------------------------------------------------------- 小限

def sign_lord(sign: int, rulers: str) -> str:
    if rulers == "modern" and sign in MODERN_RULERS:
        return MODERN_RULERS[sign]
    return DOMICILE[sign]


def _start_lon(natal: Natal, start: str) -> tuple[float, str]:
    if start in ("Asc", "MC"):
        return float(natal.houses["axes"][start]["lon"]), {"Asc": "上升", "MC": "中天"}[start]
    if start.startswith("lot:"):
        code = start[4:]
        resolver = bridge.PointResolver(natal.context, natal.options, natal.planets, natal.houses)
        lot = resolver.lot(code)
        label = next((x["label"] for x in natal.options["points"]["lots"]["items"]
                      if x["code"].casefold() == code.casefold()), code)
        return float(lot["lon"]), label
    if start not in natal.planets:
        natal.planets.update(bridge._calculate_planets(natal.context, natal.options, [start]))
    return float(natal.planets[start]["lon"]), PLANET_NAMES.get(start, start)


def _boundaries(a: float, b: float, mode: str, parts: float, days: float, sun_deg: float, natal: Natal) -> list[float]:
    """把 [a, b) 切成若干段，返回每段的起点（第一个是 a）。"""
    starts = [a]
    if mode == "equal":
        step = (b - a) / parts
        while starts[-1] + step < b - 1e-9 and len(starts) < 2000:
            starts.append(a + len(starts) * step)
    elif mode == "days":
        while starts[-1] + days < b - 1e-9 and len(starts) < 2000:
            starts.append(a + len(starts) * days)
    else:                                              # solar：太阳每走 sun_deg 度
        s0, _ = body_position(a, swe.SUN, natal.sidereal, natal.ayanamsha)
        k = 1
        while len(starts) < 2000:
            jd = solve_body(swe.SUN, (s0 + k * sun_deg) % 360.0, a + k * sun_deg / SUN_MEAN, natal.sidereal, natal.ayanamsha)
            if jd >= b - 1e-9:
                break
            starts.append(jd)
            k += 1
    return starts


def calc_profection(natal: Natal, target, cfg) -> dict:
    clock = YearClock(natal, cfg["year_start"], cfg["year_days"])
    jd_t = target.jd_utc
    if jd_t < natal.jd:
        raise ValueError("小限：顶栏时间早于出生时间。")
    base_lon, base_label = _start_lon(natal, cfg["start"])
    asc_sign = int(natal.houses["axes"]["Asc"]["lon"] // 30) % 12
    mode, rulers = cfg["mode"], cfg["rulers"]
    tz, cal = target.tz_offset, natal.calendar
    natal_signs: dict[int, list[str]] = {}
    for code in natal.options["points"]["planets"]:
        if code in natal.planets:
            natal_signs.setdefault(int(natal.planets[code]["lon"] // 30) % 12, []).append(code)

    def place(lon: float) -> dict:
        lon %= 360.0
        if mode == "sign":
            lon = (lon // 30) * 30.0
        sign = int(lon // 30) % 12
        return {"sign": sign, "lon": None if mode == "sign" else lon, "lord": sign_lord(sign, rulers),
                "house": (sign - asc_sign) % 12 + 1, "planets": natal_signs.get(sign, [])}

    def item(index: int, lon: float, a: float, b: float, **more) -> dict:
        return {"index": index, **place(lon), "start_jd": a, "end_jd": b,
                "start": display_time(a, tz, _calendar_for(a, cal)), "end": display_time(b, tz, _calendar_for(b, cal)), **more}

    age = clock.age(jd_t)
    n = math.floor(age)

    def year_lon(k: int, frac: float = 0.0) -> float:
        steps = k + (frac if mode == "continuous" else 0.0)
        return base_lon + 30.0 * cfg["year_step"] * steps

    # 年
    y0, y1 = clock.start(n), clock.start(n + 1)
    year = item(n, year_lon(n, age - n), y0, y1, age=n)
    years = []
    for k in range(0, int(cfg["table_years"]) + 1):
        years.append(item(k, year_lon(k), clock.start(k), clock.start(k + 1), age=k))

    # 月
    m_starts = _boundaries(y0, y1, cfg["month_mode"], float(cfg["month_parts"]), float(cfg["month_days"]),
                           float(cfg["month_sun_deg"]), natal)
    m_ends = m_starts[1:] + [y1]
    m = max(i for i, s in enumerate(m_starts) if s <= jd_t)
    m_base = year_lon(n) if cfg["month_from"] == "year" else base_lon

    def month_lon(i: int, frac: float = 0.0) -> float:
        return m_base + 30.0 * cfg["month_step"] * (i + (frac if mode == "continuous" else 0.0))

    m_frac = (jd_t - m_starts[m]) / (m_ends[m] - m_starts[m])
    month = item(m, month_lon(m, m_frac), m_starts[m], m_ends[m])
    months = [item(i, month_lon(i), a, b) for i, (a, b) in enumerate(zip(m_starts, m_ends))]

    # 日
    d_starts = _boundaries(m_starts[m], m_ends[m], cfg["day_mode"], float(cfg["day_parts"]), float(cfg["day_days"]), 30.0, natal)
    d_ends = d_starts[1:] + [m_ends[m]]
    d = max(i for i, s in enumerate(d_starts) if s <= jd_t)
    d_base = month_lon(m)

    def day_lon(i: int, frac: float = 0.0) -> float:
        return d_base + 30.0 * cfg["day_step"] * (i + (frac if mode == "continuous" else 0.0))

    d_frac = (jd_t - d_starts[d]) / (d_ends[d] - d_starts[d])
    day = item(d, day_lon(d, d_frac), d_starts[d], d_ends[d])
    days = [item(i, day_lon(i), a, b) for i, (a, b) in enumerate(zip(d_starts, d_ends))]

    return {
        "start": cfg["start"], "start_label": base_label, "start_lon": base_lon % 360.0,
        "mode": mode, "rulers": rulers, "lords": [sign_lord(s, rulers) for s in range(12)],
        "age": age, "year": year, "month": month, "day": day,
        "years": years, "months": months, "days": days,
    }


# ---------------------------------------------------------------- 法达

def _sub_lords(lord: str, sequence: list[str], cfg) -> list[str]:
    if lord in ("Ra", "Ke") and not cfg["node_subs"]:
        return []
    if cfg["sub_order"] == "sequence":
        planets = [c for c in sequence if c not in ("Ra", "Ke")]
        if not planets:
            return []
        start = planets.index(lord) if lord in planets else 0
    else:
        planets = list(CHALDEAN)
        start = planets.index(lord) if lord in planets else 0     # 交点：从土星起
    return [planets[(start + i) % len(planets)] for i in range(len(planets))]


def calc_firdaria(natal: Natal, target, cfg) -> dict:
    is_day = natal.is_day if cfg["sect"] == "chart" else cfg["sect"] == "day"
    sequence = list(cfg["day_order"] if is_day else cfg["night_order"])
    years = {c: float(cfg["years"][c]) for c in FIRDARIA_CODES}
    total = sum(years[c] for c in sequence)
    if total <= 0:
        raise ValueError("法达：顺序里各星的年数加起来必须大于 0。")
    clock = YearClock(natal, cfg["year_start"], cfg["year_days"])
    jd_t = target.jd_utc
    if jd_t < natal.jd:
        raise ValueError("法达：顶栏时间早于出生时间。")
    age = clock.age(jd_t)
    cycle = math.floor(age / total)
    tz, cal = target.tz_offset, natal.calendar

    def stamp(a: float) -> dict:
        jd = clock.jd(a)
        return {"age": a, "jd": jd, "text": display_time(jd, tz, _calendar_for(jd, cal))}

    periods, current = [], {"major": None, "sub": None}
    pos = cycle * total
    for lord in sequence:
        length = years[lord]
        if length <= 0:
            continue
        a, b = pos, pos + length
        subs = []
        lords = _sub_lords(lord, sequence, cfg)
        if lords:
            if cfg["sub_mode"] == "proportional" and sum(years[x] for x in lords) > 0:
                weights = [years[x] for x in lords]
            else:
                weights = [1.0] * len(lords)
            scale = length / sum(weights)
            sp = a
            for sub_lord, w in zip(lords, weights):
                sa, sb = sp, sp + w * scale
                subs.append({"lord": sub_lord, "start": stamp(sa), "end": stamp(sb), "current": sa <= age < sb})
                sp = sb
        is_current = a <= age < b
        if is_current:
            current["major"] = len(periods)
            current["sub"] = next((i for i, s in enumerate(subs) if s["current"]), None)
        periods.append({"lord": lord, "years": length, "start": stamp(a), "end": stamp(b),
                        "current": is_current, "subs": subs})
        pos = b
    return {"is_day": is_day, "sequence": sequence, "total": total, "cycle": cycle, "age": age,
            "cycle_age": age - cycle * total, "periods": periods, "current": current}


# ---------------------------------------------------------------- 双盘相位

def _cross_points(options, chart, *, prefix, axes, fixed, orb_mode, orb_value):
    """一张盘里参与双盘相位的点（与主相位表同一套选择）。fixed：这张盘不动（本命），速度一律当作 0。"""
    opts = {"points": options["points"], "aspects": {**options["aspects"],
            "selection": {**options["aspects"]["selection"], "axes": options["aspects"]["selection"]["axes"] if axes else []}}}
    house_result = {"axes": dict((chart.get("house_result") or {}).get("axes") or {})}
    extra = {"asteroids": dict(chart.get("asteroids") or {})}
    points, info = bridge._main_aspect_points(opts, dict(chart.get("planet_pos") or {}), house_result, extra)
    out = []
    for p in points:
        orb = float(orb_value) if orb_mode == "fixed" else p.orb * float(orb_value)
        out.append(bridge.AspectPoint(prefix + p.id, p.lon, 0.0 if fixed else p.speed, orb))
    for item in info:
        item["id"] = prefix + item["id"]
    return out, info


def cross_aspects(payload: Mapping[str, Any], saved_settings=None) -> dict:
    """外圈（过境 / 推运盘）与内圈（本命）之间的相位：a 是外圈的点（id 带 o: 前缀），b 是内圈的点。"""
    view = str(payload.get("view") or "")
    settings = normalize_predictive(payload.get("settings") if payload.get("settings") is not None else saved_settings)["biwheel"]
    if f"{view}_mode" not in settings:
        raise ValueError(f"这张盘没有双盘相位：{view!r}")
    raw = dict(payload.get("options") or {})
    options = {"points": bridge.normalize_points(raw.get("points")), "aspects": bridge.normalize_aspects(raw.get("aspects"))}
    mode = settings[f"{view}_mode"]
    value = settings[f"{view}_orb"] if mode == "fixed" else settings[f"{view}_scale"]
    outer, outer_info = _cross_points(options, payload.get("outer") or {}, prefix="o:", axes=settings["outer_axes"],
                                      fixed=False, orb_mode=mode, orb_value=value)
    inner, inner_info = _cross_points(options, payload.get("inner") or {}, prefix="", axes=settings["inner_axes"],
                                      fixed=True, orb_mode=mode, orb_value=value)
    cfg = options["aspects"]
    hits = bridge.find_aspects(outer, inner, bridge._aspect_types(cfg, "main"),
                               rule=cfg["orbs"]["rule"], cross_sign=cfg["cross_sign"])
    orb_text = f"统一 {float(value):g}°" if mode == "fixed" else f"相位设置 × {float(value):g}"
    return bridge.safe_json({"aspects": hits, "outer": outer_info, "inner": inner_info, "orb": orb_text})


# ---------------------------------------------------------------- 入口

def calculate(payload: Mapping[str, Any], saved_settings=None) -> dict:
    kind = str(payload.get("kind") or "")
    if kind not in CHART_KINDS + ("timelords",):
        raise ValueError(f"未知的推运盘：{kind!r}")
    settings = normalize_predictive(payload.get("settings") if payload.get("settings") is not None else saved_settings)
    natal = Natal(payload.get("natal") or {})
    target = _target_context(payload.get("target") or {}, natal)
    if kind in ("solar_return", "lunar_return"):
        return bridge.safe_json(calc_return(kind, natal, target, settings[kind]))
    if kind in ("secondary", "tertiary"):
        return bridge.safe_json(calc_progressed(kind, natal, target, settings[kind]))
    if kind == "solar_arc":
        return calc_solar_arc(natal, target, settings["solar_arc"])
    out = {"target": {"jd": target.jd_utc, "text": display_time(target.jd_utc, target.tz_offset, natal.calendar),
                      "tz": tz_text(target.tz_offset)}}
    errors = {}
    try:
        out["profection"] = calc_profection(natal, target, settings["profection"])
    except ValueError as exc:
        errors["profection"] = str(exc)
    try:
        out["firdaria"] = calc_firdaria(natal, target, settings["firdaria"])
    except ValueError as exc:
        errors["firdaria"] = str(exc)
    out["errors"] = errors
    return bridge.safe_json(out)
