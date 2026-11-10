"""Shadbala（六种力量），按 BPHS 第 27 章与 B. V. Raman《Graha and Bhava Balas》的常用算法。

单位：virupa（1 rupa = 60 virupa）。只算七曜。

- Sthana：Uccha、Saptavargaja（D1 D2 D3 D7 D9 D12 D30，一律用 Parashara 算法，与分盘设置无关）、
  Ojayugma、Kendradi（按整宫）、Drekkana
- Dig：离各自得力的角点（Ju Me 上升，Su Ma 天顶，Sa 下降，Mo Ve 天底）越近越强
- Kala：Nathonnatha（按太阳时角）、Paksha（月亮加倍）、Tribhaga、Abda、Masa、Vara、Hora、Ayana（太阳加倍）、Yuddha
- Cheshta：Ma Me Ju Ve Sa 用 Cheshta Kendra（平均黄经取 J2000 平均根数）；太阳取 Ayana、月亮取 Paksha（都不加倍）
- Naisargika：固定值
- Drik：BPHS 的分级相位值（火、木、土的特殊相位另加），吉星为正、凶星为负，合计除以 4

Ayana、Cheshta 用回归黄经（恒星黄经加岁差）；星座类的判断用星盘所选黄道的黄经。
"""

from __future__ import annotations

import math
from typing import Any, Mapping

import swisseph as swe

from .jyotish import P7, SIGN_LORDS, WEEK, compound_rel, deg_in_sign, norm360, separation, sign_of

NAISARGIKA = {p: 60.0 * k / 7.0 for p, k in zip(("Sa", "Ma", "Me", "Ju", "Ve", "Mo", "Su"), range(1, 8))}
REQUIRED = {"Su": 5.0, "Mo": 6.0, "Ma": 5.0, "Me": 7.0, "Ju": 6.5, "Ve": 5.5, "Sa": 5.0}
DEBILITATION = {"Su": 190.0, "Mo": 213.0, "Ma": 118.0, "Me": 345.0, "Ju": 275.0, "Ve": 177.0, "Sa": 20.0}
OWN = {"Su": (4,), "Mo": (3,), "Ma": (0, 7), "Me": (2, 5), "Ju": (8, 11), "Ve": (1, 6), "Sa": (9, 10)}
MT = {"Su": (4, 0, 20), "Mo": (1, 4, 30), "Ma": (0, 0, 12), "Me": (5, 16, 20), "Ju": (8, 0, 10), "Ve": (6, 0, 15), "Sa": (10, 0, 20)}
SAPTA_POINTS = {2: 20.0, 1: 15.0, 0: 10.0, -1: 4.0, -2: 2.0}
KALI_JDN = 588466                       # Kali Yuga 第一天（星期五）

# J2000 平均黄经（回归，度）与日运动：太阳，以及水金火木土的日心平均黄经（Meeus）
MEAN = {
    "Su": (280.46646, 0.98564736),
    "Me": (252.250906, 4.0923344368),
    "Ve": (181.979801, 1.6021302244),
    "Ma": (355.433275, 0.5240207766),
    "Ju": (34.351484, 0.0830853001),
    "Sa": (50.077471, 0.0334442282),
}


