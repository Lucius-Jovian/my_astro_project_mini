"""星宿类大运（Nakshatra Dasha）：Vimshottari、Yogini、Ashtottari 以及 BPHS 的几种条件大运。

所有体系共用同一套算法，只是“有哪些主星、各几年、出生时从哪一位起”不同：

- 一个体系 = 一串按固定顺序循环的主星（每位若干年，合计为一个周期）+ 一条“出生时第一位是谁”的规则。
- 细分只有一个自相似的元语 `divide()`：把一段区间按各主星年数占周期的比例切开，
  从这段区间自己的主星开始，按顺序循环一遍。第一层（Mahadasha）是对“虚拟根区间”
  （主星 = 出生时那一位，时长 = 一个周期，起点 = 出生时刻减去已走过的部分）调用一次；
  往下每一层都是对被点开的区间再调用一次，没有层数上限。
- 周期短于 120 年的体系（Yogini 36 年、Dwisaptati 72 年等），第一层连续排若干个周期，覆盖出生后 120 年。
- 已走过的部分按起算点（默认月亮）在本主星所辖弧段里走过的比例计算：
  一位主星只管一个星宿时就是在这个星宿里走过的比例；Ashtottari 一位主星管 3–4 个星宿，
  按在这一组星宿的整段弧里走过的比例计算。
- 时长全程用 Decimal 承载，星宿跨度用精确分数 40/3，不经过 float 往返。

各体系的定义（BPHS，R. Santhanam 译本）：
  vimshottari      120 年  Ke7 Ve20 Su6 Mo10 Ma7 Ra18 Ju16 Sa19 Me17；从 Ashwini 起每个星宿依次归一位主星
  yogini            36 年  Mangala(Mo)1 Pingala(Su)2 Dhanya(Ju)3 Bhramari(Ma)4 Bhadrika(Me)5 Ulka(Sa)6
                           Siddha(Ve)7 Sankata(Ra)8；（星宿序号 + 3）÷ 8 的余数，余 1 为 Mangala，余 0 为 Sankata
  ashtottari       108 年  Su6 Mo15 Ma8 Me17 Sa10 Ju19 Ra12 Ve21；从 Ardra 起依次 4、3、4、3、4、3、4、3 个星宿
                           （土星一组含 Abhijit：P.Ashadha、U.Ashadha、Abhijit、Shravana，合计仍是 40° 弧）
  shodashottari    116 年  Su11 Ma12 Ju13 Sa14 Ke15 Mo16 Me17 Ve18；从 Pushya 数到出生星宿 ÷ 8
  dwadashottari    112 年  Su7 Ju9 Ke11 Me13 Ra15 Ma17 Sa19 Mo21；从出生星宿数到 Revati ÷ 8
  panchottari      105 年  Su12 Me13 Sa14 Ma15 Ve16 Mo17 Ju18；从 Anuradha 数到出生星宿 ÷ 7
  shatabdika       100 年  Su5 Mo5 Ve10 Me10 Ju20 Ma20 Sa30；从 Revati 数到出生星宿 ÷ 7
  chaturashiti      84 年  Su Mo Ma Me Ju Ve Sa 各 12；从 Swati 数到出生星宿 ÷ 7
  dwisaptati        72 年  Su Mo Ma Me Ju Ve Sa Ra 各 9；从 Mula 数到出生星宿 ÷ 8
  shattrimsha       36 年  Mo1 Su2 Ju3 Ma4 Me5 Sa6 Ve7 Ra8；从 Shravana 数到出生星宿 ÷ 8
“数到”都含首尾两个星宿；余数 1 对应顺序中的第一位，余数 0 对应最后一位。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal, localcontext
from functools import wraps
from typing import Any, Callable

from common.astro.core import AstroContext

PRECISION = 50
_SPAN_NUM = Decimal(3)      # 1 个星宿 = 40/3 度，“除以 40/3” = 乘 3 再除 40
_SPAN_DEN = Decimal(40)
COVER_YEARS = 120           # 第一层至少覆盖出生后多少年


def _precise(func):
    @wraps(func)
    def wrapper(*args, **kwargs):
        with localcontext() as ctx:
            ctx.prec = PRECISION
            return func(*args, **kwargs)
    return wrapper


def _seconds(value: Decimal) -> timedelta:
    whole = int(value)
    micro = int(((value - whole) * Decimal(1_000_000)).to_integral_value())
    return timedelta(seconds=whole, microseconds=micro)


# ---------------------------------------------------------------------------- 体系定义

@dataclass(frozen=True)
class Lord:
    key: str        # 体系内唯一的代码（行星代码，或 Yogini 的名字）
    years: int
    planet: str     # 对应的行星代码
    label: str      # 页面上显示的名称


@dataclass(frozen=True)
class DashaSystem:
    id: str
    name: str
    lords: tuple[Lord, ...]
    first: Callable[[Decimal], tuple[int, Decimal]]   # 星宿单位的位置 → (第一位的序号, 已走过的比例)
    condition: str = ""                               # BPHS 给出的适用情形（只作说明，不自动判断）

    @property
    def total(self) -> int:
        return sum(lord.years for lord in self.lords)

    def index(self, key: str) -> int:
        for i, lord in enumerate(self.lords):
            if lord.key == key:
                return i
        raise ValueError(f"{self.name} 里没有 {key!r}。")


def _planets(spec: str) -> tuple[Lord, ...]:
    """'Su6 Mo15 …' → Lord 元组。"""
    out = []
    for item in spec.split():
        code, years = item[:2], int(item[2:])
        out.append(Lord(code, years, code, code))
    return tuple(out)


def _count_rule(base: int, *, reverse: bool = False):
    """从 base 星宿数到出生星宿（reverse=True：从出生星宿数到 base），含首尾，除以主星个数取余。"""
    def first(pos: Decimal, length: int) -> tuple[int, Decimal]:
        n = int(pos)
        frac = pos - n
        count = ((base - n) % 27 if reverse else (n - base) % 27) + 1
        return (count % length - 1) % length, frac
    return first


def _yogini_rule(pos: Decimal, length: int) -> tuple[int, Decimal]:
    n = int(pos)
    return ((n + 1 + 3) % 8 - 1) % 8, pos - n


def _group_rule(start: int, spans: tuple[int, ...]):
    """每位主星管连续若干个星宿（spans，以星宿为单位，从第 start 个星宿起），已走比例按整组弧段计算。"""
    def first(pos: Decimal, length: int) -> tuple[int, Decimal]:
        rel = ((pos - start) % 27 + 27) % 27        # Decimal 的 % 保留被除数的符号，所以再加一圈
        acc = Decimal(0)
        for i, span in enumerate(spans):
            if rel < acc + span:
                return i, (rel - acc) / span
            acc += span
        return len(spans) - 1, Decimal(1)
    return first


def _bind(rule, lords):
    return lambda pos: rule(pos, len(lords))


def _system(id_, name, lords, rule, condition=""):
    return DashaSystem(id_, name, lords, _bind(rule, lords), condition)


_YOGINI = tuple(Lord(name, years, planet, name) for name, years, planet in (
    ("Mangala", 1, "Mo"), ("Pingala", 2, "Su"), ("Dhanya", 3, "Ju"), ("Bhramari", 4, "Ma"),
    ("Bhadrika", 5, "Me"), ("Ulka", 6, "Sa"), ("Siddha", 7, "Ve"), ("Sankata", 8, "Ra"),
))

SYSTEMS: dict[str, DashaSystem] = {s.id: s for s in (
    _system("vimshottari", "Vimshottari", _planets("Ke7 Ve20 Su6 Mo10 Ma7 Ra18 Ju16 Sa19 Me17"), _count_rule(0)),
    _system("yogini", "Yogini", _YOGINI, _yogini_rule),
    _system("ashtottari", "Ashtottari", _planets("Su6 Mo15 Ma8 Me17 Sa10 Ju19 Ra12 Ve21"),
            _group_rule(5, (4, 3, 4, 3, 3, 3, 4, 3)),
            "罗睺不在命主星的角宫或三方宫（罗睺在上升除外）"),
    _system("shodashottari", "Shodashottari", _planets("Su11 Ma12 Ju13 Sa14 Ke15 Mo16 Me17 Ve18"), _count_rule(7),
            "黑分（Krishna Paksha）日生，或白分（Shukla Paksha）夜生"),
    _system("dwadashottari", "Dwadashottari", _planets("Su7 Ju9 Ke11 Me13 Ra15 Ma17 Sa19 Mo21"),
            _count_rule(26, reverse=True), "上升落在金星的 Navamsa"),
    _system("panchottari", "Panchottari", _planets("Su12 Me13 Sa14 Ma15 Ve16 Mo17 Ju18"), _count_rule(16),
            "上升巨蟹，且在巨蟹的 Dwadashamsa"),
    _system("shatabdika", "Shatabdika", _planets("Su5 Mo5 Ve10 Me10 Ju20 Ma20 Sa30"), _count_rule(26),
            "上升 Vargottama（本命盘与 Navamsa 上升同一星座）"),
    _system("chaturashiti", "Chaturashiti Sama", _planets("Su12 Mo12 Ma12 Me12 Ju12 Ve12 Sa12"), _count_rule(14),
            "第十宫主星落在第十宫"),
    _system("dwisaptati", "Dwisaptati Sama", _planets("Su9 Mo9 Ma9 Me9 Ju9 Ve9 Sa9 Ra9"), _count_rule(18),
            "上升主星落在第一宫或第七宫"),
    _system("shattrimsha", "Shattrimsha Sama", _planets("Mo1 Su2 Ju3 Ma4 Me5 Sa6 Ve7 Ra8"), _count_rule(21),
            "日生且上升在太阳的 Hora，或夜生且上升在月亮的 Hora"),
)}

DEFAULT_SYSTEM = "vimshottari"


def system_options() -> list[dict[str, Any]]:
    return [{"value": s.id, "label": s.name, "years": s.total, "condition": s.condition} for s in SYSTEMS.values()]


def get_system(system_id: str) -> DashaSystem:
    try:
        return SYSTEMS[system_id]
    except KeyError:
        raise ValueError(f"未知的大运体系：{system_id!r}") from None


# ---------------------------------------------------------------------------- 区间

@dataclass(frozen=True)
class DashaInterval:
    system: str
    lord: str
    start: datetime
    duration_seconds: Decimal

    @property
    def end(self) -> datetime:
        return self.start + _seconds(self.duration_seconds)

    def to_dict(self) -> dict[str, Any]:
        lord = SYSTEMS[self.system].lords[SYSTEMS[self.system].index(self.lord)]
        return {
            "system": self.system,
            "lord": self.lord,
            "planet": lord.planet,
            "label": lord.label,
            "start": self.start.isoformat(),
            "end": self.end.isoformat(),
            "duration_seconds": str(self.duration_seconds),
        }


@_precise
def divide(parent: DashaInterval) -> list[DashaInterval]:
    """把一段区间按本体系各主星年数占周期的比例切开，从这段区间自己的主星开始循环一遍。"""
    system = get_system(parent.system)
    total = Decimal(system.total)
    start_index = system.index(parent.lord)
    out, cursor = [], parent.start
    for step in range(len(system.lords)):
        lord = system.lords[(start_index + step) % len(system.lords)]
        share = parent.duration_seconds * lord.years / total
        out.append(DashaInterval(parent.system, lord.key, cursor, share))
        cursor = cursor + _seconds(share)
    return out


@_precise
def level1(context: AstroContext, start_lon: float, system_id: str = DEFAULT_SYSTEM, *,
           days_in_year: float = 365.25) -> list[DashaInterval]:
    """第一层大运。start_lon 是起算点（默认月亮）在当前黄道体系下的黄经。"""
    system = get_system(system_id)
    lon = (Decimal(str(start_lon)) % 360 + 360) % 360
    pos = lon * _SPAN_NUM / _SPAN_DEN                  # 以星宿为单位，0 ≤ pos < 27
    index, elapsed = system.first(pos)
    year = Decimal(str(days_in_year)) * Decimal(86400)
    first_lord = system.lords[index]
    start = context.local_dt - _seconds(year * first_lord.years * elapsed)
    cycle = year * system.total
    limit = context.local_dt + _seconds(year * COVER_YEARS)
    # 第一个周期整段列出；之后按顺序逐段往后接，直到覆盖出生后 COVER_YEARS 年为止。
    periods = divide(DashaInterval(system.id, first_lord.key, start, cycle))
    while periods[-1].end < limit:
        for item in divide(DashaInterval(system.id, first_lord.key, periods[-1].end, cycle)):
            periods.append(item)
            if item.end >= limit:
                break
    return periods


def expand(system_id: str, lord: str, start: str | datetime, duration_seconds: str | Decimal) -> list[DashaInterval]:
    """点开一段区间：只需要这段区间自带的 (体系, 主星, 起点, 时长)，后端不需要出生数据。"""
    start_dt = datetime.fromisoformat(start) if isinstance(start, str) else start
    duration = duration_seconds if isinstance(duration_seconds, Decimal) else Decimal(str(duration_seconds))
    if duration <= 0:
        raise ValueError("时长必须为正数。")
    return divide(DashaInterval(system_id, lord, start_dt, duration))
