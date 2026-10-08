from __future__ import annotations

from pathlib import Path
from flask import Flask, jsonify, render_template, request

from profile_db import FIELD_KINDS, ProfileDB
from web_bridge import (
    DEFAULT_SETTINGS,
    calculate_full_chart,
    calculate_partial_chart,
    load_settings,
    public_options,
    safe_json,
)

BASE_DIR = Path(__file__).resolve().parent
USER_DATA_DIR = BASE_DIR / "user_data"
USER_DATA_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(
    __name__,
    template_folder=str(BASE_DIR / "templates"),
    static_folder=str(BASE_DIR / "static"),
)
app.config["JSON_AS_ASCII"] = False

# Flask 默认会把返回的 JSON 的键按字母序重排：行星会变成 Ke, Ma, Me, Mo, Ra…，
# 宫头会变成 house 1, house 10, house 11, house 12, house 2…，
# 后端按计算顺序排好的行序到了页面上就全乱了。关掉后，表格行序 = 后端的计算顺序。
app.json.sort_keys = False

settings = load_settings(BASE_DIR / "user_data" / "settings.json")
profile_db = ProfileDB(BASE_DIR / "user_data" / "people.sqlite3")

PAGE_META_KEYS = ("page", "page_size", "total", "total_pages", "has_more", "sort", "order")


def ok(data=None, **extra):
    payload = {"ok": True}
    if data is not None:
        payload["data"] = safe_json(data)
    payload.update(safe_json(extra))
    return jsonify(payload)


def fail(message, status=400):
    return jsonify({"ok": False, "error": str(message)}), status


def field_kind_options():
    return [{"value": key, "label": label} for key, label in FIELD_KINDS.items()]


def profile_list_args():
    """把 URL 查询参数整理成 ProfileDB.list_profiles 的参数（取值是否合法由 ProfileDB 校验）。

    例：/api/profiles?page=2&page_size=50&q=李&tag=名人&tag=案例&tag_mode=all
                    &born_from=1980&born_to=1989&sort=birth&order=desc
        /api/profiles?sort=field:3&order=desc            按 3 号字段的数值从大到小
        /api/profiles?num_field=3&num_min=10&num_max=20  3 号字段数值在 10~20 之间
    """
    args = request.args
    tags = args.getlist("tag")
    if args.get("tags"):
        tags.append(args["tags"])            # 也接受 tags=名人,案例
    return {
        "page": args.get("page"),
        "page_size": args.get("page_size"),
        "q": args.get("q"),
        "tags": tags,
        "tag_mode": args.get("tag_mode", "all"),
        "born_from": args.get("born_from"),
        "born_to": args.get("born_to"),
        "sort": args.get("sort", "name"),
        "order": args.get("order", "asc"),
        "num_field": args.get("num_field"),
        "num_min": args.get("num_min"),
        "num_max": args.get("num_max"),
        "with_total": args.get("with_total", "1").strip().lower() not in ("0", "false", "no"),
    }


def page_response(page):
    """列表接口：data 是当前页的人物（轻量），分页信息放在同级的 page / total / has_more 等键里。"""
    return ok(page["items"], **{key: page[key] for key in PAGE_META_KEYS})


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/bootstrap")
def bootstrap():
    # 启动时只带第一页（50 人）的轻量信息，不再把整个档案库读进来。
    first_page = profile_db.list_profiles()
    data = {
        "settings": settings,
        "options": public_options(),
        "profiles": first_page["items"],
        "profiles_page": {key: first_page[key] for key in PAGE_META_KEYS},
        "profile_fields": profile_db.list_fields(),
        "field_kinds": field_kind_options(),
        "tags": profile_db.list_tags(limit=100),
    }
    return ok(data, **data)


@app.post("/api/chart/full")
def chart_full():
    try:
        payload = request.get_json(force=True) or {}
        return ok(calculate_full_chart(payload))
    except Exception as exc:
        app.logger.exception("Full chart calculation failed")
        return fail(exc, 400)


@app.post("/api/chart/partial")
def chart_partial():
    try:
        payload = request.get_json(force=True) or {}
        return ok(calculate_partial_chart(payload))
    except Exception as exc:
        app.logger.exception("Partial chart calculation failed")
        return fail(exc, 400)


# ---------------------------------------------------------------- 人物档案

@app.get("/api/profiles")
def list_profiles():
    try:
        return page_response(profile_db.list_profiles(**profile_list_args()))
    except ValueError as exc:
        return fail(exc, 400)
    except Exception as exc:
        app.logger.exception("Profile listing failed")
        return fail(exc, 500)


@app.get("/api/profiles/check-name")
def check_profile_name():
    """新建前检查有没有同名档案（列表不再全量加载，前端没法再自己在内存里比对）。"""
    count = profile_db.count_name(request.args.get("name", ""), request.args.get("exclude_id"))
    return ok({"count": count})


@app.get("/api/profiles/<int:profile_id>")
def get_profile(profile_id):
    # 只有点开具体某个人时才会走到这里：返回出生细节 + 全部自定义字段 + 标签。
    item = profile_db.get_profile(profile_id)
    if item is None:
        return fail("人物档案不存在。", 404)
    return ok(item)


@app.post("/api/profiles")
def create_profile():
    try:
        payload = request.get_json(force=True) or {}
        return ok(profile_db.create_profile(payload))
    except Exception as exc:
        return fail(exc, 400)


@app.put("/api/profiles/<int:profile_id>")
def update_profile(profile_id):
    try:
        payload = request.get_json(force=True) or {}
        item = profile_db.update_profile(profile_id, payload)
        if item is None:
            return fail("人物档案不存在。", 404)
        return ok(item)
    except Exception as exc:
        return fail(exc, 400)


@app.delete("/api/profiles/<int:profile_id>")
def delete_profile(profile_id):
    if not profile_db.delete_profile(profile_id):
        return fail("人物档案不存在。", 404)
    return ok({"deleted": profile_id})


# ---------------------------------------------------------------- 分类标签

@app.get("/api/tags")
def list_tags():
    try:
        return ok(profile_db.list_tags(request.args.get("q"), request.args.get("limit", 200)))
    except ValueError as exc:
        return fail(exc, 400)


# ---------------------------------------------------------------- 自定义字段

@app.get("/api/profile-fields")
def list_profile_fields():
    return ok(profile_db.list_fields())


@app.post("/api/profile-fields")
def create_profile_field():
    try:
        payload = request.get_json(force=True) or {}
        return ok(profile_db.create_field(payload.get("label"), payload.get("kind") or "text"))
    except Exception as exc:
        return fail(exc, 400)


@app.put("/api/profile-fields/<int:field_id>")
def update_profile_field(field_id):
    try:
        payload = request.get_json(force=True) or {}
        item = profile_db.update_field(field_id, payload)
        if item is None:
            return fail("字段不存在。", 404)
        return ok(item)
    except Exception as exc:
        return fail(exc, 400)


@app.delete("/api/profile-fields/<int:field_id>")
def delete_profile_field(field_id):
    # 同时删除所有档案里这个字段的数据（数据库外键级联）。
    if not profile_db.delete_field(field_id):
        return fail("字段不存在。", 404)
    return ok({"deleted": field_id})


if __name__ == "__main__":
    host = str(settings.get("server", {}).get("host", DEFAULT_SETTINGS["server"]["host"]))
    port = int(settings.get("server", {}).get("port", DEFAULT_SETTINGS["server"]["port"]))
    app.run(
        host=host,
        port=port,
        debug=False,
        use_reloader=False,
        threaded=True,
    )