def varga_sign(lon: float, n: int) -> int:
    """Parashara 算法的 D2 D3 D7 D9 D12 D30 星座（Shadbala 专用）。"""
    s, d = sign_of(lon), deg_in_sign(lon)
    odd = s % 2 == 0
    if n == 1:
        return s
    if n == 2:
        first = d < 15
        return (4 if first else 3) if odd else (3 if first else 4)
    if n == 3:
        return (s + 4 * min(2, int(d // 10))) % 12
    if n == 7:
        return ((s if odd else s + 6) + min(6, int(d * 7 / 30))) % 12
    if n == 9:
        return (s + (0, 8, 4)[s % 3] + min(8, int(d * 9 / 30))) % 12
    if n == 12:
        return (s + min(11, int(d * 12 / 30))) % 12
    if n == 30:
        segs = ((5, 0), (10, 10), (18, 8), (25, 2), (30, 6)) if odd else ((5, 1), (12, 5), (20, 11), (25, 9), (30, 7))
        for end, sign in segs:
            if d < end:
                return sign
        return segs[-1][1]
    raise ValueError(n)


def in_mt(code: str, lon: float) -> bool:
    m = MT.get(code)
    return bool(m) and sign_of(lon) == m[0] and m[1] <= deg_in_sign(lon) < m[2]


def drishti(angle: float) -> float:
    a = norm360(angle)
    if a < 30:
        return 0.0
    if a < 60:
        return (a - 30) / 2
    if a < 90:
        return a - 60 + 15
    if a < 120:
        return (120 - a) / 2 + 30
    if a < 150:
        return 150 - a
    if a < 180:
        return (a - 150) * 2
    if a < 300:
        return (300 - a) / 2
    return 0.0


def special_drishti(code: str, angle: float) -> float:
    a = norm360(angle)
    if code == "Ma" and (90 <= a <= 120 or 210 <= a <= 240):
        return 15.0
    if code == "Ju" and (120 <= a <= 150 or 240 <= a <= 270):
        return 30.0
    if code == "Sa" and (60 <= a <= 90 or 270 <= a <= 300):
        return 45.0
    return 0.0


def mercury_benefic(planet_pos, signs, rule: str) -> bool:
    if rule == "benefic":
        return True
    return not any(signs.get(m) == signs["Me"] for m in ("Su", "Ma", "Sa", "Ra", "Ke") if m in signs)


def shadbala(context, planet_pos, house_result, day, day_lord, hora_lord, ayanamsha, wars, cfg) -> dict[str, Any]:
    pos = {p: norm360(planet_pos[p]["lon"]) for p in P7}
    signs = {p: sign_of(v) for p, v in pos.items()}
    for node in ("Ra", "Ke"):
        if node in planet_pos:
            signs[node] = sign_of(planet_pos[node]["lon"])
    asc = norm360(house_result["axes"]["Asc"]["lon"])
    mc = norm360(house_result["axes"]["MC"]["lon"])
    lagna = sign_of(asc)
    jd = context.jd_utc
    elong = (pos["Mo"] - pos["Su"]) % 360.0
    sep_sm = separation(pos["Mo"], pos["Su"])
    me_good = mercury_benefic(planet_pos, signs, cfg.get("mercury", "assoc"))
    benefic = {"Ju": True, "Ve": True, "Me": me_good, "Mo": elong < 180.0, "Su": False, "Ma": False, "Sa": False}

    rows: dict[str, dict[str, float]] = {p: {} for p in P7}

    # ---- Sthana
    for p in P7:
        r = rows[p]
        r["uccha"] = separation(pos[p], DEBILITATION[p]) / 3.0
        total = 0.0
        for n in (1, 2, 3, 7, 9, 12, 30):
            s = varga_sign(pos[p], n)
            if n == 1 and in_mt(p, pos[p]):
                total += 45.0
            elif s in OWN[p]:
                total += 30.0
            else:
                total += SAPTA_POINTS[compound_rel(signs, p, SIGN_LORDS[s])]
        r["saptavargaja"] = total
        even_planet = p in ("Mo", "Ve")
        r["ojayugma"] = sum(15.0 for s in (signs[p], varga_sign(pos[p], 9)) if (s % 2 == 1) == even_planet)
        house = (signs[p] - lagna) % 12 + 1
        r["kendradi"] = 60.0 if house in (1, 4, 7, 10) else 30.0 if house in (2, 5, 8, 11) else 15.0
        decan = min(2, int(deg_in_sign(pos[p]) // 10))
        r["drekkana"] = 15.0 if decan == {"Su": 0, "Ma": 0, "Ju": 0, "Me": 1, "Sa": 1, "Mo": 2, "Ve": 2}[p] else 0.0
        r["sthana"] = r["uccha"] + r["saptavargaja"] + r["ojayugma"] + r["kendradi"] + r["drekkana"]

    # ---- Dig
    strong = {"Ju": asc, "Me": asc, "Su": mc, "Ma": mc, "Sa": norm360(asc + 180), "Mo": norm360(mc + 180), "Ve": norm360(mc + 180)}
    for p in P7:
        rows[p]["dig"] = (180.0 - separation(pos[p], strong[p])) / 3.0

    # ---- Kala
    lst = swe.sidtime(jd) * 15.0 + context.lon
    hour_angle = abs(((lst - float(planet_pos["Su"]["ra"])) + 180.0) % 360.0 - 180.0)
    is_day = day["sunrise"] <= jd < day["sunset"]
    if is_day:
        third = min(2, int((jd - day["sunrise"]) / ((day["sunset"] - day["sunrise"]) / 3)))
        tri_lord = ("Me", "Su", "Sa")[third]
    else:
        third = min(2, max(0, int((jd - day["sunset"]) / ((day["next_sunrise"] - day["sunset"]) / 3))))
        tri_lord = ("Mo", "Ve", "Ma")[third]
    jdn = int(math.floor(day["sunrise"] + 0.5 + context.tz_offset / 24.0))
    ahar = jdn - KALI_JDN
    abda_lord = WEEK[(KALI_JDN + 360 * (ahar // 360) + 1) % 7]
    masa_lord = WEEK[(KALI_JDN + 30 * (ahar // 30) + 1) % 7]
    eps = context.eps
    for p in P7:
        r = rows[p]
        if p == "Me":
            r["nathonnatha"] = 60.0
        elif p in ("Su", "Ju", "Ve"):
            r["nathonnatha"] = 60.0 * (1.0 - hour_angle / 180.0)
        else:
            r["nathonnatha"] = 60.0 * hour_angle / 180.0
        paksha = sep_sm / 3.0 if (benefic[p] or p == "Mo") else 60.0 - sep_sm / 3.0
        r["paksha"] = paksha * (2.0 if p == "Mo" else 1.0)
        r["tribhaga"] = 60.0 if p == "Ju" or p == tri_lord else 0.0
        r["abda"] = 15.0 if p == abda_lord else 0.0
        r["masa"] = 30.0 if p == masa_lord else 0.0
        r["vara"] = 45.0 if p == day_lord else 0.0
        r["hora"] = 60.0 if p == hora_lord else 0.0
        dec = float(planet_pos[p].get("dec", 0.0))
        if p == "Me":
            ayana = (eps + abs(dec)) / (2 * eps) * 60.0
        elif p in ("Mo", "Sa"):
            ayana = (eps - dec) / (2 * eps) * 60.0
        else:
            ayana = (eps + dec) / (2 * eps) * 60.0
        ayana = min(60.0, max(0.0, ayana))
        r["ayana_base"] = ayana
        r["ayana"] = ayana * (2.0 if p == "Su" else 1.0)

    # ---- Cheshta
    days = jd - 2451545.0
    mean = {k: norm360(a + b * days) for k, (a, b) in MEAN.items()}
    for p in P7:
        r = rows[p]
        if p == "Su":
            r["cheshta"] = r["ayana_base"]
        elif p == "Mo":
            r["cheshta"] = sep_sm / 3.0
        else:
            true_trop = norm360(pos[p] + ayanamsha)
            if p in ("Me", "Ve"):
                seeghra, madhya = mean[p], mean["Su"]
            else:
                seeghra, madhya = mean["Su"], mean[p]
            avg = madhya + (((true_trop - madhya) + 540.0) % 360.0 - 180.0) / 2.0
            kendra = norm360(seeghra - avg)
            if kendra > 180.0:
                kendra = 360.0 - kendra
            r["cheshta"] = kendra / 3.0
        r["naisargika"] = NAISARGIKA[p]

    # ---- Drik
    for p in P7:
        total = 0.0
        for q in P7:
            if q == p:
                continue
            angle = pos[p] - pos[q]
            value = drishti(angle) + special_drishti(q, angle)
            total += value if benefic[q] else -value
        rows[p]["drik"] = total / 4.0

    # ---- Yuddha（行星战：两者其余各项合计之差，胜者加、败者减）
    def subtotal(p):
        r = rows[p]
        kala = sum(r[k] for k in ("nathonnatha", "paksha", "tribhaga", "abda", "masa", "vara", "hora", "ayana"))
        return r["sthana"] + r["dig"] + kala + r["cheshta"] + r["naisargika"] + r["drik"]

    for p in P7:
        rows[p]["yuddha"] = 0.0
    for war in wars or []:
        w, l = war["winner"], war["loser"]
        if w in rows and l in rows:
            diff = abs(subtotal(w) - subtotal(l))
            rows[w]["yuddha"] += diff
            rows[l]["yuddha"] -= diff

    out = {}
    for p in P7:
        r = rows[p]
        r["kala"] = sum(r[k] for k in ("nathonnatha", "paksha", "tribhaga", "abda", "masa", "vara", "hora", "ayana", "yuddha"))
        r["total"] = r["sthana"] + r["dig"] + r["kala"] + r["cheshta"] + r["naisargika"] + r["drik"]
        r["rupa"] = r["total"] / 60.0
        r["required"] = REQUIRED[p]
        r["ratio"] = r["rupa"] / REQUIRED[p]
        r["ishta"] = math.sqrt(max(0.0, r["uccha"] * r["cheshta"]))
        r["kashta"] = math.sqrt(max(0.0, (60.0 - r["uccha"]) * (60.0 - r["cheshta"])))
        r.pop("ayana_base", None)
        out[p] = r
    return out
