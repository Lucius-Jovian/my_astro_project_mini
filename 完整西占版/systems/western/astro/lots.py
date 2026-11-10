"""Lot（阿拉伯点）：公式解析与计算。

公式由若干项相加减组成，结果对 360° 取余，例如福点（日生）：``Asc + Mo - Su``。
每个 Lot 有自己的日夜规则 sect_mode（auto / day / night），见 choose_formula。

每一项可以是：
  - 行星 / 交点：Su Mo Me Ve Ma Ju Sa Ur Ne Pl Ra Ke
  - 四轴：Asc MC Desc IC
  - 宫头：H1 … H12
  - 特殊点：MeanApog MeanPerig TrueApog TruePerig IntpApog IntpPerig Syzygy Vertex AntiVertex EastPoint
  - 小行星：#编号，例如 #3（婚神星）、#433（爱神星）
  - 恒星：*{名称}，例如 *{Regulus}、*{,alLeo}
  - 另一个 Lot：@代码，例如 @Fortune
  - 常数度数：例如 30 或 30°
代码不区分大小写。公式里引用的点即使在设置里没有启用，也会单独算出来参与计算。

本模块只做公式解析和求值，不直接调用 Swiss Ephemeris：位置由调用方传入的
resolver(kind, value) 提供（见 systems/western/bridge.py 的 PointResolver）。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable

PLANET_CODES = ("Su", "Mo", "Me", "Ve", "Ma", "Ju", "Sa", "Ur", "Ne", "Pl", "Ra", "Ke")
AXIS_CODES = ("Asc", "MC", "Desc", "IC")
CUSP_CODES = tuple(f"H{n}" for n in range(1, 13))
SPECIAL_CODES = (
    "MeanApog", "MeanPerig", "TrueApog", "TruePerig", "IntpApog", "IntpPerig",
    "Syzygy", "Vertex", "AntiVertex", "EastPoint",
)

_NAMED = {code.casefold(): (kind, code) for kind, codes in (
    ("planet", PLANET_CODES), ("axis", AXIS_CODES), ("cusp", CUSP_CODES), ("special", SPECIAL_CODES),
) for code in codes}

LOT_CODE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,19}$")
MAX_FORMULA_LEN = 300
MAX_TERMS = 20

_TOKEN_RE = re.compile(
    r"""\s*(?:
        (?P<op>[+\-])
      | (?P<num>\d+(?:\.\d+)?)\s*°?
      | \*\{(?P<star>[^{}]+)\}
      | \#(?P<ast>\d+)
      | @(?P<lot>[A-Za-z][A-Za-z0-9_]*)
      | (?P<name>[A-Za-z][A-Za-z0-9]*)
    )""",
    re.VERBOSE,
)


@dataclass(frozen=True)
class Term:
    sign: int            # +1 或 -1
    kind: str            # planet / axis / cusp / special / asteroid / star / lot / const
    value: object        # 代码、编号、恒星查询串、Lot 代码或常数

    def text(self) -> str:
        if self.kind == "asteroid":
            return f"#{self.value}"
        if self.kind == "star":
            return f"*{{{self.value}}}"
        if self.kind == "lot":
            return f"@{self.value}"
        if self.kind == "const":
            return f"{self.value:g}"
        return str(self.value)


def parse_formula(text: str) -> list[Term]:
    """把公式文本解析成项的列表；写法不对时抛 ValueError（信息可以直接显示给用户）。"""
    source = " ".join(str(text or "").split())
    if not source:
        raise ValueError("公式不能为空。")
    if len(source) > MAX_FORMULA_LEN:
        raise ValueError(f"公式不能超过 {MAX_FORMULA_LEN} 个字符。")
    source = source.replace("＋", "+").replace("－", "-").replace("−", "-")

    terms: list[Term] = []
    pos = 0
    sign = None              # 当前项前面的符号；None 表示还没读到运算符
    expect_term = True
    while pos < len(source):
        m = _TOKEN_RE.match(source, pos)
        if not m or m.end() == pos:
            raise ValueError(f"公式在「{source[pos:pos + 12]}」处无法识别。")
        pos = m.end()
        if m.group("op"):
            if not expect_term and sign is None:
                sign = 1 if m.group("op") == "+" else -1
                expect_term = True
                continue
            if expect_term and sign is None and not terms:
                sign = 1 if m.group("op") == "+" else -1    # 开头的正负号
                continue
            raise ValueError("公式里有连续的运算符。")
        if not expect_term:
            raise ValueError("两项之间缺少 + 或 -。")
        s = sign if sign is not None else 1
        if m.group("num"):
            terms.append(Term(s, "const", float(m.group("num"))))
        elif m.group("star"):
            query = " ".join(m.group("star").split())
            if not query:
                raise ValueError("恒星名称不能为空：*{名称}。")
            terms.append(Term(s, "star", query))
        elif m.group("ast"):
            number = int(m.group("ast"))
            if number < 1:
                raise ValueError("小行星编号必须大于 0。")
            terms.append(Term(s, "asteroid", number))
        elif m.group("lot"):
            terms.append(Term(s, "lot", m.group("lot")))
        else:
            name = m.group("name")
            found = _NAMED.get(name.casefold())
            if found is None:
                raise ValueError(
                    f"不认识「{name}」。行星写 Su、Mo…，四轴写 Asc、MC、Desc、IC，宫头写 H1–H12，"
                    "小行星写 #编号，恒星写 *{名称}，其它 Lot 写 @代码。"
                )
            terms.append(Term(s, found[0], found[1]))
        sign = None
        expect_term = False
        if len(terms) > MAX_TERMS:
            raise ValueError(f"公式最多 {MAX_TERMS} 项。")
    if expect_term:
        raise ValueError("公式不能以运算符结尾。")
    return terms


def normalize_formula(text: str) -> str:
    """解析后重新写成规范的形式（统一大小写和空格），方便显示和保存。"""
    terms = parse_formula(text)
    out = []
    for i, term in enumerate(terms):
        op = "-" if term.sign < 0 else "+"
        if i == 0:
            out.append(("-" if term.sign < 0 else "") + term.text())
        else:
            out.append(f"{op} {term.text()}")
    return " ".join(out)


#: resolver(kind, value) → (黄经, 每日速度)。速度用来判断 Lot 参与相位时是入相还是出相。
Resolver = Callable[[str, object], tuple[float, float]]

SECT_MODES = ("auto", "day", "night")


def evaluate(terms: list[Term], resolve: Resolver) -> tuple[float, float]:
    """按公式求 (黄经, 速度)：黄经对 360° 取余；速度就是各项速度按同样的正负号相加（常数项速度为 0）。"""
    total = 0.0
    speed = 0.0
    for term in terms:
        if term.kind == "const":
            total += term.sign * float(term.value)
            continue
        lon, spd = resolve(term.kind, term.value)
        total += term.sign * float(lon)
        speed += term.sign * float(spd)
    return total % 360.0, speed


def lot_sect_mode(lot: dict) -> str:
    mode = str(lot.get("sect_mode") or "auto")
    return mode if mode in SECT_MODES else "auto"


def choose_formula(lot: dict, *, is_day: bool | None) -> tuple[str, str]:
    """按这个 Lot 自己的日夜规则选公式：返回 (公式文本, "day"/"night"/"single")。

    lot["sect_mode"]：auto（按出生时太阳是否在地平线上）、day（固定日间公式）、night（固定夜间公式）。
    没有填写夜间公式的 Lot 不分日夜，始终用同一条公式。
    auto 模式下需要传入 is_day；其它情况 is_day 可以是 None。
    """
    night = str(lot.get("night") or "").strip()
    if not night:
        return str(lot["day"]), "single"
    mode = lot_sect_mode(lot)
    if mode == "auto":
        if is_day is None:
            raise ValueError("自动判断日夜时需要出生时的日夜信息。")
        use_day = is_day
    else:
        use_day = mode == "day"
    return (str(lot["day"]), "day") if use_day else (night, "night")


def needs_sect(lot: dict) -> bool:
    """这个 Lot 是否需要知道出生时是白天还是夜晚。"""
    return bool(str(lot.get("night") or "").strip()) and lot_sect_mode(lot) == "auto"
