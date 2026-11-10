"""印度占星的扩展计算：日内时段、特殊上升点（Vishesha Lagna）、Upagraha、行星战、太阴月 / 六十年 / 南北行。

这里只放需要星历或精确时刻的部分（日出、上升点随时间的变化、新月时刻等）。只靠行星黄经就能算的
（尊贵、Chara Karaka、Avastha、特殊度数、敌友、Ashtakavarga、分盘汇总、Arudha）在页面上计算
（static/jyotish.js），改设置时不必重新排盘。Shadbala 在 bala.py。

约定：
- 黄经都在当前所选黄道体系下给出（与星盘一致）。太阴月、南北行（恒星）按所选岁差的恒星黄道判断。
- 「印度日」从日出到次日日出；日出前出生算前一天。
- 时刻返回当地时间（datetime），交给 safe_json 转成 ISO 字符串。
"""

from __future__ import annotations

import math
from dataclasses import replace
from datetime import timedelta
from typing import Any, Mapping

import swisseph as swe

from common.astro import calculate_houses, calculate_planets, calculate_sunrise_sunset, jd_to_local, sidereal_sun_moon
from common.astro.core import _SWISS_LOCK, _resolve_ayanamsha, set_ephemeris_path

# ---------------------------------------------------------------- 基础表

SIGN_LORDS = ("Ma", "Ve", "Me", "Mo", "Su", "Me", "Ve", "Ma", "Ju", "Sa", "Sa", "Ju")
WEEK = ("Su", "Mo", "Ma", "Me", "Ju", "Ve", "Sa")          # 星期日 = 0
P7 = ("Su", "Mo", "Ma", "Me", "Ju", "Ve", "Sa")
WAR_PLANETS = ("Ma", "Me", "Ju", "Ve", "Sa")

# 天然友敌（BPHS 第 3 章）：1 友、0 中、-1 敌
NATURAL = {
    "Su": {"Mo": 1, "Ma": 1, "Ju": 1, "Me": 0, "Ve": -1, "Sa": -1},
    "Mo": {"Su": 1, "Me": 1, "Ma": 0, "Ju": 0, "Ve": 0, "Sa": 0},
    "Ma": {"Su": 1, "Mo": 1, "Ju": 1, "Ve": 0, "Sa": 0, "Me": -1},
    "Me": {"Su": 1, "Ve": 1, "Ma": 0, "Ju": 0, "Sa": 0, "Mo": -1},
    "Ju": {"Su": 1, "Mo": 1, "Ma": 1, "Sa": 0, "Me": -1, "Ve": -1},
    "Ve": {"Me": 1, "Sa": 1, "Ma": 0, "Ju": 0, "Su": -1, "Mo": -1},
    "Sa": {"Me": 1, "Ve": 1, "Ju": 0, "Su": -1, "Mo": -1, "Ma": -1},
}

SWE_IDS = {"Ma": swe.MARS, "Me": swe.MERCURY, "Ju": swe.JUPITER, "Ve": swe.VENUS, "Sa": swe.SATURN}

_EPS = 1e-9


def norm360(x: float) -> float:
    return float(x) % 360.0


def sign_of(lon: float) -> int:
    return int(math.floor(norm360(lon) / 30.0 + _EPS)) % 12


def deg_in_sign(lon: float) -> float:
    x = norm360(lon)
    d = x - sign_of(x) * 30.0
    return d if 0.0 <= d < 30.0 else 0.0


def separation(a: float, b: float) -> float:
    d = abs(norm360(a) - norm360(b)) % 360.0
    return 360.0 - d if d > 180.0 else d


def natural_rel(a: str, b: str) -> int:
    return NATURAL.get(a, {}).get(b, 0)


def temporal_rel(signs: Mapping[str, int], a: str, b: str) -> int:
    """临时友敌：b 在 a 起的第 2、3、4、10、11、12 个星座为友（+1），否则为敌（-1）。"""
    return 1 if (signs[b] - signs[a]) % 12 in (1, 2, 3, 9, 10, 11) else -1


def compound_rel(signs: Mapping[str, int], a: str, b: str) -> int:
    """五重关系：2 大友、1 友、0 中、-1 敌、-2 大敌。"""
    return natural_rel(a, b) + temporal_rel(signs, a, b)


