# systems/vedic/astro/dasha_vimshottari.py
"""Vimshottari 大运（Dasha）计算——懒加载模型。

本文件合并了原来的 dasha_Vimshottari.py + dasha_Vimshottari_api.py，并针对
"本地 Flask 后端 + HTML 前端"的未来架构做了彻底重构，核心设计如下：

- 整棵大运树只有一个自相似的细分元语 `divide_dasha_interval()`：把一段
  `DashaInterval` 按 Vimshottari 固定比例切成后续 9 段，从其自身所在行星
  开始按九星固定顺序循环。第一层（Mahadasha）只是对一个"虚拟根区间"
  （行星 = 命主星宿主星，时长 = 120 年整周期）调用一次这个元语的结果；
  点击展开下一层，只是对被点击的那个区间再调用一次同一个元语——
  没有第二套逻辑，也不存在"树只能算到第几层"的上限。

- 这个元语本身是纯函数：不读文件、不依赖出生数据、不知道自己在树的
  第几层。只有算"根区间"这一步需要出生数据、星宿表和 days_in_year。
  这让未来的 Flask `/dasha/expand` 路由可以完全无状态——只需要被点击
  区间自带的 (行星, 起点, 时长) 三元组，不需要重新查一遍星宿表，也不
  需要知道任何出生数据。

- 不再自己解析 birth_time_str / timezone_str / calendar——直接吃
  `core.parse_time_geo()` 已经算好的 `AstroContext`（`context.local_dt`
  已经是带时区、且已按 calendar 转换成格里历的 datetime），避免和
  core.py 里的时区/历法解析逻辑产生第二套实现（本次重构不改动 core.py
  和 kp.py 本身）。

- 全程用 Decimal 承载时长/秒数，不经过 `timedelta.total_seconds()`
  （返回 float）这样的往返转换，也不用近似小数常量表示 13°20′——
  这两点都是原代码里真实存在、会悄悄吃掉精度的地方，这次一并修掉。
  已经用一份合成的星宿表跑过多组边界回归测试（含 Revati 跨 360°/0°），
  与原算法的行星序列和起止时刻完全对得上（误差仅为原代码自身 float
  转换带来的 1 微秒噪声）。

- 不再提供整表 CSV 导出 / Colab 下载（原 create_dasha_table 的这部分
  职责）。如果以后又需要"一次性导出到第 N 层"的能力，在
  `divide_dasha_interval` 之上做一个简单的广度优先迭代包装即可，
  不需要另起一套算法。
"""

from __future__ import annotations

import csv
import os
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal, localcontext
from functools import lru_cache, wraps
from importlib.resources import files
from pathlib import Path
from typing import Any

from common.astro.core import AstroContext

# ---------------------------------------------------------------------------
# 常量：九星固定周期与顺序（Vimshottari 120 年整周期）
# ---------------------------------------------------------------------------

#: 九星的固定循环顺序（钦定不变）。
PLANET_ORDER: tuple[str, ...] = ("Ke", "Ve", "Su", "Mo", "Ma", "Ra", "Ju", "Sa", "Me")

#: 每颗星在完整 120 年周期中分得的年数。
PLANET_YEARS: dict[str, int] = {
    "Ke": 7, "Ve": 20, "Su": 6, "Mo": 10, "Ma": 7,
    "Ra": 18, "Ju": 16, "Sa": 19, "Me": 17,
}

# 由 PLANET_ORDER 派生，避免像原代码那样把"年数"和"下一颗星"分别写在
# 两处、容易改一处忘改另一处。
_NEXT_PLANET: dict[str, str] = {
    planet: PLANET_ORDER[(index + 1) % len(PLANET_ORDER)]
    for index, planet in enumerate(PLANET_ORDER)
}

TOTAL_CYCLE_YEARS: int = sum(PLANET_YEARS.values())
assert TOTAL_CYCLE_YEARS == 120, "九星年数之和必须等于120年整周期"

