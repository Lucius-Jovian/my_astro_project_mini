"""印度占星的通用基础：星座、星座内度分秒、27 星宿、宿主星、Pada（四分之一宿）。

这些都是由黄经直接算出来的几何划分，不依赖任何查表文件，KP、Dasha 和页面上的
行星 / 宫位表都从这里取（KP 只在这个基础上再查 Sub / Sub-Sub 星主）。

约定：
- 黄经按当前所选的黄道体系给出（恒星黄道或回归黄道都可以），这里不关心来源。
- 星座：每 30° 一个，0 = 白羊。
- 星宿：每 13°20′（= 40/3 度）一个，0 = Ashwini。宿主星按 Vimshottari 顺序
  Ke Ve Su Mo Ma Ra Ju Sa Me 循环三遍。
- Pada：每个星宿四等分，每份 3°20′，编号 1–4。
- 度分秒一律截断（不四舍五入）：29°59′59.9″ 显示成 29°59′59″，不会跳到下一个星座，
  与星盘上的显示规则一致。
"""

from __future__ import annotations

import math
from typing import Any, Mapping

SIGNS = (
    "Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo",
    "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces",
)
SIGNS_CN = ("白羊", "金牛", "双子", "巨蟹", "狮子", "处女", "天秤", "天蝎", "射手", "摩羯", "水瓶", "双鱼")

# 星座主星（传统七曜，印度占星不用外行星做星座主）。
SIGN_LORDS = ("Ma", "Ve", "Me", "Mo", "Su", "Me", "Ve", "Ma", "Ju", "Sa", "Sa", "Ju")

# 27 星宿：(梵文转写, 中文宿名)。
NAKSHATRAS = (
    ("Ashwini", "娄宿"), ("Bharani", "胃宿"), ("Krittika", "昴宿"),
    ("Rohini", "毕宿"), ("Mrigashira", "觜宿"), ("Ardra", "参宿"),
    ("Punarvasu", "井宿"), ("Pushya", "鬼宿"), ("Ashlesha", "柳宿"),
    ("Magha", "星宿"), ("Purva Phalguni", "张宿"), ("Uttara Phalguni", "翼宿"),
    ("Hasta", "轸宿"), ("Chitra", "角宿"), ("Swati", "亢宿"),
    ("Vishakha", "氐宿"), ("Anuradha", "房宿"), ("Jyeshtha", "心宿"),
    ("Mula", "尾宿"), ("Purva Ashadha", "箕宿"), ("Uttara Ashadha", "斗宿"),
    ("Shravana", "女宿"), ("Dhanishta", "虚宿"), ("Shatabhisha", "危宿"),
    ("Purva Bhadrapada", "室宿"), ("Uttara Bhadrapada", "壁宿"), ("Revati", "奎宿"),
)

# Vimshottari 顺序的宿主星（每 9 个星宿循环一次）。
NAKSHATRA_LORD_CYCLE = ("Ke", "Ve", "Su", "Mo", "Ma", "Ra", "Ju", "Sa", "Me")

NAKSHATRA_SPAN = 40.0 / 3.0          # 13°20′
PADA_SPAN = NAKSHATRA_SPAN / 4.0     # 3°20′

# 浮点误差保护：刚好落在分界线上、因为浮点运算略小于分界的值，算到分界线后面那一格。
_EPS = 1e-9


def norm360(lon: float) -> float:
    return float(lon) % 360.0


def sign_index(lon: float) -> int:
    return int(math.floor(norm360(lon) / 30.0 + _EPS)) % 12


def _nakshatra_position(lon: float) -> tuple[int, float]:
    """(星宿序号 0–26, 在本星宿里走过的比例 0–1)。用 lon × 3 / 40 计算，避免 13.333… 这个近似小数带来的误差。"""
    raw = norm360(lon) * 3.0 / 40.0
    whole = int(math.floor(raw + _EPS))
    within = min(max(raw - whole, 0.0), 1.0 - 1e-12)
    return whole % 27, within


def nakshatra_index(lon: float) -> int:
    """0–26。"""
    return _nakshatra_position(lon)[0]


def pada(lon: float) -> int:
    """1–4。"""
    within = _nakshatra_position(lon)[1]
    return min(4, int(math.floor(within * 4.0 + _EPS)) + 1)


def nakshatra_lord(index: int) -> str:
    return NAKSHATRA_LORD_CYCLE[int(index) % 9]


def dms(value: float, *, signed: bool = False) -> str:
    """十进制度 → 度分秒字符串（截断到整秒）。signed=True 时负数带负号、正数带正号。"""
    v = float(value)
    total = int(math.floor(abs(v) * 3600.0 + 1e-6))
    sign = "-" if v < 0 and total else ("+" if signed else "")
    d, rest = divmod(total, 3600)
    m, s = divmod(rest, 60)
    return f"{sign}{d}°{m:02d}′{s:02d}″"


def describe(lon: float, speed: float | None = None) -> dict[str, Any]:
    """一个点的印度占星基础信息。speed 不为 None 时附带顺行 / 逆行。"""
    x = norm360(lon)
    s = sign_index(x)
    deg = x - s * 30.0
    if not 0.0 <= deg < 30.0:                              # 刚好在星座分界上（含 360° 绕回 0°）时的浮点误差
        deg = 0.0
    n = nakshatra_index(x)
    info: dict[str, Any] = {
        "lon": x,
        "sign_index": s,
        "sign": SIGNS[s],
        "sign_cn": SIGNS_CN[s],
        "sign_lord": SIGN_LORDS[s],
        "degree": deg,
        "dms": dms(deg),
        "nakshatra_index": n + 1,
        "nakshatra": NAKSHATRAS[n][0],
        "nakshatra_cn": NAKSHATRAS[n][1],
        "star_lord": nakshatra_lord(n),
        "pada": pada(x),
    }
    if speed is not None:
        info["speed"] = float(speed)
        info["retrograde"] = float(speed) < 0
        info["motion"] = "逆行" if float(speed) < 0 else "顺行"
    return info


def describe_points(points: Mapping[str, Mapping[str, Any]], *, with_motion: bool) -> list[dict[str, Any]]:
    """{名称: {"lon", "speed", ...}} → 按原顺序的行列表，每行多一个 name。"""
    rows = []
    for name, point in points.items():
        speed = point.get("speed") if with_motion else None
        rows.append({"name": str(name), **describe(float(point["lon"]), speed)})
    return rows
