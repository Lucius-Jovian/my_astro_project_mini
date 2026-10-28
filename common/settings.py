"""settings.json 的读写。

文件结构：
    {
      "server":           {"host", "port"}                       共用
      "default_location": {...}                                  共用：过境盘的默认地点
      "birth_defaults":   {"calendar"}                           共用
      "session":          {"library", "last_profile", "last_system", "profile_sort"}
                                                                 共用：上次用的档案库、人物、体系、各库的人物排序
      "appearance":       {"coord_format"}                       共用：经纬度格式
      "layout":           {"tab_order": {体系: [标签页]}}         共用：各体系结果区标签页的顺序
      "systems": {
        "vedic":   {...}   印度占星自己的设置（由 systems/vedic 定义和校验）
        "western": {...}   西方占星自己的设置（由 systems/western 定义和校验）
      }
    }

各体系在启动时用 register_system() 登记自己的默认值和整理函数；
网页上改了设置时，用 write() 只改其中一节，写之前会重新读一遍磁盘上的文件，
所以程序运行期间手工改过的其它设置不会被覆盖。
"""

from __future__ import annotations

import json
import re
import threading
from pathlib import Path
from typing import Callable, Mapping

SHARED_DEFAULTS = {
    "server": {
        "host": "127.0.0.1",
        "port": 5300,
    },
    "default_location": {
        "latitude": 23.0331389,
        "longitude": 113.1010556,
        "timezone": "+08:00",
        "label": "默认地点",
    },
    "birth_defaults": {
        "calendar": "g",
    },
    # 会话：上一次使用的档案库、每个档案库里上一次选中的人物、上一次打开的占星体系，
    # 以及每个档案库「选择人物」列表的排序（{档案库名: {"sort": ..., "order": ...}}，只记排序，不记筛选和搜索）。
    "session": {"library": None, "last_profile": {}, "last_system": None, "profile_sort": {}},
    # 页面外观（两个体系共用）：在网页上切换后会自动写回。
    "appearance": {
        "coord_format": "dms",       # 经纬度输入：dms 度分秒（默认）/ decimal 十进制度
    },
    # 版面：各体系结果区标签页的顺序（拖动标签页后自动写回）。
    "layout": {"tab_order": {}},
}

_PROFILE_SORT_RE = re.compile(r"^(?:opened|name|birth|updated|created|field:\d+)$")
_TAB_ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,40}$")

APPEARANCE_CHOICES = {
    "coord_format": ("dms", "decimal"),
}


def _copy(value):
    return json.loads(json.dumps(value))


def deep_merge(base, override):
    result = _copy(base)
    for key, value in (override or {}).items():
        if isinstance(value, Mapping) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