# 13°20′ = 40/3 度，是每个星宿的固定跨度。原代码用 Decimal('13.333333333333334')
# 这样一个截断的十进制近似值去做除法；13°20′其实是精确的有理数 40/3，
# "除以 40/3"等价于"乘以 3/40"——用这个精确分数运算，彻底避免近似小数
# 带来的舍入误差（虽然实际量级很小，但既然要求不丢精度，就顺手修掉）。
_NAKSHATRA_SPAN_NUMERATOR = Decimal(3)
_NAKSHATRA_SPAN_DENOMINATOR = Decimal(40)


# ---------------------------------------------------------------------------
# 精度保护：确保 Decimal 运算有足够精度，且不污染全局 Decimal 上下文
# ---------------------------------------------------------------------------

def _decimal_precision(func):
    """让被装饰函数在执行期间使用 28 位有效数字（Python decimal 模块的默认
    精度，足够覆盖本模块所有秒数/时长运算），且不依赖调用方或本进程其余
    代码是否改过全局精度设置，也不会反过来影响它们——用 `localcontext()`
    临时切换，函数返回后自动还原。比原代码在函数体内直接
    `getcontext().prec = 20`（全局、持久生效）更安全。
    """
    @wraps(func)
    def wrapper(*args, **kwargs):
        with localcontext() as ctx:
            ctx.prec = 28
            return func(*args, **kwargs)
    return wrapper


def _decimal_seconds_to_timedelta(seconds: Decimal) -> timedelta:
    """把任意精度的秒数(Decimal)精确拆分成天/秒/微秒再构造 timedelta，
    全程不经过 float——这是本模块构造 timedelta 的唯一入口，避免出现
    像原代码 `timedelta(seconds=float(x))` 那样，在时间跨度较大时把
    Decimal 的精度在这一步悄悄丢给 float 舍入。
    """
    with localcontext() as ctx:
        ctx.prec = 28
        days, remainder = divmod(seconds, Decimal(86400))
        whole_seconds = int(remainder)
        microseconds = int((remainder - whole_seconds) * Decimal(1_000_000))
        return timedelta(days=int(days), seconds=whole_seconds, microseconds=microseconds)


# ---------------------------------------------------------------------------
# 星宿表：加载一次、进程内缓存，约定与 kp.py 的 _default_table_path 一致
# ---------------------------------------------------------------------------

def _default_star_table_path() -> Path:
    """解析 data/star.csv 的路径。查找顺序与 kp.py 里
    `_default_table_path` 完全一致：环境变量 -> 本地开发目录 -> 已安装包
    的资源目录，方便两个模块的行为保持一致、也方便同样支持环境变量覆盖。
    """
    env_path = os.getenv("QUANT_ASTRO_STAR_TABLE")
    if env_path:
        return Path(env_path).expanduser().resolve()

    local = Path(__file__).resolve().parent / "data" / "star.csv"
    if local.exists():
        return local

    package_names = [name for name in (__package__,) if name]
    for package_name in package_names:
        try:
            candidate = Path(str(files(package_name).joinpath("data/star.csv")))
            if candidate.exists():
                return candidate
        except (ModuleNotFoundError, TypeError):
            continue
    raise FileNotFoundError(
        "找不到 data/star.csv。请把原来 quant_astro/data 里的文件复制到 systems/vedic/astro/data/，"
        "或设置环境变量 QUANT_ASTRO_STAR_TABLE 指向该文件。"
    )


@lru_cache(maxsize=8)
def _load_star_table_cached(path_text: str) -> tuple[dict[str, Any], ...]:
    """读取并解析星宿表；同一路径在整个进程生命周期内只读取、只解析一次
    ——原代码每次调用都重新打开一遍 CSV，在"点一下就发一次请求"的 Flask
    场景下是纯粹的浪费。

    'To' 为 0 的行（表示这个星宿跨越 360°/0° 边界，即 Revati）在加载时就
    近归一化成 360，后面查表就不再需要为它单独写一个"跨界"的判断分支
    ——这个手法和 kp.py 里处理 sub-sub 表的方式完全一致。
    """
    rows: list[dict[str, Any]] = []
    with Path(path_text).open("r", encoding="utf-8-sig", newline="") as handle:
        for source in csv.DictReader(handle):
            from_deg = Decimal(source["From"].strip())
            to_raw = Decimal(source["To"].strip())
            to_deg = Decimal(360) if to_raw == 0 else to_raw
            rows.append({
                "from": from_deg,
                "to": to_deg,
                "star_lord": source["Star-Lord"].strip(),
            })
    if not rows:
        raise ValueError(f"星宿表为空：{path_text}")
    return tuple(rows)