# ---------------------------------------------------------------- 印度日：日出到次日日出

def vedic_day(context, sun_events: Mapping[str, Any], rsmi: int) -> dict[str, float]:
    """出生时刻所在的印度日：{sunrise, sunset, next_sunrise}（儒略日 UT）。日出前出生取前一天。"""
    jd = context.jd_utc
    rise = float(sun_events["sunrise_jd_utc"])
    if jd < rise:
        prev = calculate_sunrise_sunset(context, context.local_dt.date() - timedelta(days=1), rsmi=rsmi)
        return {"sunrise": float(prev["sunrise_jd_utc"]), "sunset": float(prev["sunset_jd_utc"]), "next_sunrise": rise}
    nxt = sun_events.get("next_sunrise_jd_utc")
    return {"sunrise": rise, "sunset": float(sun_events["sunset_jd_utc"]),
            "next_sunrise": float(nxt) if nxt else rise + 1.0}


# ---------------------------------------------------------------- Kala Vela：昼、夜各八分

KALAVELAS = (("Kl", "Kala", "Su"), ("Mr", "Mrityu", "Ma"), ("Ap", "Ardhaprahara", "Me"),
             ("Yg", "Yamaghantaka", "Ju"), ("Gk", "Gulika", "Sa"))


def kalavela_segments(day: Mapping[str, float], day_lord: str, jd: float) -> tuple[bool, dict[str, tuple[float, float]]]:
    """出生所在的半天（昼或夜）八等分，前七份依次归七曜（昼从值日星起，夜从值日星起第 5 位起），第八份无主。"""
    is_day = day["sunrise"] <= jd < day["sunset"]
    start, end = (day["sunrise"], day["sunset"]) if is_day else (day["sunset"], day["next_sunrise"])
    part = (end - start) / 8.0
    first = WEEK.index(day_lord) if is_day else (WEEK.index(day_lord) + 4) % 7
    return is_day, {WEEK[(first + k) % 7]: (start + k * part, start + (k + 1) * part) for k in range(7)}


def _asc_at(context, jd: float, options: Mapping[str, Any]) -> float:
    houses = calculate_houses(context, "Equal", ecliptic_mode=options["ecliptic_mode"],
                              ayanamsha_mode=options["ayanamsha_mode"], jd_utc=jd)
    return float(houses["axes"]["Asc"]["lon"])


def _sun_at(context, jd: float, options: Mapping[str, Any]) -> float:
    ctx = replace(context, jd_utc=jd)
    return float(calculate_planets(ctx, ["Su"], ecliptic_mode=options["ecliptic_mode"],
                                   ayanamsha_mode=options["ayanamsha_mode"], node_mode=options["node_mode"])["Su"]["lon"])


_AT = {"start": 0.0, "middle": 0.5, "end": 1.0}


def upagrahas(context, planet_pos, day, day_lord, options, cfg) -> dict[str, Any]:
    """Upagraha：太阳起算的五个（Dhuma 一系）和按时段起算的六个（Kala、Mrityu、Ardhaprahara、Yamaghantaka、Gulika、Mandi）。

    时段类的黄经 = 那一段某个时刻的上升点；取起点、中点还是终点由设置决定（Gulika、Mandi 各自一项，其余共用一项）。
    """
    sun = norm360(planet_pos["Su"]["lon"])
    dhuma = norm360(sun + 133.0 + 20.0 / 60.0)
    vyatipata = norm360(360.0 - dhuma)
    parivesha = norm360(vyatipata + 180.0)
    indrachapa = norm360(360.0 - parivesha)
    upaketu = norm360(indrachapa + 16.0 + 40.0 / 60.0)
    out: dict[str, Any] = {
        "Dh": {"name": "Dhuma", "lon": dhuma},
        "Vy": {"name": "Vyatipata", "lon": vyatipata},
        "Pv": {"name": "Parivesha", "lon": parivesha},
        "Ic": {"name": "Indrachapa", "lon": indrachapa},
        "Uk": {"name": "Upaketu", "lon": upaketu},
    }
    is_day, segs = kalavela_segments(day, day_lord, context.jd_utc)
    tz = context.local_dt.tzinfo
    for code, name, lord in KALAVELAS:
        start, end = segs[lord]
        at = cfg.get("gulika_at") if code == "Gk" else cfg.get("kalavela_at")
        jd = start + (end - start) * _AT.get(at, 0.0)
        out[code] = {"name": name, "lon": _asc_at(context, jd, options), "lord": lord,
                     "start": jd_to_local(start, tz), "end": jd_to_local(end, tz)}
    start, end = segs["Sa"]
    jd = start + (end - start) * _AT.get(cfg.get("mandi_at"), 0.5)
    out["Md"] = {"name": "Mandi", "lon": _asc_at(context, jd, options), "lord": "Sa",
                 "start": jd_to_local(start, tz), "end": jd_to_local(end, tz)}
    return {"is_day": is_day, "points": out}


