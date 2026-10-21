"""接口返回格式与 JSON 转换（各体系的路由也用这里的 ok / fail）。"""

from __future__ import annotations

from dataclasses import asdict, is_dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Mapping

from flask import jsonify


def ok(data=None, **extra):
    payload = {"ok": True}
    if data is not None:
        payload["data"] = safe_json(data)
    payload.update(safe_json(extra))
    return jsonify(payload)


def fail(message, status=400, **extra):
    return jsonify({"ok": False, "error": str(message), **extra}), status


def safe_json(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if is_dataclass(value):
        return safe_json(asdict(value))
    if isinstance(value, Mapping):
        return {str(k): safe_json(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [safe_json(v) for v in value]
    if hasattr(value, "to_dict"):
        try:
            return safe_json(value.to_dict())
        except TypeError:
            return safe_json(value.to_dict(json_safe=True))
    return str(value)