@_decimal_precision
def _locate_nakshatra(moon_lon: float, *, table_path: str | Path | None = None) -> tuple[Decimal, str]:
    """定位月亮黄经所在星宿，返回 (该星宿内已走过的角度所占比例[0,1), 星宿主星)。

    这一步只关心几何位置，完全不涉及 days_in_year 或秒数换算——那是
    调用方 `_compute_dasha_root` 的事，原代码把两件事揉在一个函数里，
    这里拆开让每个函数只做一件事。
    """
    path = Path(table_path).expanduser().resolve() if table_path else _default_star_table_path()
    rows = _load_star_table_cached(str(path))
    lon = Decimal(str(moon_lon)) % Decimal(360)
    for row in rows:
        if row["from"] <= lon < row["to"]:
            elapsed_degrees = lon - row["from"]
            elapsed_fraction = (elapsed_degrees * _NAKSHATRA_SPAN_NUMERATOR) / _NAKSHATRA_SPAN_DENOMINATOR
            return elapsed_fraction, row["star_lord"]
    raise LookupError(f"星宿表中没有覆盖黄经 {lon}° 的区间。")


# ---------------------------------------------------------------------------
# 数据结构：一个大运区间
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class DashaInterval:
    """一个大运区间。``duration_seconds`` 全程用 Decimal 承载，不依赖从
    start/end 反推（那样会经过 `timedelta.total_seconds()` 变成 float，
    见模块顶部说明）。

    这是本模块唯一的"节点"表示：无论是第一层的 Mahadasha，还是往下展开
    任意一层，都是同一种对象、同一个字段集合——不像原代码用
    `"L2 Ju"` 这种格式化字符串编码层级和行星，还要在别处再拆解读回来。
    """

    planet: str
    start: datetime  # tz-aware
    duration_seconds: Decimal

    def __post_init__(self) -> None:
        if self.planet not in PLANET_YEARS:
            raise ValueError(f"未知行星代码：{self.planet!r}")
        if self.duration_seconds <= 0:
            raise ValueError("duration_seconds 必须为正数。")

    @property
    def end(self) -> datetime:
        return self.start + _decimal_seconds_to_timedelta(self.duration_seconds)

    def to_dict(self, *, json_safe: bool = True) -> dict[str, Any]:
        """供 Flask 层直接序列化成 JSON；``duration_seconds`` 特意保留成
        十进制字符串而不是 float，前端展开下一层时把这个字符串原样传回来
        （见 `expand_dasha_interval`），全程不经过一次 float 转换。
        """
        return {
            "planet": self.planet,
            "start": self.start.isoformat() if json_safe else self.start,
            "end": self.end.isoformat() if json_safe else self.end,
            "duration_seconds": (
                str(self.duration_seconds) if json_safe else self.duration_seconds
            ),
        }


# ---------------------------------------------------------------------------
# 核心元语：把一个区间细分为后续 9 个子运（零依赖，纯函数）
# ---------------------------------------------------------------------------

