"""档案系统的全部接口：档案库、人物、标签、自定义字段、加密。两个占星体系共用。"""

from __future__ import annotations

import json
from datetime import datetime
from functools import wraps

from flask import Blueprint, Response, current_app, request, stream_with_context

from ..web import fail, ok
from .driver import LockedError
from .db import DEFAULT_SORT, FIELD_KINDS, default_order

PAGE_META_KEYS = ("page", "page_size", "total", "total_pages", "has_more", "sort", "order")

bp = Blueprint("profiles", __name__)

# 由 create_blueprint() 填入
libraries = None
store = None


def db():
    """当前档案库。"""
    return libraries.db()


def locked_response(exc=None):
    """423 + 被锁定的库名和全部档案库列表（解锁窗口里可以改选别的库）。"""
    name = getattr(exc, "library", None) or libraries.current_name()
    return fail(exc or LockedError(name), 423, locked=True, library=name, libraries=libraries.summary())


def unlocked_required(view):
    """当前档案库加密且未解锁时，所有档案接口统一返回 423（前端据此弹出解锁窗口）。"""
    @wraps(view)
    def wrapper(*args, **kwargs):
        try:
            libraries._require_unlocked()
            return view(*args, **kwargs)
        except LockedError as exc:
            return locked_response(exc)
    return wrapper


def field_kind_options():
    return [{"value": key, "label": label} for key, label in FIELD_KINDS.items()]


def saved_sort():
    """当前档案库保存的人物排序 (sort, order)；没保存过时是默认排序（最近打开，倒序）。"""
    entry = ((store.data.get("session") or {}).get("profile_sort") or {}).get(libraries.current)
    if isinstance(entry, dict) and entry.get("sort"):
        return str(entry["sort"]), str(entry.get("order") or default_order(entry["sort"]))
    return DEFAULT_SORT, default_order(DEFAULT_SORT)


def library_payload():
    """切换档案库 / 打开网页时前端需要的全部档案数据（只有第一页人物）。

    第一页直接按这个库保存的排序来取，打开网页时列表不会先按名字显示、再跳成别的顺序。
    保存的排序已经失效（例如排序用的字段被删了）时退回默认排序；返回的 profiles_page 里
    的 sort / order 就是实际使用的排序，前端照着它设置排序下拉框。
    """
    current = db()
    sort, order = saved_sort()
    try:
        first_page = current.list_profiles(sort=sort, order=order)
    except ValueError:
        first_page = current.list_profiles(sort=DEFAULT_SORT, order=default_order(DEFAULT_SORT))
    return {
        "library": libraries.current_name(),
        "libraries": libraries.summary(),
        "last_profile_id": (store.data.get("session", {}).get("last_profile") or {}).get(libraries.current),
        "profiles": first_page["items"],
        "profiles_page": {key: first_page[key] for key in PAGE_META_KEYS},
        "profile_fields": current.list_fields(),
        "tags": current.list_tags(limit=100),
        "field_kinds": field_kind_options(),
    }


def profile_list_args():
    """把 URL 查询参数整理成 ProfileDB.list_profiles 的参数（取值是否合法由 ProfileDB 校验）。

    例：/api/profiles?page=2&page_size=50&q=李&tag=名人&tag=KP&tag_mode=all
                    &born_from=1980&born_to=1989&sort=birth&order=desc
        /api/profiles?q=土星过境&scope=all                 全文检索（名字、标签、所有字段原文）
        /api/profiles?sort=field:3&order=desc            按 3 号字段（数字 / 日期）从大到小
        /api/profiles?ff={"field":3,"min":"10","max":"20"}&ff={"field":7,"options":["已婚"]}
                                                         字段条件，可以多条（彼此“并且”）
    """
    args = request.args
    tags = args.getlist("tag")
    if args.get("tags"):
        tags.append(args["tags"])            # 也接受 tags=名人,KP
    try:
        field_filters = [json.loads(text) for text in args.getlist("ff") if text.strip()]
    except json.JSONDecodeError:
        raise ValueError("字段筛选条件（ff）不是合法的 JSON。")
    return {
        "page": args.get("page"),
        "page_size": args.get("page_size"),
        "q": args.get("q"),
        "scope": args.get("scope", "name"),
        "field_filters": field_filters,
        "tags": tags,
        "tag_mode": args.get("tag_mode", "all"),
        "born_from": args.get("born_from"),
        "born_to": args.get("born_to"),
        "sort": args.get("sort") or DEFAULT_SORT,
        "order": args.get("order") or None,          # 不传时用这个排序依据的默认方向
        "with_total": args.get("with_total", "1").strip().lower() not in ("0", "false", "no"),
    }


def page_response(page):
    """列表接口：data 是当前页的人物（轻量），分页信息放在同级的 page / total / has_more 等键里。"""
    return ok(page["items"], **{key: page[key] for key in PAGE_META_KEYS})


def create_blueprint(library_manager, settings_store):
    global libraries, store
    libraries = library_manager
    store = settings_store
    return bp


# ---------------------------------------------------------------- 档案库

