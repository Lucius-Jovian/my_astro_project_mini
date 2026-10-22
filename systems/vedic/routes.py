"""印度占星的页面和接口，全部挂在 /vedic/ 下（接口是 /vedic/api/...）。"""

from __future__ import annotations

from flask import Blueprint, current_app, request

from common.shell import render_system_page
from common.web import fail, ok

from . import bridge

bp = Blueprint(
    "vedic", __name__,
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
    return render_system_page("vedic", "vedic/index.html")


@bp.get("/manual")
def manual():
    return render_system_page("vedic", "vedic/manual.html")


def _save(action, payload, what):
    try:
        return ok(action(store, payload))
    except ValueError as exc:
        return fail(exc, 400)
    except OSError as exc:
        current_app.logger.exception("Saving %s failed", what)
        return fail(f"设置写入 settings.json 失败：{exc}", 500)


@bp.post("/api/calc-defaults")
def update_calc_defaults():
    return _save(bridge.save_calc_defaults, request.get_json(force=True) or {}, "calculation defaults")


@bp.post("/api/chart-style")
def update_chart_style():
    payload = request.get_json(force=True) or {}
    return _save(bridge.save_chart_style, payload.get("chart_style"), "chart style")


@bp.post("/api/chart/full")
def chart_full():
    try:
        payload = request.get_json(force=True) or {}
        return ok(bridge.calculate_full_chart(payload))
    except Exception as exc:
        current_app.logger.exception("Full chart calculation failed")
        return fail(exc, 400)


@bp.post("/api/dasha/expand")
def dasha_expand():
    try:
        from .astro import dasha as dasha_engine

        payload = request.get_json(force=True) or {}
        intervals = dasha_engine.expand(
            str(payload.get("system") or dasha_engine.DEFAULT_SYSTEM),
            str(payload["lord"]),
            str(payload["start"]),
            str(payload["duration_seconds"]),
        )
        return ok([item.to_dict() for item in intervals])
    except Exception as exc:
        current_app.logger.exception("Dasha expansion failed")
        return fail(exc, 400)