# ---------------------------------------------------------------- Vishesha Lagna

INDU_KALAS = {"Su": 30, "Mo": 16, "Ma": 6, "Me": 8, "Ju": 10, "Ve": 12, "Sa": 1}


def special_lagnas(context, planet_pos, asc_lon, day, options, cfg) -> dict[str, Any]:
    """BL、HL、GL、Vighati 按出生离日出的时间推进；起点是日出时（或出生时）的太阳，由设置决定。

    BL 每 5 ghati（2 小时）一个星座，HL 每 2.5 ghati（1 小时），GL 每 ghati（24 分），Vighati 每 vighati（24 秒）。
    Varnada 按 BPHS：上升与 HL 各按奇偶从白羊或双鱼数起，同奇偶相加、不同相减，再按上升的奇偶从白羊或双鱼数出去。
    Sree Lagna = 上升 + 月亮在本宿里走过的比例 × 360°。Pranapada = 太阳 + 离日出的 vighati 数 × 2°，
    太阳在定星座时再加 240°，变星座加 120°。Indu Lagna 只有星座。Bhrigu Bindu 是月亮到罗睺的中点。
    """
    seconds = (context.jd_utc - day["sunrise"]) * 86400.0
    minutes = seconds / 60.0
    sun_birth = norm360(planet_pos["Su"]["lon"])
    base = _sun_at(context, day["sunrise"], options) if cfg.get("lagna_base", "sunrise") == "sunrise" else sun_birth
    bl = norm360(base + minutes * 0.25)
    hl = norm360(base + minutes * 0.5)
    gl = norm360(base + minutes * 1.25)
    vg = norm360(base + seconds * 1.25)

    asc = norm360(asc_lon)

    def from_start(lon):
        # 奇数星座从白羊起数（黄经本身），偶数星座从双鱼末尾倒数
        return lon if sign_of(lon) % 2 == 0 else 360.0 - lon

    a, b = from_start(asc), from_start(hl)
    same = (sign_of(asc) % 2) == (sign_of(hl) % 2)
    v = norm360(a + b) if same else abs(a - b)
    vl = norm360(v if sign_of(asc) % 2 == 0 else 360.0 - v)

    moon = norm360(planet_pos["Mo"]["lon"])
    nak_frac = (moon * 3.0 / 40.0) % 1.0
    sl = norm360(asc + nak_frac * 360.0)

    sun_sign = sign_of(sun_birth)
    pp = norm360(sun_birth + seconds / 12.0 + (0.0, 240.0, 120.0)[sun_sign % 3])

    lag_sign, moon_sign = sign_of(asc), sign_of(moon)
    kalas = INDU_KALAS[SIGN_LORDS[(lag_sign + 8) % 12]] + INDU_KALAS[SIGN_LORDS[(moon_sign + 8) % 12]]
    r = kalas % 12 or 12
    indu = (moon_sign + r - 1) % 12

    rahu = norm360(planet_pos["Ra"]["lon"])
    bb = norm360(moon + ((rahu - moon) % 360.0) / 2.0)
    return {
        "BL": {"name": "Bhava Lagna", "lon": bl},
        "HL": {"name": "Hora Lagna", "lon": hl},
        "GL": {"name": "Ghati Lagna", "lon": gl},
        "VG": {"name": "Vighati Lagna", "lon": vg},
        "VL": {"name": "Varnada Lagna", "lon": vl},
        "SL": {"name": "Sree Lagna", "lon": sl},
        "PP": {"name": "Pranapada", "lon": pp},
        "IL": {"name": "Indu Lagna", "lon": indu * 30.0, "sign_only": True},
        "BB": {"name": "Bhrigu Bindu", "lon": bb},
    }


