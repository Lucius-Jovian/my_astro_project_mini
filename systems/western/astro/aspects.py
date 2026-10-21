"""相位计算：在两组点之间（或一组点内部）找出所有落在容许度内的相位。

本模块不调用 Swiss Ephemeris，只用已经算好的黄经和每日速度：
- 角距：两点黄经差折算到 0–180°。
- 偏差：角距与相位角度之差的绝对值，也就是“离精确相位还差几度”。
- 入相 / 出相：按两点的速度看偏差此刻是在变小（入相，A）还是在变大（出相，S）；
  两点相对静止（例如恒星对朔望点）或刚好精确时不标。
- 容许度：每个点有自己的容许度，两个点之间用哪个由合成规则决定（见 combine_orb）。
  标记为 exclusive 的点（例如恒星）不参与合成，始终只用它自己的容许度。
- 同一对点同时落在两种相位的容许范围内时，两种都返回。

调用方负责决定哪些点参与、每个点的容许度，以及要跳过哪些固定的点对。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Iterable, Sequence

#: 两点之间容许度的合成规则。
ORB_RULES: dict[str, str] = {
    "moiety": "古典半径法：两个点的容许度各取一半再相加",
    "max": "取两者中较大的容许度",
    "min": "取两者中较小的容许度",
}

# 相对速度小于这个值（度/日）视为相对静止，不判断入相 / 出相。
_STATIC_SPEED = 1e-7
# 偏差小于这个值（度，约 0.04 角秒）视为精确。
_EXACT = 1e-5


@dataclass(frozen=True)
class AspectPoint:
    id: str
    lon: float
    speed: float
    orb: float
    exclusive: bool = False


@dataclass(frozen=True)
class AspectType:
    id: str
    name: str
    angle: float
    symbol: str


def combine_orb(a: AspectPoint, b: AspectPoint, rule: str) -> float:
    if a.exclusive and b.exclusive:
        return min(a.orb, b.orb)
    if a.exclusive:
        return a.orb
    if b.exclusive:
        return b.orb
    if rule == "max":
        return max(a.orb, b.orb)
    if rule == "min":
        return min(a.orb, b.orb)
    return (a.orb + b.orb) / 2.0          # moiety


def _separation(lon_a: float, lon_b: float) -> tuple[float, int]:
    """角距（0–180°），以及 b 相对 a 的黄经差增大时角距的变化方向（+1 / -1）。"""
    delta = (lon_b - lon_a) % 360.0
    if delta <= 180.0:
        return delta, 1
    return 360.0 - delta, -1


def _sign_ok(lon_a: float, lon_b: float, angle: float) -> bool:
    """不跨星座：只认星座之间也构成同一相位的情况（只对 30° 整数倍的相位有意义）。"""
    if abs(angle / 30.0 - round(angle / 30.0)) > 1e-9:
        return True
    diff = (int(lon_b // 30) - int(lon_a // 30)) % 12
    diff = min(diff, 12 - diff)
    return abs(diff * 30.0 - angle) < 1e-9


def aspect_between(
    a: AspectPoint,
    b: AspectPoint,
    types: Sequence[AspectType],
    *,
    rule: str,
    cross_sign: bool = True,
) -> list[dict]:
    """两个点之间所有成立的相位（可能不止一个），按偏差从小到大排列。"""
    sep, direction = _separation(a.lon % 360.0, b.lon % 360.0)
    orb = combine_orb(a, b, rule)
    rel_speed = b.speed - a.speed
    found = []
    for t in types:
        dev = sep - t.angle
        if abs(dev) > orb + 1e-12:
            continue
        if not cross_sign and not _sign_ok(a.lon % 360.0, b.lon % 360.0, t.angle):
            continue
        # d(角距)/dt = direction × 相对速度；d|偏差|/dt = sign(偏差) × d(角距)/dt
        if abs(rel_speed) < _STATIC_SPEED or abs(dev) < _EXACT:
            motion = None
        else:
            change = (1.0 if dev > 0 else -1.0) * direction * rel_speed
            motion = "A" if change < 0 else "S"
        found.append({
            "type": t.id,
            "name": t.name,
            "symbol": t.symbol,
            "angle": t.angle,
            "separation": sep,
            "deviation": abs(dev),
            "orb": orb,
            "motion": motion,
        })
    found.sort(key=lambda x: x["deviation"])
    return found


def find_aspects(
    group_a: Sequence[AspectPoint],
    group_b: Sequence[AspectPoint] | None,
    types: Iterable[AspectType],
    *,
    rule: str = "moiety",
    cross_sign: bool = True,
    skip: Callable[[AspectPoint, AspectPoint], bool] | None = None,
) -> list[dict]:
    """两组点之间的相位。group_b 为 None 时计算 group_a 内部两两之间的相位（每对只算一次）。

    返回的每一项：a、b 两个点的 id，以及 aspect_between 给出的相位信息。
    """
    if rule not in ORB_RULES:
        raise ValueError(f"未知的容许度合成规则：{rule}")
    types = list(types)
    if not types:
        return []
    pairs: list[tuple[AspectPoint, AspectPoint]] = []
    if group_b is None:
        for i, b in enumerate(group_a):
            for a in group_a[:i]:
                pairs.append((a, b))
    else:
        pairs = [(a, b) for a in group_a for b in group_b if a.id != b.id]
    result = []
    for a, b in pairs:
        if skip and skip(a, b):
            continue
        for hit in aspect_between(a, b, types, rule=rule, cross_sign=cross_sign):
            result.append({"a": a.id, "b": b.id, **hit})
    return result
