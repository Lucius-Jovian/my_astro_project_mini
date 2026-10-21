"""西方占星专用的计算：小行星、恒星、特殊点（points）、Lot（lots）、相位（aspects）。

行星、宫位、星历路径等共用基础来自 common.astro。
"""

from .aspects import ORB_RULES, AspectPoint, AspectType, aspect_between, find_aspects
from .lots import choose_formula, evaluate, normalize_formula, parse_formula
from .points import (
    BUILTIN_ASTEROIDS,
    SPECIAL_POINTS,
    asteroid_body_id,
    calculate_asteroids,
    calculate_fixed_stars,
    calculate_special_points,
    check_asteroid,
    check_star,
    prenatal_syzygy,
    special_point,
    sun_above_horizon,
)

__all__ = [
    "BUILTIN_ASTEROIDS", "ORB_RULES", "SPECIAL_POINTS", "AspectPoint", "AspectType", "aspect_between",
    "asteroid_body_id", "calculate_asteroids", "calculate_fixed_stars", "calculate_special_points",
    "check_asteroid", "check_star", "choose_formula", "evaluate", "find_aspects", "normalize_formula",
    "parse_formula", "prenatal_syzygy", "special_point", "sun_above_horizon",
]
