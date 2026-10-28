"""页面外壳：外壳页面（常驻各体系）、两个体系共用的 bootstrap / 外观接口，以及体系页面的渲染。

切换体系不再整页跳转：首页 / 是一个很薄的外壳页面（templates/app.html），每个体系的页面
装在外壳里的一个 iframe 中（地址带 ?embed=1），打开过的体系常驻内存，切换时只改显示和隐藏，
一到两帧就完成。各体系的页面、JS、CSS 和以前完全一样，仍然可以单独交给不同的组维护。

直接打开 /vedic/、/western/（例如旧书签）会跳转到外壳页面 /?system=<体系>。
"""

from __future__ import annotations

import json
from datetime import datetime

from flask import Blueprint, Response, current_app, redirect, render_template, request

from .profiles.driver import LockedError
from .profiles.routes import library_payload, locked_response
from .web import fail, ok

bp = Blueprint("shell", __name__)

_store = None
_libraries = None
_systems: dict = {}


def init_shell(store, libraries, systems):
    global _store, _libraries
    _store = store
    _libraries = libraries
    _systems.clear()
    _systems.update({s.id: s for s in systems})
    return bp


def system_links():
    return [{"id": s.id, "title": s.title, "url": s.url} for s in _systems.values()]


def render_system_page(system_id, template, **context):
    """各体系的页面都用这个函数渲染：自动带上体系切换按钮。

    只在外壳页面的 iframe 里使用（?embed=1）。不带 embed 的直接访问跳转到外壳页面。
    「上次用的体系」由外壳页面在切换时记录，这里不再每次加载都写一遍 settings.json。
    """
    if request.args.get("embed") != "1":
        return redirect(f"/?system={system_id}")
    system = _systems[system_id]
    return render_template(
        template,
        systems=system_links(),
        current_system=system_id,
        system_title=system.title,
        api_base=system.api,
        **context,
    )


@bp.get("/")
def home():
    """外壳页面：先显示 ?system= 指定的体系，没指定时显示上次用的体系。"""
    if not _systems:
        return "systems/ 文件夹里没有任何占星体系。", 500
    last = (_store.data.get("session") or {}).get("last_system")
    wanted = request.args.get("system") or last
    target = _systems.get(wanted) or next(iter(_systems.values()))
    return render_template("app.html", systems=system_links(), initial_system=target.id,
                           initial_title=target.title, record_initial=target.id != last)


@bp.post("/api/appearance")
def update_appearance():
    try:
        payload = request.get_json(force=True) or {}
        return ok(_store.save_appearance(payload))
    except ValueError as exc:
        return fail(exc, 400)
    except OSError as exc:
        current_app.logger.exception("Saving appearance failed")
        return fail(f"外观设置写入 settings.json 失败：{exc}", 500)


@bp.get("/api/settings/export")
def export_settings():
    """把两个体系的全部计算与显示设置导出成一个 JSON 文件（下载）。"""
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    body = json.dumps({**_store.export_bundle(), "exported_at": datetime.now().isoformat(timespec="seconds")},
                      ensure_ascii=False, indent=2) + "\n"
    return Response(body, mimetype="application/json; charset=utf-8",
                    headers={"Content-Disposition": f"attachment; filename=quant-astro-settings-{stamp}.json"})


@bp.post("/api/settings/import")
def import_settings():
    """上传 export_settings 导出的 JSON，替换其中包含的各节设置。"""
    upload = request.files.get("file")
    if upload is None:
        return fail("没有收到设置文件。", 400)
    try:
        bundle = json.loads(upload.read().decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return fail("设置文件不是合法的 JSON。", 400)
    try:
        return ok(_store.import_bundle(bundle))
    except ValueError as exc:
        return fail(exc, 400)
    except OSError as exc:
        current_app.logger.exception("Importing settings failed")
        return fail(f"设置写入 settings.json 失败：{exc}", 500)


@bp.post("/api/layout/tab-order")
def update_tab_order():
    """结果区标签页拖动排序后写回：{"system": 体系 id, "order": [标签页 id, ...]}。"""
    try:
        payload = request.get_json(force=True) or {}
        return ok(_store.save_tab_order(str(payload.get("system") or ""), payload.get("order")))
    except ValueError as exc:
        return fail(exc, 400)
    except OSError as exc:
        current_app.logger.exception("Saving tab order failed")
        return fail(f"标签页顺序写入 settings.json 失败：{exc}", 500)


def shared_settings():
    data = _store.data
    return {key: data[key] for key in ("default_location", "birth_defaults", "session", "appearance", "layout")}


@bp.get("/api/bootstrap")
def bootstrap():
    """打开页面时一次取齐：共用设置 + 某个体系的设置和选项 + 当前档案库第一页。

    ?system=<id> 指定体系。返回的 settings = 共用设置合并体系设置（体系设置里的键优先）。
    """
    system = _systems.get(request.args.get("system", ""))
    if system is None:
        return fail("未知的占星体系。", 400)
    sys_part = system.bootstrap(_store)
    data = {
        "settings": {**shared_settings(), **sys_part["settings"]},
        "options": sys_part["options"],
        "system": {"id": system.id, "title": system.title, "api": system.api},
        "security": _libraries.security_status(),
    }
    try:
        data.update(library_payload())
    except LockedError as exc:
        return locked_response(exc)
    return ok(data)          # 前端只读 data；以前同一份数据在顶层又放了一遍，白白多传一倍
