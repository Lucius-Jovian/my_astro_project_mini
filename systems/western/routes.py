"""西方占星的页面和接口，全部挂在 /western/ 下（接口是 /western/api/...）。"""

from __future__ import annotations

from flask import Blueprint, current_app, request

from common.shell import render_system_page
from common.web import fail, ok

from . import bridge
from .astro import check_asteroid, check_star

bp = Blueprint(
    "western", __name__,
    template_folder="templates",
    static_folder="static",
    static_url_path="/static",
)

store = None


def attach(settings_store, libraries):
    global store
    store = settings_store


def bootstrap(settings_store):
    return {"settings": settings_store.system(bridge.SYSTEM_ID), "options": bridge.public_options()}


@bp.get("/")
def index():
    return render_system_page("western", "western/index.html")


def _save(action, what):
    try:
        payload = request.get_json(force=True) or {}
        return ok(action(store, payload))
    except ValueError as exc:
        return fail(exc, 400)
    except OSError as exc:
        current_app.logger.exception("Saving %s failed", what)
        return fail(f"设置写入 settings.json 失败：{exc}", 500)


@bp.post("/api/calc-defaults")
def update_calc_defaults():
    """计算设置改了就写回 settings.json，下次打开页面沿用上一次的设置。"""
    return _save(bridge.save_calc_defaults, "calculation defaults")


@bp.post("/api/points")
def update_points():
    """行星 / 小行星 / 恒星 / Lot / 特殊点 / 映点 / 配色：传哪几类就改哪几类，返回整理后的完整配置。"""
    return _save(bridge.save_points, "points")


@bp.post("/api/aspects")
def update_aspects():
    """相位设置：参与的点（selection）、容许度（orbs）、相位类型（types）、跨星座（cross_sign）。"""
    return _save(bridge.save_aspects, "aspects")


@bp.post("/api/classical")
def update_classical():
    """古典占星设置：先天尊贵、界、得时、速度、太阳光束（见 bridge.normalize_classical）。"""
    return _save(bridge.save_classical, "classical")


@bp.post("/api/points/check-asteroid")
def points_check_asteroid():
    """新增小行星前：查名字、查星历文件在不在（不在也允许添加，只是给出提示）。"""
    try:
        payload = request.get_json(force=True) or {}
        try:
            number = int(str(payload.get("number")).strip())
        except ValueError:
            raise ValueError("小行星编号必须是整数。")
        return ok(check_asteroid(number))
    except ValueError as exc:
        return fail(exc, 400)


@bp.post("/api/points/check-star")
def points_check_star():
    """新增恒星前：在 sefstars.txt 里找这颗星，返回规范的命名和星等；找不到时报错。"""
    try:
        payload = request.get_json(force=True) or {}
        return ok(check_star(payload.get("query")))
    except ValueError as exc:
        return fail(exc, 400)


@bp.post("/api/points/check-lot")
def points_check_lot():
    try:
        payload = request.get_json(force=True) or {}
        return ok(bridge.check_lot_formula(payload.get("formula")))
    except ValueError as exc:
        return fail(exc, 400)


@bp.post("/api/chart/full")
def chart_full():
    try:
        payload = request.get_json(force=True) or {}
        return ok(bridge.calculate_full_chart(payload))
    except Exception as exc:
        current_app.logger.exception("Full chart calculation failed")
        return fail(exc, 400)
