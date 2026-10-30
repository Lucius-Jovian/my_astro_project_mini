"""Panchanga（五支历）：Vara、Tithi、Nakshatra、Yoga、Karana，以及每一支结束的时刻。

约定：
- Tithi、Karana 只看月亮与太阳的距角，与黄道体系无关。
- Nakshatra、Yoga 必须用恒星黄经：不论星盘选的是哪种黄道，这里都按所选岁差体系换成恒星黄道计算。
- Vara 按日出换日（日出前出生算前一天），直接沿用值日星的结果。
- 结束时刻：用太阳、月亮的日速度反复逼近（牛顿法，通常 3 到 4 次就精确到 1 秒以内）。
"""

from __future__ import annotations

import math
from typing import Any

from common.astro import jd_to_local, sidereal_sun_moon

from .basics import NAKSHATRAS, NAKSHATRA_SPAN

VARA_NAMES = {
    "Su": "Ravivara", "Mo": "Somavara", "Ma": "Mangalavara", "Me": "Budhavara",
    "Ju": "Guruvara", "Ve": "Shukravara", "Sa": "Shanivara",
}

TITHI_NAMES = (
    "Pratipada", "Dwitiya", "Tritiya", "Chaturthi", "Panchami", "Shashthi", "Saptami", "Ashtami",
    "Navami", "Dashami", "Ekadashi", "Dwadashi", "Trayodashi", "Chaturdashi",
)

YOGA_NAMES = (
    "Vishkambha", "Priti", "Ayushman", "Saubhagya", "Shobhana", "Atiganda", "Sukarma", "Dhriti", "Shula",
    "Ganda", "Vriddhi", "Dhruva", "Vyaghata", "Harshana", "Vajra", "Siddhi", "Vyatipata", "Variyan",
    "Parigha", "Shiva", "Siddha", "Sadhya", "Shubha", "Shukla", "Brahma", "Indra", "Vaidhriti",
)

KARANA_MOVABLE = ("Bava", "Balava", "Kaulava", "Taitila", "Gara", "Vanija", "Vishti")

_EPS = 1e-9


def tithi_name(index: int) -> tuple[str, str]:
    """index 0–29 → (Paksha, 名称)。第 15 个是 Purnima，第 30 个是 Amavasya。"""
    paksha = "Shukla" if index < 15 else "Krishna"
    n = index % 15
    if n == 14:
        return paksha, "Purnima" if index < 15 else "Amavasya"
    return paksha, TITHI_NAMES[n]


def karana_name(index: int) -> str:
    """index 0–59（每个 Tithi 两个 Karana）。第 1 个 Kimstughna，最后三个 Shakuni、Chatushpada、Naga，其余七个循环。"""
    if index == 0:
        return "Kimstughna"
    if index >= 57:
        return ("Shakuni", "Chatushpada", "Naga")[index - 57]
    return KARANA_MOVABLE[(index - 1) % 7]


def _quantities(jd: float, ayanamsha_mode, ephe_path) -> dict[str, tuple[float, float]]:
    """各支对应的角度和角速度（度、度/日）。"""
    p = sidereal_sun_moon(jd, ayanamsha_mode, ephe_path)
    elong = (p["moon"] - p["sun"]) % 360.0
    return {
        "tithi": (elong, p["moon_speed"] - p["sun_speed"]),
        "karana": (elong, p["moon_speed"] - p["sun_speed"]),
        "nakshatra": (p["moon"], p["moon_speed"]),
        "yoga": ((p["moon"] + p["sun"]) % 360.0, p["moon_speed"] + p["sun_speed"]),
    }


def _end_jd(jd: float, key: str, span: float, ayanamsha_mode, ephe_path) -> float | None:
    """从 jd 起，这个角度走到下一个 span 的整数倍（这一支结束）的时刻。"""
    value, speed = _quantities(jd, ayanamsha_mode, ephe_path)[key]
    target = (math.floor(value / span + _EPS) + 1) * span
    remaining = target - value
    t = jd
    for _ in range(8):
        if speed <= 0:
            return None
        step = remaining / speed
        t += step
        value_t, speed = _quantities(t, ayanamsha_mode, ephe_path)[key]
        # 与目标的差（-180, 180]：目标是 360 时 value_t 可能已绕回 0 附近
        remaining = ((target - value_t + 180.0) % 360.0) - 180.0
        if abs(remaining) < 1e-6:
            break
    return t


def calculate_panchanga(context, day_lord: str, ayanamsha_mode) -> dict[str, Any]:
    jd = context.jd_utc
    eph = context.ephe_path
    tz = context.local_dt.tzinfo
    q = _quantities(jd, ayanamsha_mode, eph)

    def end_local(key, span):
        end = _end_jd(jd, key, span, ayanamsha_mode, eph)
        return jd_to_local(end, tz) if end is not None else None

    elong = q["tithi"][0]
    tithi_index = int(math.floor(elong / 12.0 + _EPS)) % 30
    paksha, tname = tithi_name(tithi_index)

    moon = q["nakshatra"][0]
    raw = moon / NAKSHATRA_SPAN
    nak_index = int(math.floor(raw + _EPS)) % 27
    nak_pada = min(4, int(math.floor((raw - math.floor(raw + _EPS)) * 4.0 + _EPS)) + 1)

    yoga_lon = q["yoga"][0]
    yoga_index = int(math.floor(yoga_lon / NAKSHATRA_SPAN + _EPS)) % 27

    karana_index = int(math.floor(elong / 6.0 + _EPS)) % 60

    return {
        "vara": {"lord": day_lord, "name": VARA_NAMES.get(day_lord, day_lord)},
        "tithi": {"index": tithi_index + 1, "paksha": paksha, "name": tname,
                  "progress": (elong % 12.0) / 12.0, "end": end_local("tithi", 12.0)},
        "nakshatra": {"index": nak_index + 1, "name": NAKSHATRAS[nak_index][0], "cn": NAKSHATRAS[nak_index][1],
                      "pada": nak_pada, "end": end_local("nakshatra", NAKSHATRA_SPAN)},
        "yoga": {"index": yoga_index + 1, "name": YOGA_NAMES[yoga_index], "end": end_local("yoga", NAKSHATRA_SPAN)},
        "karana": {"index": karana_index + 1, "name": karana_name(karana_index), "end": end_local("karana", 6.0)},
    }