class SettingsStore:
    def __init__(self, path):
        self.path = Path(path)
        self.data: dict = {}
        self._systems: dict[str, tuple[dict, Callable | None]] = {}
        self._lock = threading.RLock()

    # ------------------------------------------------------------------ 体系登记

    def register_system(self, system_id, defaults, normalize=None):
        """normalize(merged_section) -> 整理好的 section；读文件时调用，不合法的内容在这里纠正。"""
        self._systems[system_id] = (_copy(defaults), normalize)

    def system_ids(self):
        return list(self._systems)

    def system(self, system_id) -> dict:
        return self.data["systems"][system_id]

    # ------------------------------------------------------------------ 读

    def load(self):
        with self._lock:
            raw = {}
            if self.path.exists():
                raw = json.loads(self.path.read_text(encoding="utf-8"))
            data = deep_merge(SHARED_DEFAULTS, {k: v for k, v in raw.items() if k != "systems"})
            appearance = data["appearance"]
            # 升级：旧版本的文件里还有 theme（日间 / 夜间）。第一次升级时把经纬度输入改成新的默认值“度分秒”，
            # 并把清理后的外观设置写回文件；之后在网页上的选择照常记住。
            raw_appearance = raw.get("appearance") if isinstance(raw.get("appearance"), dict) else {}
            upgrade_appearance = "theme" in raw_appearance
            if upgrade_appearance:
                appearance["coord_format"] = "dms"
            for key, choices in APPEARANCE_CHOICES.items():
                if appearance.get(key) not in choices:
                    appearance[key] = SHARED_DEFAULTS["appearance"][key]
            for key in list(appearance):
                if key not in APPEARANCE_CHOICES:
                    appearance.pop(key)
            layout = data["layout"] if isinstance(data.get("layout"), dict) else {}
            order = layout.get("tab_order") if isinstance(layout.get("tab_order"), dict) else {}
            data["layout"] = {**layout, "tab_order": {
                str(sid): [str(t) for t in tabs if isinstance(t, str)]
                for sid, tabs in order.items() if isinstance(tabs, list)
            }}
            data["systems"] = {}
            raw_systems = raw.get("systems") if isinstance(raw.get("systems"), dict) else {}
            for sid, (defaults, normalize) in self._systems.items():
                merged = deep_merge(defaults, raw_systems.get(sid) or {})
                data["systems"][sid] = normalize(merged) if normalize else merged
            # 已经不存在的体系，原样保留在文件里（以后装回来还能用），只是不加载。
            self.data = data
            if upgrade_appearance and self.path.exists():
                self.write(("appearance",), dict(appearance), merge=False)
            if not self.path.exists():
                self.path.parent.mkdir(parents=True, exist_ok=True)
                self._dump({**data, "systems": {**raw_systems, **data["systems"]}})
            return data

    # ------------------------------------------------------------------ 写

    def _dump(self, payload):
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp.replace(self.path)

    def write(self, keys, values, *, merge=True):
        """把 values 写到 keys 指向的那一节，例如 ("appearance",) 或 ("systems", "western", "points")。

        merge=True 且两边都是 dict 时只更新传来的键；否则整节替换。返回内存里更新后的那一节。
        """
        keys = tuple(keys)
        with self._lock:
            try:
                on_disk = json.loads(self.path.read_text(encoding="utf-8")) if self.path.exists() else {}
            except json.JSONDecodeError as exc:
                raise ValueError(f"settings.json 不是合法的 JSON（第 {exc.lineno} 行），设置没有保存。") from exc
            for target in (on_disk, self.data):
                node = target
                for key in keys[:-1]:
                    if not isinstance(node.get(key), dict):
                        node[key] = {}
                    node = node[key]
                last = keys[-1]
                if merge and isinstance(values, dict) and isinstance(node.get(last), dict):
                    node[last].update(_copy(values))
                else:
                    node[last] = _copy(values)
            self._dump(on_disk)
            node = self.data
            for key in keys:
                node = node[key]
            return node

    # ------------------------------------------------------------------ 共用的几节

    def save_appearance(self, updates):
        clean = {}
        for key, value in (updates or {}).items():
            if key not in APPEARANCE_CHOICES:
                raise ValueError(f"未知的外观设置：{key}")
            if value not in APPEARANCE_CHOICES[key]:
                raise ValueError(f"外观设置 {key} 只能是 {'、'.join(APPEARANCE_CHOICES[key])}。")
            clean[key] = value
        # 整节写回（merge=False）：顺手清掉旧版本留在文件里、已经不用的外观设置（例如 theme）。
        return dict(self.write(("appearance",), {**self.data.get("appearance", {}), **clean}, merge=False))

    def save_tab_order(self, system_id, order):
        """记住某个体系结果区标签页的顺序（标签页的 id 列表）。"""
        if system_id not in self._systems:
            raise ValueError(f"未知的占星体系：{system_id}")
        if not isinstance(order, list) or len(order) > 60:
            raise ValueError("标签页顺序必须是列表。")
        clean = []
        for item in order:
            if not isinstance(item, str) or not _TAB_ID_RE.match(item):
                raise ValueError(f"标签页的 id 不合法：{item!r}")
            if item not in clean:
                clean.append(item)
        return list(self.write(("layout", "tab_order", system_id), clean, merge=False))

    def save_session(self, updates):
        """updates 可含：library（档案库名）、last_profile（{档案库名: 人物 id 或 null}）、last_system、
        profile_sort（{档案库名: {"sort": 排序依据, "order": "asc" | "desc"} 或 null}）。

        排序依据只检查写法（opened / name / birth / updated / created / field:<id>）；
        字段是否还存在由档案库在使用时检查，失效时自动退回默认排序。
        """
        session = _copy(self.data.get("session") or {})
        for key, value in (updates or {}).items():
            if key == "library":
                if not isinstance(value, str) or not value.strip():
                    raise ValueError("library 必须是档案库名称。")
                session["library"] = value
            elif key == "last_profile":
                if not isinstance(value, dict):
                    raise ValueError("last_profile 必须是 {档案库: 人物 id}。")
                merged = dict(session.get("last_profile") or {})
                for lib, pid in value.items():
                    if pid is not None and (not isinstance(pid, int) or isinstance(pid, bool) or pid < 1):
                        raise ValueError("人物 id 必须是正整数或 null。")
                    if pid is None:
                        merged.pop(str(lib), None)
                    else:
                        merged[str(lib)] = pid
                session["last_profile"] = merged
            elif key == "profile_sort":
                if not isinstance(value, dict):
                    raise ValueError("profile_sort 必须是 {档案库: {sort, order}}。")
                merged = dict(session.get("profile_sort") or {})
                for lib, entry in value.items():
                    if entry is None:
                        merged.pop(str(lib), None)
                        continue
                    sort = entry.get("sort") if isinstance(entry, dict) else None
                    order = entry.get("order") if isinstance(entry, dict) else None
                    if not isinstance(sort, str) or not _PROFILE_SORT_RE.match(sort):
                        raise ValueError(f"排序依据不合法：{sort!r}")
                    if order not in ("asc", "desc"):
                        raise ValueError("排序方向只能是 asc 或 desc。")
                    merged[str(lib)] = {"sort": sort, "order": order}
                session["profile_sort"] = merged
            elif key == "last_system":
                if value not in self._systems:
                    raise ValueError(f"未知的占星体系：{value}")
                session["last_system"] = value
            else:
                raise ValueError(f"未知的会话设置：{key}")
        return dict(self.write(("session",), session, merge=False))

    def forget_library(self, name):
        """档案库被删除后：去掉会话里关于它的记录（上次选中的人、排序、当前库）。"""
        session = _copy(self.data.get("session") or {})
        for key in ("last_profile", "profile_sort"):
            entries = dict(session.get(key) or {})
            entries.pop(name, None)
            session[key] = entries
        if session.get("library") == name:
            session["library"] = None
        self.write(("session",), session, merge=False)

    def rename_library_in_session(self, old, new):
        session = _copy(self.data.get("session") or {})
        for key in ("last_profile", "profile_sort"):
            entries = dict(session.get(key) or {})
            if old in entries:
                entries[new] = entries.pop(old)
            session[key] = entries
        if session.get("library") == old:
            session["library"] = new
        self.write(("session",), session, merge=False)

    # ------------------------------------------------------------------ 导出 / 导入设置
    #
    # 导出的是“计算与显示用的设置”，方便另一个项目组或另一台电脑原样沿用：
    #   共用：default_location、birth_defaults、appearance、layout；
    #   体系：systems.<体系>（计算设置默认值、星体配置、相位、古典设置、星盘样式等）。
    # 不导出 server（各机器的地址端口）和 session（上次用的档案库和人物）。

    EXPORT_FORMAT = "quant-astro-settings"
    EXPORT_VERSION = 1
    EXPORT_SHARED = ("default_location", "birth_defaults", "appearance", "layout")

    def export_bundle(self):
        with self._lock:
            return {
                "format": self.EXPORT_FORMAT,
                "version": self.EXPORT_VERSION,
                "shared": {key: _copy(self.data.get(key)) for key in self.EXPORT_SHARED},
                "systems": {sid: _copy(self.data["systems"][sid]) for sid in self._systems},
            }

    def import_bundle(self, bundle):
        """导入 export_bundle() 导出的内容：只替换文件里出现的那几节，其它设置不动。
        写盘后重新 load()，各节照常经过默认值合并和各体系的整理函数，不合法的内容在那里纠正。
        返回 {"shared": [导入的共用节], "systems": [导入的体系]}。"""
        if not isinstance(bundle, dict) or bundle.get("format") != self.EXPORT_FORMAT:
            raise ValueError("这不是本程序导出的设置文件。")
        if int(bundle.get("version") or 0) > self.EXPORT_VERSION:
            raise ValueError("这个设置文件来自更新版本的程序，请先升级程序再导入。")
        shared = bundle.get("shared") if isinstance(bundle.get("shared"), dict) else {}
        systems = bundle.get("systems") if isinstance(bundle.get("systems"), dict) else {}
        done = {"shared": [], "systems": []}
        with self._lock:
            for key in self.EXPORT_SHARED:
                if isinstance(shared.get(key), dict):
                    self.write((key,), shared[key], merge=False)
                    done["shared"].append(key)
            for sid in self._systems:
                if isinstance(systems.get(sid), dict):
                    self.write(("systems", sid), systems[sid], merge=False)
                    done["systems"].append(sid)
            if not done["shared"] and not done["systems"]:
                raise ValueError("设置文件里没有可导入的内容。")
            self.load()
        return done