@bp.get("/api/libraries")
def list_libraries():
    return ok({"current": libraries.current_name(), "libraries": libraries.summary()})


@bp.post("/api/libraries/switch")
def switch_library():
    """切换到另一个档案库，并记住它（下次打开网页自动用这个库）。目标库锁定时返回 423。"""
    try:
        payload = request.get_json(force=True) or {}
        name = libraries.select(payload.get("name"))
        if name is None:
            raise ValueError(f"没有名为「{payload.get('name')}」的档案库。")
        store.save_session({"library": name})
        libraries.switch(name)
        return ok(library_payload())
    except LockedError as exc:
        return locked_response(exc)
    except ValueError as exc:
        return fail(exc, 400)


@bp.post("/api/libraries")
def create_library():
    """新建一个空的档案库并切换过去。"""
    try:
        payload = request.get_json(force=True) or {}
        libraries.switch(libraries.create(payload.get("name")))
        store.save_session({"library": libraries.current})
        return ok(library_payload())
    except ValueError as exc:
        return fail(exc, 400)


@bp.put("/api/libraries/current")
@unlocked_required
def rename_library():
    """给当前档案库改名（就是给 libraries/ 里的文件改名）。"""
    try:
        payload = request.get_json(force=True) or {}
        old = libraries.current
        new = libraries.rename(old, payload.get("name"))
        store.rename_library_in_session(old, new)
        return ok({"current": new, "libraries": libraries.summary()})
    except ValueError as exc:
        return fail(exc, 400)
    except OSError as exc:
        return fail(f"改名失败：{exc}", 500)


@bp.post("/api/session")
def update_session():
    # 记住当前选中的档案（下次打开网页时自动选回来），以及当前档案库「选择人物」列表的排序。
    try:
        payload = dict(request.get_json(force=True) or {})
        if "last_profile_id" in payload:
            # 前端只传“当前档案库里选中了谁”，记到这个库名下。
            profile_id = payload.pop("last_profile_id")
            payload["last_profile"] = {libraries.current: profile_id}
            if isinstance(profile_id, int) and not isinstance(profile_id, bool) and profile_id > 0:
                _mark_opened(profile_id)
        if "profile_sort" in payload:
            # 同样只传当前档案库的排序：{"sort": ..., "order": ...}，记到这个库名下。
            payload["profile_sort"] = {libraries.current: payload["profile_sort"]}
        return ok(store.save_session(payload))
    except ValueError as exc:
        return fail(exc, 400)
    except OSError as exc:
        current_app.logger.exception("Saving session failed")
        return fail(f"会话设置写入 settings.json 失败：{exc}", 500)


def _mark_opened(profile_id):
    """记下「最近打开」时间。只是排序用的辅助信息：库被锁定、档案已删除等情况下静默跳过，不影响选人。"""
    try:
        db().mark_opened(profile_id)
    except Exception:
        current_app.logger.warning("Recording last-opened time failed", exc_info=True)


# ---------------------------------------------------------------- 加密

@bp.get("/api/security")
def security_status():
    return ok(libraries.security_status(request.args.get("library")))


def _password_action(action):
    """加密相关操作都只作用于一个档案库：请求里的 library，没写时是当前库。"""
    try:
        payload = request.get_json(force=True) or {}
        name = payload.get("library") or libraries.current_name()
        result = action(name, payload) or {}
        return ok({**result, **libraries.security_status(result.get("library") or name)})
    except ValueError as exc:
        return fail(exc, 400)
    except OSError as exc:
        current_app.logger.exception("Encryption file operation failed")
        return fail(f"读写档案库文件失败：{exc}", 500)


@bp.post("/api/security/unlock")
def security_unlock():
    return _password_action(lambda name, p: libraries.unlock(name, p.get("password")))


@bp.post("/api/security/lock")
def security_lock():
    return _password_action(lambda name, p: libraries.lock(name))


@bp.post("/api/security/enable")
def security_enable():
    return _password_action(lambda name, p: libraries.enable_encryption(name, p.get("password")))


@bp.post("/api/security/disable")
def security_disable():
    return _password_action(lambda name, p: libraries.disable_encryption(name, p.get("password")))


@bp.post("/api/security/password")
def security_change_password():
    return _password_action(lambda name, p: libraries.change_password(name, p.get("old_password"), p.get("new_password")))


# ---------------------------------------------------------------- 人物档案

@bp.get("/api/profiles")
@unlocked_required
def list_profiles():
    try:
        return page_response(db().list_profiles(**profile_list_args()))
    except ValueError as exc:
        return fail(exc, 400)
    except Exception as exc:
        current_app.logger.exception("Profile listing failed")
        return fail(exc, 500)


@bp.get("/api/profiles/export.csv")
@unlocked_required
def export_profiles_csv():
    """全部档案导出为 CSV（下载文件）。"""
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    return Response(
        stream_with_context(db().iter_csv()),      # 边读边发，几十万份档案也不占内存
        mimetype="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename=people-{stamp}.csv"},
    )