# ---------------------------------------------------------------- 行星战（Graha Yuddha）

WAR_RULES = ("latitude", "declination", "brightness")


def graha_yuddha(context, planet_pos, cfg) -> list[dict[str, Any]]:
    """火、水、木、金、土两两黄经相距不到设置的度数即为行星战。

    胜负：latitude 黄纬偏北者胜（Surya Siddhanta）；declination 赤纬偏北者胜；brightness 较亮者胜（视星等较小）。
    """
    if not cfg.get("enabled", True):
        return []
    orb = float(cfg.get("orb", 1.0))
    rule = cfg.get("rule", "latitude")
    present = [p for p in WAR_PLANETS if p in planet_pos]
    mags: dict[str, float] = {}
    wars = []
    for i, a in enumerate(present):
        for b in present[i + 1:]:
            sep = separation(planet_pos[a]["lon"], planet_pos[b]["lon"])
            if sep >= orb:
                continue
            if rule == "brightness":
                for p in (a, b):
                    if p not in mags:
                        with _SWISS_LOCK:
                            set_ephemeris_path(context.ephe_path)
                            mags[p] = float(swe.pheno_ut(context.jd_utc, SWE_IDS[p], swe.FLG_SWIEPH)[4])
                winner = a if mags[a] < mags[b] else b
            else:
                key = "dec" if rule == "declination" else "lat"
                winner = a if float(planet_pos[a].get(key, 0)) >= float(planet_pos[b].get(key, 0)) else b
            wars.append({"winner": winner, "loser": b if winner == a else a, "sep": sep})
    return wars


# ---------------------------------------------------------------- 历法：凶时、吉时、太阴月、六十年、南北行

RAHU_KALA = (8, 2, 7, 5, 6, 4, 3)        # 星期日起：白天八分里的第几份
YAMAGANDA = (5, 4, 3, 2, 1, 7, 6)
GULIKA_KALA = (7, 6, 5, 4, 3, 2, 1)

MASA_NAMES = ("Chaitra", "Vaishakha", "Jyeshtha", "Ashadha", "Shravana", "Bhadrapada",
              "Ashvina", "Kartika", "Margashirsha", "Pausha", "Magha", "Phalguna")

SAMVATSARA_NAMES = (
    "Prabhava", "Vibhava", "Shukla", "Pramoda", "Prajapati", "Angirasa", "Shrimukha", "Bhava", "Yuva", "Dhatri",
    "Ishvara", "Bahudhanya", "Pramathi", "Vikrama", "Vrisha", "Chitrabhanu", "Svabhanu", "Tarana", "Parthiva", "Vyaya",
    "Sarvajit", "Sarvadhari", "Virodhi", "Vikriti", "Khara", "Nandana", "Vijaya", "Jaya", "Manmatha", "Durmukha",
    "Hevilambi", "Vilambi", "Vikari", "Sharvari", "Plava", "Shubhakrit", "Shobhakrit", "Krodhi", "Vishvavasu", "Parabhava",
    "Plavanga", "Kilaka", "Saumya", "Sadharana", "Virodhikrit", "Paridhavi", "Pramadi", "Ananda", "Rakshasa", "Nala",
    "Pingala", "Kalayukta", "Siddharthi", "Raudra", "Durmati", "Dundubhi", "Rudhirodgari", "Raktakshi", "Krodhana", "Akshaya",
)

KALI_EPOCH_JD = 588465.5                  # Kali Yuga 起点（儒略历公元前 3102 年 2 月 18 日 0 时）
JOVIAN_YEAR_DAYS = 1577917500.0 / 364224.0 / 12.0   # Arya Siddhanta 平均木星走一个星座的天数
SYNODIC_MONTH = 29.530588


def _elongation(jd, ayanamsha_mode, eph):
    p = sidereal_sun_moon(jd, ayanamsha_mode, eph)
    return (p["moon"] - p["sun"]) % 360.0, p["moon_speed"] - p["sun_speed"], p["sun"]