@_decimal_precision
def divide_dasha_interval(parent: DashaInterval) -> list[DashaInterval]:
    """把 ``parent`` 按 Vimshottari 固定比例切成后续 9 段子运。

    序列从 ``parent.planet`` 自身开始，按九星固定顺序循环；每段时长 =
    ``parent.duration_seconds`` 按该行星年数 / 120 的比例分配，逐段首尾
    相接。

    这是整个模块唯一的分层算法：第一层（对虚拟根区间调用一次，见
    `_compute_dasha_root`）和更深的每一层（对被点击的区间再调用一次）
    共用这同一个函数、同一次调用——不做任何"提前算好第 N 层"的递归预算，
    调用方想展开多少层，就调用多少次本函数。
    """
    children: list[DashaInterval] = []
    current_planet = parent.planet
    current_start = parent.start
    for _ in range(len(PLANET_ORDER)):
        share = (parent.duration_seconds * PLANET_YEARS[current_planet]) / TOTAL_CYCLE_YEARS
        children.append(
            DashaInterval(planet=current_planet, start=current_start, duration_seconds=share)
        )
        current_start = current_start + _decimal_seconds_to_timedelta(share)
        current_planet = _NEXT_PLANET[current_planet]
    return children


# ---------------------------------------------------------------------------
# 根区间计算：唯一需要出生数据、星宿表、days_in_year 的地方
# ---------------------------------------------------------------------------

@_decimal_precision
def _compute_dasha_root(
    context: AstroContext,
    moon_lon: float,
    *,
    days_in_year: float = 365.25,
    star_table_path: str | Path | None = None,
) -> DashaInterval:
    """定位月亮所在星宿 -> 星宿主星已耗时间 -> 真实大运起点，返回一个
    "虚拟根区间"：行星 = 星宿主星，时长 = 120 年整周期，起点 = 大运真实
    起始时刻。对它调用一次 `divide_dasha_interval` 就是第一层
    （Mahadasha）的 9 段。

    直接使用 `core.parse_time_geo()` 已经算好的 `context.local_dt`
    （带时区、已按 calendar 转换成格里历），不重新解析任何原始字符串。
    """
    elapsed_fraction, star_lord = _locate_nakshatra(moon_lon, table_path=star_table_path)

    seconds_per_year = Decimal(str(days_in_year)) * Decimal(86400)
    star_lord_total_seconds = seconds_per_year * PLANET_YEARS[star_lord]
    elapsed_seconds = star_lord_total_seconds * elapsed_fraction

    dasha_start = context.local_dt - _decimal_seconds_to_timedelta(elapsed_seconds)
    full_cycle_seconds = seconds_per_year * TOTAL_CYCLE_YEARS
    return DashaInterval(planet=star_lord, start=dasha_start, duration_seconds=full_cycle_seconds)


# ---------------------------------------------------------------------------
# 公开入口：供上层（notebook / 未来 Flask 层）直接调用
# ---------------------------------------------------------------------------

def get_dasha_level1(
    context: AstroContext,
    moon_lon: float,
    *,
    days_in_year: float = 365.25,
    star_table_path: str | Path | None = None,
) -> list[DashaInterval]:
    """一次排盘（或前端刷新/调整参数重新排盘）只算这一层：返回第一层
    （Mahadasha）的 9 段区间。对应未来 Flask 层的 ``/dasha/root``。
    """
    root = _compute_dasha_root(
        context, moon_lon, days_in_year=days_in_year, star_table_path=star_table_path
    )
    return divide_dasha_interval(root)


def expand_dasha_interval(
    planet: str,
    start: str | datetime,
    duration_seconds: str | Decimal,
) -> list[DashaInterval]:
    """点击某个大运区间时调用：只需要被点击区间自带的三元组（行星、起点、
    时长），不需要出生数据、星宿表或 days_in_year——这些信息已经隐式携带
    在 ``duration_seconds`` 的比例里了。对应未来 Flask 层的
    ``/dasha/expand``，后端因此可以完全无状态。

    ``start``/``duration_seconds`` 建议直接传回上一次 `DashaInterval.to_dict()`
    里的原始字符串，而不是先转成 float 再传——这样才能保住 Decimal 精度
    全程不经过网络传输时的一次 float 转换。
    """
    start_dt = datetime.fromisoformat(start) if isinstance(start, str) else start
    duration = (
        duration_seconds if isinstance(duration_seconds, Decimal) else Decimal(str(duration_seconds))
    )
    node = DashaInterval(planet=planet, start=start_dt, duration_seconds=duration)
    return divide_dasha_interval(node)