@bp.post("/api/profiles/import")
@unlocked_required
def import_profiles_csv():
    """上传 CSV 导入：全部成功才写入，有任何一行出错则数据库不变。"""
    upload = request.files.get("file")
    if upload is None:
        return fail("没有收到 CSV 文件。", 400)
    try:
        return ok(db().import_csv(upload.read()))
    except ValueError as exc:
        return fail(exc, 400)
    except Exception as exc:
        current_app.logger.exception("CSV import failed")
        return fail(f"导入失败：{exc}", 500)


@bp.get("/api/profiles/check-name")
@unlocked_required
def check_profile_name():
    """新建前检查有没有同名档案（列表不再全量加载，前端没法再自己在内存里比对）。"""
    count = db().count_name(request.args.get("name", ""), request.args.get("exclude_id"))
    return ok({"count": count})


@bp.get("/api/profiles/<int:profile_id>")
@unlocked_required
def get_profile(profile_id):
    # 只有点开具体某个人时才会走到这里：返回出生细节 + 全部自定义字段 + 标签。
    item = db().get_profile(profile_id)
    if item is None:
        return fail("人物档案不存在。", 404)
    return ok(item)


@bp.post("/api/profiles")
@unlocked_required
def create_profile():
    try:
        payload = request.get_json(force=True) or {}
        return ok(db().create_profile(payload))
    except Exception as exc:
        return fail(exc, 400)


@bp.put("/api/profiles/<int:profile_id>")
@unlocked_required
def update_profile(profile_id):
    try:
        payload = request.get_json(force=True) or {}
        item = db().update_profile(profile_id, payload)
        if item is None:
            return fail("人物档案不存在。", 404)
        return ok(item)
    except Exception as exc:
        return fail(exc, 400)


@bp.delete("/api/profiles/<int:profile_id>")
@unlocked_required
def delete_profile(profile_id):
    if not db().delete_profile(profile_id):
        return fail("人物档案不存在。", 404)
    return ok({"deleted": profile_id})


# ---------------------------------------------------------------- 分类标签

@bp.get("/api/tags")
@unlocked_required
def list_tags():
    try:
        return ok(db().list_tags(request.args.get("q"), request.args.get("limit", 200)))
    except ValueError as exc:
        return fail(exc, 400)


@bp.put("/api/tags/<int:tag_id>")
@unlocked_required
def rename_tag(tag_id):
    # 改成已有标签的名字时两者合并（返回 merged: true）。
    try:
        payload = request.get_json(force=True) or {}
        result = db().rename_tag(tag_id, payload.get("name"))
        if result is None:
            return fail("标签不存在。", 404)
        return ok(result)
    except ValueError as exc:
        return fail(exc, 400)


@bp.delete("/api/tags/<int:tag_id>")
@unlocked_required
def delete_tag(tag_id):
    # 从所有档案中去掉这个标签。
    if not db().delete_tag(tag_id):
        return fail("标签不存在。", 404)
    return ok({"deleted": tag_id})


# ---------------------------------------------------------------- 自定义字段

@bp.get("/api/profile-fields")
@unlocked_required
def list_profile_fields():
    return ok(db().list_fields())


@bp.post("/api/profile-fields")
@unlocked_required
def create_profile_field():
    try:
        payload = request.get_json(force=True) or {}
        return ok(db().create_field(
            payload.get("label"), payload.get("kind") or "text", payload.get("options"), payload.get("parent_id")
        ))
    except Exception as exc:
        return fail(exc, 400)


@bp.put("/api/profile-fields/order")
@unlocked_required
def reorder_profile_fields():
    # 字段的显示顺序：编辑档案、档案资料、排序 / 筛选下拉框、CSV 导出都按这个顺序。
    try:
        payload = request.get_json(force=True) or {}
        return ok(db().reorder_fields(payload.get("ids") or []))
    except Exception as exc:
        return fail(exc, 400)


@bp.put("/api/profile-fields/<int:field_id>")
@unlocked_required
def update_profile_field(field_id):
    try:
        payload = request.get_json(force=True) or {}
        item = db().update_field(field_id, payload)
        if item is None:
            return fail("字段不存在。", 404)
        return ok(item)
    except Exception as exc:
        return fail(exc, 400)


@bp.get("/api/profile-fields/<int:field_id>/option-usage")
@unlocked_required
def profile_field_option_usage(field_id):
    # 单选 / 多选字段每个选项有多少人选了（删除选项前提示用）。
    return ok(db().option_usage(field_id))


@bp.get("/api/profile-fields/<int:field_id>/usage")
@unlocked_required
def profile_field_usage(field_id):
    # 删除前提示：这个字段连同全部下级，一共有多少份档案填了内容。
    return ok(db().field_usage(field_id))


@bp.delete("/api/profile-fields/<int:field_id>")
@unlocked_required
def delete_profile_field(field_id):
    # 同时删除所有档案里这个字段的数据（数据库外键级联）。
    if not db().delete_field(field_id):
        return fail("字段不存在。", 404)
    return ok({"deleted": field_id})