def _new_moon(jd, direction, ayanamsha_mode, eph):
    """jd 之前（direction=-1）或之后（+1）最近的新月时刻，以及那时太阳的恒星黄经。"""
    e, speed, _ = _elongation(jd, ayanamsha_mode, eph)
    t = jd - e / 12.19 if direction < 0 else jd + (360.0 - e) / 12.19
    sun = 0.0
    for _ in range(12):
        e, speed, sun = _elongation(t, ayanamsha_mode, eph)
        diff = ((e + 180.0) % 360.0) - 180.0
        if speed <= 0:
            break
        t -= diff / speed
        if abs(diff) < 1e-7:
            break
    return t, sun


def ayanamsha_value(jd, ayanamsha_mode, eph):
    with _SWISS_LOCK:
        set_ephemeris_path(eph)
        swe.set_sid_mode(_resolve_ayanamsha(ayanamsha_mode))
        return float(swe.get_ayanamsa_ut(jd))


def _span(day, parts, index):
    """白天（日出到日落）分成 parts 份，取第 index 份（1 起）的起止。"""
    length = (day["sunset"] - day["sunrise"]) / parts
    start = day["sunrise"] + (index - 1) * length
    return start, start + length


def calendar_extras(context, day, day_lord, paksha, ayanamsha_mode, cfg, kalavela) -> dict[str, Any]:
    tz = context.local_dt.tzinfo
    eph = context.ephe_path
    local = lambda jd: jd_to_local(jd, tz)
    w = WEEK.index(day_lord)
    abhijit = _span(day, 15, 8)
    periods = {
        "rahu_kala": _span(day, 8, RAHU_KALA[w]),
        "yamaganda": _span(day, 8, YAMAGANDA[w]),
        "gulika_kala": _span(day, 8, GULIKA_KALA[w]),
    }
    out: dict[str, Any] = {key: {"start": local(a), "end": local(b)} for key, (a, b) in periods.items()}
    out["abhijit"] = {"start": local(abhijit[0]), "end": local(abhijit[1]),
                      "excluded": bool(cfg.get("abhijit_wed", True)) and day_lord == "Me"}
    is_day, segs = kalavela
    out["kalavela"] = {"is_day": is_day, "items": [
        {"code": code, "name": name, "start": local(segs[lord][0]), "end": local(segs[lord][1])}
        for code, name, lord in KALAVELAS
    ]}

    # 太阴月：前后两个新月时太阳所在的恒星星座。两个新月之间没有太阳换座（同一星座）即为闰月（Adhika）。
    jd = context.jd_utc
    prev_nm, sun_prev = _new_moon(jd, -1, ayanamsha_mode, eph)
    next_nm, sun_next = _new_moon(jd, 1, ayanamsha_mode, eph)
    amanta = (sign_of(sun_prev) + 1) % 12           # 新月时太阳在双鱼 → Chaitra
    adhika = sign_of(sun_prev) == sign_of(sun_next)
    index = amanta
    if cfg.get("masa", "amanta") == "purnimanta" and paksha == "Krishna":
        index = (amanta + 1) % 12                     # 满月起算：黑分属于下一个月
    out["masa"] = {"index": index + 1, "name": MASA_NAMES[index], "adhika": adhika}

    # 六十年：南印按太阴年（Chaitra 白分初一起，Shaka 年 + 11）；北印按平均木星（Surya Siddhanta 体系）。
    if cfg.get("samvatsara", "lunar") == "jovian":
        idx = (27 + int(math.floor((jd - KALI_EPOCH_JD) / JOVIAN_YEAR_DAYS)) - 1) % 60
    else:
        chaitra = prev_nm - amanta * SYNODIC_MONTH
        year = swe.revjul(chaitra, swe.GREG_CAL)[0]
        idx = (year - 78 + 11) % 60
    out["samvatsara"] = {"index": idx + 1, "name": SAMVATSARA_NAMES[idx]}

    # 南北行：恒星（Makara Sankranti 到 Karka Sankranti 为北行）或回归（冬至到夏至为北行）。
    sun_sid = sidereal_sun_moon(jd, ayanamsha_mode, eph)["sun"]
    if cfg.get("ayana", "sidereal") == "tropical":
        trop = norm360(sun_sid + ayanamsha_value(jd, ayanamsha_mode, eph))
        north = trop >= 270.0 or trop < 90.0
    else:
        north = sign_of(sun_sid) in (9, 10, 11, 0, 1, 2)
    out["ayana"] = {"name": "Uttarayana" if north else "Dakshinayana"}
    return out
