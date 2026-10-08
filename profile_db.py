from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
import math
import re
import sqlite3
import unicodedata

# 必备字段（人名、时间、地点）直接是 people 表的列，不属于“自定义字段”，
# 因此既不能被删除，也不允许用同名标签再建一个自定义字段。
CORE_FIELD_LABELS = {
    "人物名称", "人物姓名", "姓名", "名称",
    "出生时间", "时间", "本地时间", "时区", "UTC 时区",
    "纬度", "经度", "地点", "出生地点",
}

MAX_LABEL_LEN = 40
MAX_VALUE_LEN = 20000
MAX_TAG_LEN = 30
MAX_TAGS_PER_PROFILE = 20

SCHEMA_VERSION = 3

DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 200

# 自定义字段只有两种类型：
#   text    文本（单行）。只存原文，不建任何检索。
#   number  数字。除了保留用户输入的原文（value），还会解析出一个数值存进 num_value，
#           并建 (字段, 数值) 索引——排序和范围筛选走这个数值，而不是比较文本。
# 数据库里只放“人物相关的数据标签”和“排盘必要的要素”，
# 不记录星座、度数之类的星盘结果，所以没有度数/星座这类字段类型。
FIELD_KINDS = {
    "text": "文本",
    "number": "数字",
}
NUMERIC_KINDS = frozenset({"number"})


# ====================================================================== 解析工具
# 这些都是不依赖数据库的纯函数：把用户敲进去的文本，变成可以按大小比较的数字。

def _norm(text):
    """全角→半角、统一负号，并去掉首尾空白。"""
    s = unicodedata.normalize("NFKC", str(text))
    return s.replace("\u2212", "-").replace("\u2013", "-").strip()


_THOUSANDS_RE = re.compile(r"[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?")
_NUM_RE = re.compile(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?")


def parse_number(text):
    """"12" "-3.5" "1,024" "１２" → 数字；其他写法（含 nan/inf）一律视为无法识别。"""
    s = _norm(text)
    if not s:
        return None
    if _THOUSANDS_RE.fullmatch(s):
        s = s.replace(",", "")
    if not _NUM_RE.fullmatch(s):
        return None
    value = float(s)
    return value if math.isfinite(value) else None


def parse_birth_time(text):
    """出生时间文本 → (YYYYMMDD 整数, 当天第几秒)；无法识别或带时区则返回 None。"""
    try:
        parsed = datetime.fromisoformat(str(text).strip().replace("T", " "))
    except ValueError:
        return None
    if parsed.tzinfo is not None:
        return None
    return (
        parsed.year * 10000 + parsed.month * 100 + parsed.day,
        parsed.hour * 3600 + parsed.minute * 60 + parsed.second,
    )


def derive_num(kind, text):
    """按字段类型把原文解析成数值；非数值类型或无法识别时返回 None。"""
    return parse_number(text) if kind == "number" else None


_PERIOD_RE = re.compile(r"^\s*(\d{1,4})(?:\s*[-/.]\s*(\d{1,2}))?(?:\s*[-/.]\s*(\d{1,2}))?\s*$")


def period_bound(text, *, end):
    """出生日期筛选的边界：'1980' / '1980-05' / '1980-05-12' → YYYYMMDD 整数。

    作为起点取这段时间的第一天，作为终点取最后一天，所以
    born_from=1980 & born_to=1989 就是“1980 年初到 1989 年底”。
    """
    m = _PERIOD_RE.match(_norm(text))
    if not m:
        raise ValueError(f"日期筛选格式不对：{text!r}，请用 1980、1980-05 或 1980-05-12。")
    year = int(m.group(1))
    month = int(m.group(2)) if m.group(2) else None
    day = int(m.group(3)) if m.group(3) else None
    if month is not None and not 1 <= month <= 12:
        raise ValueError(f"日期筛选里的月份不对：{text!r}")
    if day is not None and not 1 <= day <= 31:
        raise ValueError(f"日期筛选里的日不对：{text!r}")
    if end:
        return year * 10000 + (month or 12) * 100 + (day or 31)
    return year * 10000 + (month or 1) * 100 + (day or 1)


# ======================================================================= 数据库

class ProfileDB:
    """人物档案库。

    表结构（schema v3）：
      people          必备字段：名称、出生时间、时区、纬度、经度、创建/更新时间；
                      另有两个由出生时间派生出来的整数列 birth_ymd / birth_tod，
                      用来做按年份/日期范围筛选和按出生先后排序。
      profile_fields  自定义字段的“定义”（字段名、类型 kind：文本 / 数字）
      profile_values  每个人在每个自定义字段上的“取值”：
                        value      用户输入的原文
                        num_value  数字类型解析出的数值（文本类型为 NULL）
      tags            分类标签（名称唯一，不分大小写）
      people_tags     人物 ↔ 标签（多对多）

    索引原则：
      建索引：人名、出生日期、修改时间、纬度/经度、(字段, 数值)、(标签, 人物)。
      不建索引：profile_values.value —— 文本原文就存在这一列，没有任何索引会包含它，
      所以文字再多也不会撑大索引；列表查询根本不会去碰这一列。

    增加字段 = 在 profile_fields 里加一行，所有档案立刻拥有该字段（值为空）。
    删除字段 = 删掉 profile_fields 里的那一行，profile_values 里所有人的这一项
    由外键 ON DELETE CASCADE 一并删除，不需要逐个档案处理。
    """

    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    # ------------------------------------------------------------------ 连接

    def _connect(self):
        conn = sqlite3.connect(
            self.path,
            timeout=5.0,
            isolation_level=None,  # 自动提交模式；需要事务时手动 BEGIN/COMMIT
        )
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = DELETE")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.execute("PRAGMA temp_store = MEMORY")
        conn.execute("PRAGMA cache_size = -16384")  # 每个连接最多 16 MB 页缓存
        return conn

    @contextmanager
    def _read(self):
        conn = self._connect()
        try:
            yield conn
        finally:
            conn.close()

    @contextmanager
    def _tx(self):
        """写事务：成功则提交，任何异常则整体回滚，并保证连接被关闭。"""
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            try:
                yield conn
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            else:
                conn.execute("COMMIT")
                try:
                    # 让 SQLite 在需要时自己刷新统计信息（通常什么也不做，很便宜）。
                    conn.execute("PRAGMA optimize")
                except sqlite3.Error:
                    pass
        finally:
            conn.close()

    # ------------------------------------------------------------ 建表 / 迁移

    _PEOPLE_DDL = """
        CREATE TABLE {name} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            display_name TEXT NOT NULL,
            birth_time TEXT NOT NULL,
            timezone_offset TEXT NOT NULL,
            latitude REAL NOT NULL,
            longitude REAL NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            birth_ymd INTEGER,
            birth_tod INTEGER
        )
    """

    _INDEXES = (
        "CREATE INDEX IF NOT EXISTS idx_people_display_name "
        "ON people(display_name COLLATE NOCASE)",
        "CREATE INDEX IF NOT EXISTS idx_people_birth "
        "ON people(birth_ymd, birth_tod)",
        "CREATE INDEX IF NOT EXISTS idx_people_updated "
        "ON people(updated_at)",
        "CREATE INDEX IF NOT EXISTS idx_people_latitude "
        "ON people(latitude)",
        "CREATE INDEX IF NOT EXISTS idx_people_longitude "
        "ON people(longitude)",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_fields_label "
        "ON profile_fields(label COLLATE NOCASE)",
        # 同时服务：按字段数值排序/筛选、统计某字段被多少人填过、删除字段时的级联清理。
        "CREATE INDEX IF NOT EXISTS idx_pv_field_num "
        "ON profile_values(field_id, num_value)",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name "
        "ON tags(name COLLATE NOCASE)",
        "CREATE INDEX IF NOT EXISTS idx_people_tags_tag "
        "ON people_tags(tag_id, profile_id)",
    )

    def _db_state(self):
        """返回 (people 表现有的列名列表, PRAGMA user_version)。"""
        with self._read() as conn:
            columns = [row["name"] for row in conn.execute("PRAGMA table_info(people)")]
            version = int(conn.execute("PRAGMA user_version").fetchone()[0])
        return columns, version

    def _init_db(self):
        columns, version = self._db_state()
        existing = bool(columns)
        legacy_notes = self._read_legacy_notes() if "note" in columns else None

        # 已有数据的库在改结构之前，先整库另存一份。
        if legacy_notes is not None:
            self._backup_before_migration("before-fields")
        elif existing and version < SCHEMA_VERSION:
            self._backup_before_migration(f"before-v{SCHEMA_VERSION}")

        with self._tx() as conn:
            if legacy_notes is not None:
                # 旧版 people 表带有固定的 note 列：重建为只含必备字段的新表。
                # 此时 profile_values 还不存在，所以 DROP 旧表不会触发级联删除。
                conn.execute(self._PEOPLE_DDL.format(name="people_new"))
                conn.execute(
                    """
                    INSERT INTO people_new (
                        id, display_name, birth_time, timezone_offset,
                        latitude, longitude, created_at, updated_at
                    )
                    SELECT id, display_name, birth_time, timezone_offset,
                           latitude, longitude, created_at, updated_at
                    FROM people
                    """
                )
                conn.execute("DROP TABLE people")
                conn.execute("ALTER TABLE people_new RENAME TO people")

            conn.execute(self._PEOPLE_DDL.format(name="IF NOT EXISTS people"))
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS profile_fields (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    label TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    kind TEXT NOT NULL DEFAULT 'text'
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS profile_values (
                    profile_id INTEGER NOT NULL
                        REFERENCES people(id) ON DELETE CASCADE,
                    field_id INTEGER NOT NULL
                        REFERENCES profile_fields(id) ON DELETE CASCADE,
                    value TEXT NOT NULL,
                    num_value REAL,
                    PRIMARY KEY (profile_id, field_id)
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS tags (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS people_tags (
                    profile_id INTEGER NOT NULL
                        REFERENCES people(id) ON DELETE CASCADE,
                    tag_id INTEGER NOT NULL
                        REFERENCES tags(id) ON DELETE CASCADE,
                    PRIMARY KEY (profile_id, tag_id)
                ) WITHOUT ROWID
                """
            )

            # 旧版已存在的表：补上 v2 新增的列。
            self._ensure_column(conn, "people", "birth_ymd", "INTEGER")
            self._ensure_column(conn, "people", "birth_tod", "INTEGER")
            self._ensure_column(conn, "profile_fields", "kind", "TEXT NOT NULL DEFAULT 'text'")
            self._ensure_column(conn, "profile_values", "num_value", "REAL")

            if legacy_notes is not None:
                # 把原来的“备注”变成第一个自定义字段，并迁移已有内容。
                cursor = conn.execute(
                    "INSERT INTO profile_fields (label, created_at, kind) "
                    "VALUES (?, ?, 'text')",
                    ("备注", self._now()),
                )
                field_id = int(cursor.lastrowid)
                for profile_id, note in legacy_notes:
                    if note and str(note).strip():
                        conn.execute(
                            "INSERT INTO profile_values (profile_id, field_id, value) "
                            "VALUES (?, ?, ?)",
                            (profile_id, field_id, str(note)),
                        )

            self._migrate(conn, version)

            for ddl in self._INDEXES:
                conn.execute(ddl)
            conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

        if version < SCHEMA_VERSION:
            # 刚建好/刚迁移完的库：采集一次统计信息，让查询计划从第一天起就是对的。
            with self._read() as conn:
                conn.execute("ANALYZE")

    @staticmethod
    def _ensure_column(conn, table, column, ddl):
        columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
        if column not in columns:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")

    @staticmethod
    def _migrate(conn, version):
        """把旧版本的数据补齐/整理到当前结构（只在 user_version 低于当前版本时执行）。"""
        if version < 2:
            # 由出生时间文本派生出整数日期，之后按年份筛选/排序都走整数索引。
            batch = []
            for row in conn.execute("SELECT id, birth_time FROM people"):
                parsed = parse_birth_time(row["birth_time"])
                ymd, tod = parsed if parsed else (None, None)
                batch.append((ymd, tod, int(row["id"])))
            conn.executemany(
                "UPDATE people SET birth_ymd = ?, birth_tod = ? WHERE id = ?", batch
            )

        if version < 3:
            # v3 只保留“文本 / 数字”两种字段类型，并彻底去掉“多行”。
            # 旧的 多行/度数/日期 字段统一变回文本：原文一个字都不动，只是不再参与数值排序。
            conn.execute(
                "UPDATE profile_fields SET kind = 'text' WHERE kind NOT IN ('text', 'number')"
            )
            conn.execute(
                "UPDATE profile_values SET num_value = NULL "
                "WHERE num_value IS NOT NULL AND field_id IN "
                "(SELECT id FROM profile_fields WHERE kind = 'text')"
            )
            columns = {r["name"] for r in conn.execute("PRAGMA table_info(profile_fields)")}
            if "multiline" in columns:
                try:
                    conn.execute("ALTER TABLE profile_fields DROP COLUMN multiline")
                except sqlite3.OperationalError:
                    # SQLite 低于 3.35 不支持 DROP COLUMN：留着这一列也无妨
                    # （它有默认值，新代码从不读写它）。
                    pass

    def _read_legacy_notes(self):
        """旧结构（people 表里有 note 列）返回 [(id, note), ...]；否则返回 None。"""
        with self._read() as conn:
            columns = [row["name"] for row in conn.execute("PRAGMA table_info(people)")]
            if "note" not in columns:
                return None
            rows = conn.execute("SELECT id, note FROM people").fetchall()
            return [(int(row["id"]), row["note"]) for row in rows]

    def _backup_before_migration(self, tag):
        """迁移前把整库另存一份，放在同一个 user_data 目录里。"""
        backup = self.path.with_name(f"{self.path.name}.{tag}.bak")
        if backup.exists():
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            backup = self.path.with_name(f"{self.path.name}.{tag}.{stamp}.bak")
        source = sqlite3.connect(self.path)
        target = sqlite3.connect(backup)
        try:
            source.backup(target)
        finally:
            target.close()
            source.close()

    # --------------------------------------------------------------- 小工具

    @staticmethod
    def _now():
        return datetime.now(timezone.utc).isoformat()

    @staticmethod
    def _int_arg(value, name, default, lo, hi):
        if value is None or value == "":
            return default
        try:
            number = int(value)
        except (TypeError, ValueError):
            raise ValueError(f"{name} 必须是整数。")
        return max(lo, min(hi, number))

    @staticmethod
    def _like(text):
        """把用户输入变成 LIKE 的“包含”模式，并转义 % _ \\ 这三个特殊字符。"""
        escaped = (
            str(text).strip()
            .replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        )
        return f"%{escaped}%"

    @staticmethod
    def _validate(data):
        display_name = str(data.get("display_name", "")).strip()
        birth_time = str(data.get("birth_time", "")).strip().replace("T", " ")
        timezone_offset = str(data.get("timezone_offset", "")).strip()

        if not display_name:
            raise ValueError("人物名称不能为空。")
        if not birth_time:
            raise ValueError("出生时间不能为空。")
        if not timezone_offset:
            raise ValueError("时区不能为空。")

        parsed = parse_birth_time(birth_time)
        if parsed is None:
            raise ValueError("出生时间格式无法识别，请使用 YYYY-MM-DD HH:MM[:SS]（不带时区）。")

        try:
            latitude = float(data.get("latitude"))
            longitude = float(data.get("longitude"))
        except (TypeError, ValueError):
            raise ValueError("经纬度必须是数字。")

        if not -90 <= latitude <= 90:
            raise ValueError("纬度必须位于 -90 到 90 之间。")
        if not -180 <= longitude <= 180:
            raise ValueError("经度必须位于 -180 到 180 之间。")

        return {
            "display_name": display_name,
            "birth_time": birth_time,
            "birth_ymd": parsed[0],
            "birth_tod": parsed[1],
            "timezone_offset": timezone_offset,
            "latitude": latitude,
            "longitude": longitude,
        }

    @staticmethod
    def _clean_label(label):
        label = " ".join(str(label or "").split())
        if not label:
            raise ValueError("字段名不能为空。")
        if len(label) > MAX_LABEL_LEN:
            raise ValueError(f"字段名不能超过 {MAX_LABEL_LEN} 个字符。")
        if label in CORE_FIELD_LABELS:
            raise ValueError(f"「{label}」是必备字段，不能当作自定义字段名。")
        return label

    @staticmethod
    def _clean_kind(kind):
        kind = str(kind).strip().lower()
        if kind not in FIELD_KINDS:
            raise ValueError(
                "字段类型只能是：" + "、".join(f"{k}（{v}）" for k, v in FIELD_KINDS.items())
            )
        return kind

    @staticmethod
    def _clean_field_values(conn, raw):
        """把前端传来的 {字段id: 值} 整理成 {int: (原文, 数值或None)}。

        未知字段 id（例如刚在别处被删）直接忽略；
        文本字段是单行的：内容里的换行统一换成一个空格；
        数字字段如果内容无法识别，明确报错，而不是悄悄存成不能排序的文本。
        """
        if not raw:
            return {}
        defs = {
            int(r["id"]): (r["label"], r["kind"])
            for r in conn.execute("SELECT id, label, kind FROM profile_fields")
        }
        clean = {}
        for key, value in dict(raw).items():
            try:
                field_id = int(key)
            except (TypeError, ValueError):
                continue
            if field_id not in defs:
                continue
            label, kind = defs[field_id]
            text = "" if value is None else str(value)
            if len(text) > MAX_VALUE_LEN:
                raise ValueError(f"单个字段的内容不能超过 {MAX_VALUE_LEN} 个字符。")
            number = None
            if kind in NUMERIC_KINDS:
                text = text.strip()
                if text:
                    number = derive_num(kind, text)
                    if number is None:
                        raise ValueError(
                            f"字段「{label}」是「{FIELD_KINDS[kind]}」类型，"
                            f"无法识别「{text}」（请填数字，例如 12、-3.5、1,024）。"
                        )
            else:
                text = re.sub(r"\s*[\r\n]+\s*", " ", text)
            clean[field_id] = (text, number)
        return clean

    @staticmethod
    def _write_field_values(conn, profile_id, values):
        for field_id, (text, number) in values.items():
            if text.strip() == "":
                conn.execute(
                    "DELETE FROM profile_values WHERE profile_id = ? AND field_id = ?",
                    (profile_id, field_id),
                )
            else:
                conn.execute(
                    """
                    INSERT INTO profile_values (profile_id, field_id, value, num_value)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(profile_id, field_id) DO UPDATE
                        SET value = excluded.value, num_value = excluded.num_value
                    """,
                    (profile_id, field_id, text, number),
                )

    # ------------------------------------------------------------ 自定义字段

    @staticmethod
    def _field_dict(row):
        kind = row["kind"] if row["kind"] in FIELD_KINDS else "text"
        return {
            "id": int(row["id"]),
            "label": row["label"],
            "kind": kind,
            "kind_label": FIELD_KINDS[kind],
            "sortable": kind in NUMERIC_KINDS,
            "used_count": int(row["used_count"]),
        }

    _FIELD_SELECT = """
        SELECT f.id, f.label, f.kind,
               COUNT(v.profile_id) AS used_count
        FROM profile_fields AS f
        LEFT JOIN profile_values AS v ON v.field_id = f.id
    """

    def list_fields(self):
        with self._read() as conn:
            rows = conn.execute(
                self._FIELD_SELECT + " GROUP BY f.id ORDER BY f.id"
            ).fetchall()
        return [self._field_dict(r) for r in rows]

    def _get_field(self, field_id):
        with self._read() as conn:
            row = conn.execute(
                self._FIELD_SELECT + " WHERE f.id = ? GROUP BY f.id", (int(field_id),)
            ).fetchone()
        return None if row is None else self._field_dict(row)

    def create_field(self, label, kind="text"):
        label = self._clean_label(label)
        kind = self._clean_kind(kind or "text")
        try:
            with self._tx() as conn:
                cursor = conn.execute(
                    "INSERT INTO profile_fields (label, created_at, kind) VALUES (?, ?, ?)",
                    (label, self._now(), kind),
                )
                field_id = int(cursor.lastrowid)
        except sqlite3.IntegrityError:
            raise ValueError(f"已经有名为「{label}」的字段了。")
        return self._get_field(field_id)

    def update_field(self, field_id, data):
        current = self._get_field(field_id)
        if current is None:
            return None

        label = self._clean_label(data["label"]) if "label" in data else current["label"]
        kind = self._clean_kind(data["kind"]) if data.get("kind") else current["kind"]

        unparsed = 0
        try:
            with self._tx() as conn:
                conn.execute(
                    "UPDATE profile_fields SET label = ?, kind = ? WHERE id = ?",
                    (label, kind, int(field_id)),
                )
                if kind != current["kind"]:
                    unparsed = self._rederive_field(conn, int(field_id), kind)
        except sqlite3.IntegrityError:
            raise ValueError(f"已经有名为「{label}」的字段了。")

        result = self._get_field(field_id)
        if unparsed:
            # 原文都还在，只是这几条没法参与排序；改成数字写法后重新保存即可。
            result["unparsed_count"] = unparsed
        return result

    @staticmethod
    def _rederive_field(conn, field_id, kind):
        """字段类型变了：按新类型重新解析这个字段下所有人的数值，返回无法识别的条数。"""
        if kind not in NUMERIC_KINDS:
            conn.execute(
                "UPDATE profile_values SET num_value = NULL WHERE field_id = ?",
                (field_id,),
            )
            return 0
        updates, bad = [], 0
        for row in conn.execute(
            "SELECT profile_id, value FROM profile_values WHERE field_id = ?", (field_id,)
        ):
            number = derive_num(kind, row["value"])
            if number is None:
                bad += 1
            updates.append((number, int(row["profile_id"]), field_id))
        conn.executemany(
            "UPDATE profile_values SET num_value = ? WHERE profile_id = ? AND field_id = ?",
            updates,
        )
        return bad

    def delete_field(self, field_id):
        """删除字段，并（通过外键级联）删除所有档案里这个字段的数据。"""
        with self._tx() as conn:
            cursor = conn.execute(
                "DELETE FROM profile_fields WHERE id = ?", (int(field_id),)
            )
        return cursor.rowcount > 0

    # ------------------------------------------------------------------ 标签

    @staticmethod
    def _clean_tags(raw):
        """接受列表或字符串（逗号/顿号/分号/换行分隔）；去空、去重（不分大小写）、限长。"""
        if raw is None:
            return []
        items = [raw] if isinstance(raw, str) else list(raw)
        result, seen = [], set()
        for item in items:
            for piece in re.split(r"[,，、;；\n]+", str(item)):
                name = " ".join(piece.split())
                if not name:
                    continue
                if len(name) > MAX_TAG_LEN:
                    raise ValueError(f"单个标签不能超过 {MAX_TAG_LEN} 个字符：{name[:12]}…")
                key = name.casefold()
                if key in seen:
                    continue
                seen.add(key)
                result.append(name)
        if len(result) > MAX_TAGS_PER_PROFILE:
            raise ValueError(f"一份档案最多 {MAX_TAGS_PER_PROFILE} 个标签。")
        return result

    @staticmethod
    def _prune_tags(conn):
        """清掉没有任何人使用的标签，标签表不会越积越多。"""
        conn.execute(
            "DELETE FROM tags WHERE NOT EXISTS "
            "(SELECT 1 FROM people_tags pt WHERE pt.tag_id = tags.id)"
        )

    def _write_tags(self, conn, profile_id, names):
        """把这个人的标签整体换成 names（增删差集，不重写没变的）。"""
        wanted = set()
        for name in names:
            row = conn.execute(
                "SELECT id FROM tags WHERE name = ? COLLATE NOCASE", (name,)
            ).fetchone()
            if row is None:
                wanted.add(int(conn.execute("INSERT INTO tags (name) VALUES (?)", (name,)).lastrowid))
            else:
                wanted.add(int(row["id"]))

        current = {
            int(r["tag_id"])
            for r in conn.execute(
                "SELECT tag_id FROM people_tags WHERE profile_id = ?", (profile_id,)
            )
        }
        removed = current - wanted
        for tag_id in removed:
            conn.execute(
                "DELETE FROM people_tags WHERE profile_id = ? AND tag_id = ?",
                (profile_id, tag_id),
            )
        for tag_id in wanted - current:
            conn.execute(
                "INSERT INTO people_tags (profile_id, tag_id) VALUES (?, ?)",
                (profile_id, tag_id),
            )
        if removed:
            self._prune_tags(conn)

    def list_tags(self, q=None, limit=200):
        limit = self._int_arg(limit, "limit", 200, 1, 1000)
        where, params = "", []
        if q and str(q).strip():
            where = "WHERE t.name LIKE ? ESCAPE '\\'"
            params.append(self._like(q))
        with self._read() as conn:
            rows = conn.execute(
                f"""
                SELECT t.id, t.name, COUNT(pt.profile_id) AS profile_count
                FROM tags AS t
                LEFT JOIN people_tags AS pt ON pt.tag_id = t.id
                {where}
                GROUP BY t.id
                ORDER BY profile_count DESC, t.name COLLATE NOCASE
                LIMIT ?
                """,
                params + [limit],
            ).fetchall()
        return [
            {"id": int(r["id"]), "name": r["name"], "profile_count": int(r["profile_count"])}
            for r in rows
        ]

    @staticmethod
    def _tags_of(conn, profile_ids):
        """一次查出一批人的标签：{人物id: [标签名, ...]}。"""
        if not profile_ids:
            return {}
        marks = ",".join("?" * len(profile_ids))  # 只拼接占位符，值仍然走参数绑定
        result = {}
        for r in conn.execute(
            f"""
            SELECT pt.profile_id, t.name
            FROM people_tags AS pt
            JOIN tags AS t ON t.id = pt.tag_id
            WHERE pt.profile_id IN ({marks})
            ORDER BY t.name COLLATE NOCASE
            """,
            list(profile_ids),
        ):
            result.setdefault(int(r["profile_id"]), []).append(r["name"])
        return result

    # ------------------------------------------------------------------ 档案：列表

    # 排序键白名单：用户传来的 sort 只能在这里查表，绝不会被拼进 SQL。
    _CORE_SORTS = {
        "name": ("p.display_name COLLATE NOCASE",),
        "birth": ("p.birth_ymd", "p.birth_tod"),
        "updated": ("p.updated_at",),
        "created": ("p.id",),
        "latitude": ("p.latitude",),
        "longitude": ("p.longitude",),
    }

    def _field_kind(self, conn, field_id):
        row = conn.execute(
            "SELECT label, kind FROM profile_fields WHERE id = ?", (int(field_id),)
        ).fetchone()
        if row is None:
            raise ValueError(f"字段不存在：{field_id}")
        return row["label"], row["kind"]

    def _tag_condition(self, conn, tags, mode):
        names = self._clean_tags(tags)
        if not names:
            return None, []
        ids = []
        for name in names:
            row = conn.execute(
                "SELECT id FROM tags WHERE name = ? COLLATE NOCASE", (name,)
            ).fetchone()
            if row is not None:
                ids.append(int(row["id"]))
            elif mode == "all":
                return "1 = 0", []        # 要求同时具备某个根本不存在的标签：必然没有结果
        ids = sorted(set(ids))
        if not ids:
            return "1 = 0", []
        marks = ",".join("?" * len(ids))
        if mode == "all" and len(ids) > 1:
            return (
                "p.id IN (SELECT profile_id FROM people_tags "
                f"WHERE tag_id IN ({marks}) GROUP BY profile_id HAVING COUNT(*) = ?)",
                ids + [len(ids)],
            )
        return f"p.id IN (SELECT profile_id FROM people_tags WHERE tag_id IN ({marks}))", ids

    def list_profiles(
        self,
        *,
        page=1,
        page_size=DEFAULT_PAGE_SIZE,
        q=None,
        tags=None,
        tag_mode="all",
        born_from=None,
        born_to=None,
        sort="name",
        order="asc",
        num_field=None,
        num_min=None,
        num_max=None,
        with_total=True,
    ):
        """分页列表：每页只返回 id、名字、出生时间、修改时间、标签，绝不带自定义字段的内容。

        筛选（可叠加）：
          q                 名字包含（不分大小写）
          tags / tag_mode   标签；all＝必须同时具备（默认），any＝具备其一即可
          born_from/born_to 出生日期范围，写 1980 / 1980-05 / 1980-05-12 均可
          num_field + num_min/num_max
                            某个数字类自定义字段的数值范围
        排序：sort ＝ name | birth | updated | created | latitude | longitude | field:<字段id>
              order ＝ asc | desc；没有数值的人始终排在最后。
        """
        page = self._int_arg(page, "page", 1, 1, 10**9)
        size = self._int_arg(page_size, "page_size", DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE)
        offset = (page - 1) * size

        order = str(order or "asc").strip().lower()
        if order not in ("asc", "desc"):
            raise ValueError("order 只能是 asc 或 desc。")
        tag_mode = str(tag_mode or "all").strip().lower()
        if tag_mode not in ("all", "any"):
            raise ValueError("tag_mode 只能是 all 或 any。")
        sort = str(sort or "name").strip()

        with self._read() as conn:
            where, params = [], []

            if q and str(q).strip():
                where.append("p.display_name LIKE ? ESCAPE '\\'")
                params.append(self._like(q))

            if born_from not in (None, ""):
                where.append("p.birth_ymd >= ?")
                params.append(period_bound(born_from, end=False))
            if born_to not in (None, ""):
                where.append("p.birth_ymd <= ?")
                params.append(period_bound(born_to, end=True))

            condition, tag_params = self._tag_condition(conn, tags, tag_mode)
            if condition:
                where.append(condition)
                params.extend(tag_params)

            if num_field not in (None, "") and (
                num_min not in (None, "") or num_max not in (None, "")
            ):
                label, kind = self._field_kind(conn, num_field)
                if kind not in NUMERIC_KINDS:
                    raise ValueError(f"字段「{label}」不是数字类型，不能按数值筛选。")
                parts, sub_params = ["field_id = ?"], [int(num_field)]
                for text, op in ((num_min, ">="), (num_max, "<=")):
                    if text in (None, ""):
                        continue
                    bound = parse_number(text)
                    if bound is None:
                        raise ValueError(f"无法识别筛选值：{text!r}，请填数字。")
                    parts.append(f"num_value {op} ?")
                    sub_params.append(bound)
                where.append(
                    "p.id IN (SELECT profile_id FROM profile_values WHERE "
                    + " AND ".join(parts) + ")"
                )
                params.extend(sub_params)

            # ---- 排序
            direction = "ASC" if order == "asc" else "DESC"
            field_sort = None          # 按自定义字段排序时：该字段的 id
            order_sql = ""
            if sort.startswith("field:"):
                try:
                    field_sort = int(sort.split(":", 1)[1])
                except ValueError:
                    raise ValueError("sort 里的字段 id 必须是整数，例如 field:3。")
                label, kind = self._field_kind(conn, field_sort)
                if kind not in NUMERIC_KINDS:
                    raise ValueError(f"字段「{label}」不是数字类型，不能按大小排序。")
            elif sort in self._CORE_SORTS:
                columns = list(self._CORE_SORTS[sort])
                if sort != "created":
                    columns.append("p.id")   # 并列时按 id 兜底，翻页顺序稳定
                order_sql = ", ".join(f"{col} {direction}" for col in columns)
            else:
                raise ValueError(
                    "sort 只能是 name / birth / updated / created / latitude / longitude / field:<id>。"
                )

            where_sql = ("WHERE " + " AND ".join(where)) if where else ""

            total = None
            if with_total:
                total = int(
                    conn.execute(
                        f"SELECT COUNT(*) FROM people AS p {where_sql}", params
                    ).fetchone()[0]
                )

            if field_sort is None:
                rows = conn.execute(
                    f"""
                    SELECT p.id, p.display_name, p.birth_time, p.updated_at
                    FROM people AS p
                    {where_sql}
                    ORDER BY {order_sql}
                    LIMIT ? OFFSET ?
                    """,
                    params + [size + 1, offset],   # 多取 1 条，用来判断还有没有下一页
                ).fetchall()
            else:
                rows = self._rows_by_field(
                    conn, field_sort, direction, where, params, size + 1, offset
                )

            has_more = len(rows) > size
            rows = rows[:size]
            tag_map = self._tags_of(conn, [int(r["id"]) for r in rows])

        items = [
            {
                "id": int(r["id"]),
                "display_name": r["display_name"],
                "birth_time": r["birth_time"],
                "updated_at": r["updated_at"],
                "tags": tag_map.get(int(r["id"]), []),
            }
            for r in rows
        ]
        return {
            "items": items,
            "page": page,
            "page_size": size,
            "total": total,
            "total_pages": None if total is None else max(1, math.ceil(total / size)),
            "has_more": has_more,
            "sort": sort,
            "order": order,
        }

    @staticmethod
    def _rows_by_field(conn, field_id, direction, where, params, limit, offset):
        """按某个数字类字段的数值排序的一页（含 limit 条）。

        不用 “people LEFT JOIN 取值 ORDER BY” —— 那样要把全库每个人都查一遍再临时排序。
        改成两段，各自都能提前收工：
          ① 有数值的人：直接顺着 (字段, 数值) 索引读，读够一页就停；
          ② 没有数值的人（没填，或写的内容无法识别）：排在最后，按 id 顺序读。
        """
        extra = (" AND " + " AND ".join(where)) if where else ""
        columns = "p.id, p.display_name, p.birth_time, p.updated_at"

        rows = conn.execute(
            f"""
            SELECT {columns}
            FROM profile_values AS sv
            JOIN people AS p ON p.id = sv.profile_id
            WHERE sv.field_id = ? AND sv.num_value IS NOT NULL{extra}
            ORDER BY sv.num_value {direction}, sv.profile_id {direction}
            LIMIT ? OFFSET ?
            """,
            [field_id] + params + [limit, offset],
        ).fetchall()
        if len(rows) >= limit:
            return rows            # 常规翻页：这一页全是有数值的人，到此为止，不需要任何统计

        # 走到这里说明“有数值的人”在这一页或之前就读完了，需要知道一共有几个，
        # 才能算出接下来在“没有数值的人”里该从第几个开始读。
        if rows:
            with_value_count = offset + len(rows)
        elif offset == 0:
            with_value_count = 0
        else:
            count_from = (
                "profile_values AS sv JOIN people AS p ON p.id = sv.profile_id"
                if where else "profile_values AS sv"
            )
            with_value_count = conn.execute(
                f"SELECT COUNT(*) FROM {count_from} "
                f"WHERE sv.field_id = ? AND sv.num_value IS NOT NULL{extra}",
                [field_id] + params,
            ).fetchone()[0]

        rows += conn.execute(
            f"""
            SELECT {columns}
            FROM people AS p
            WHERE NOT EXISTS (
                SELECT 1 FROM profile_values AS sv
                WHERE sv.profile_id = p.id AND sv.field_id = ?
                  AND sv.num_value IS NOT NULL
            ){extra}
            ORDER BY p.id {direction}
            LIMIT ? OFFSET ?
            """,
            [field_id] + params + [limit - len(rows), max(0, offset - with_value_count)],
        ).fetchall()
        return rows

    def count_name(self, name, exclude_id=None):
        """同名档案有几份（不分大小写）；新建前用来提示“已经有同名档案”。"""
        sql = "SELECT COUNT(*) FROM people WHERE display_name = ? COLLATE NOCASE"
        params = [str(name or "").strip()]
        if exclude_id not in (None, ""):
            sql += " AND id <> ?"
            params.append(int(exclude_id))
        with self._read() as conn:
            return int(conn.execute(sql, params).fetchone()[0])

    # ------------------------------------------------------------------ 档案：详情 / 写入

    def get_profile(self, profile_id):
        """点开某个人时才调用：必备字段 + 全部自定义字段（含长文）+ 标签。"""
        profile_id = int(profile_id)
        with self._read() as conn:
            row = conn.execute(
                """
                SELECT id, display_name, birth_time, timezone_offset,
                       latitude, longitude, created_at, updated_at
                FROM people WHERE id = ?
                """,
                (profile_id,),
            ).fetchone()
            if row is None:
                return None
            values = conn.execute(
                "SELECT field_id, value FROM profile_values WHERE profile_id = ?",
                (profile_id,),
            ).fetchall()
            tags = self._tags_of(conn, [profile_id]).get(profile_id, [])
        item = dict(row)
        item["fields"] = {str(int(v["field_id"])): v["value"] for v in values}
        item["tags"] = tags
        return item

    def _insert_profile(self, conn, data):
        """在已有事务里插入一份档案并返回新 id（以后做批量导入时可以在一个事务里反复调用它）。"""
        clean = self._validate(data)
        now = self._now()
        field_values = self._clean_field_values(conn, data.get("fields"))
        tags = self._clean_tags(data.get("tags"))
        cursor = conn.execute(
            """
            INSERT INTO people (
                display_name, birth_time, timezone_offset,
                latitude, longitude, created_at, updated_at,
                birth_ymd, birth_tod
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                clean["display_name"],
                clean["birth_time"],
                clean["timezone_offset"],
                clean["latitude"],
                clean["longitude"],
                now,
                now,
                clean["birth_ymd"],
                clean["birth_tod"],
            ),
        )
        profile_id = int(cursor.lastrowid)
        self._write_field_values(conn, profile_id, field_values)
        if tags:
            self._write_tags(conn, profile_id, tags)
        return profile_id

    def create_profile(self, data):
        with self._tx() as conn:
            profile_id = self._insert_profile(conn, data)
        return self.get_profile(profile_id)

    def update_profile(self, profile_id, data):
        """覆盖保存：必备字段整体覆盖；请求里带了的自定义字段/标签覆盖，没带的保持不变。"""
        profile_id = int(profile_id)
        with self._tx() as conn:
            if conn.execute("SELECT 1 FROM people WHERE id = ?", (profile_id,)).fetchone() is None:
                return None

            clean = self._validate(data)
            field_values = self._clean_field_values(conn, data.get("fields"))
            tags = self._clean_tags(data.get("tags")) if "tags" in data else None

            conn.execute(
                """
                UPDATE people
                SET display_name = ?,
                    birth_time = ?,
                    timezone_offset = ?,
                    latitude = ?,
                    longitude = ?,
                    birth_ymd = ?,
                    birth_tod = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    clean["display_name"],
                    clean["birth_time"],
                    clean["timezone_offset"],
                    clean["latitude"],
                    clean["longitude"],
                    clean["birth_ymd"],
                    clean["birth_tod"],
                    self._now(),
                    profile_id,
                ),
            )
            self._write_field_values(conn, profile_id, field_values)
            if tags is not None:
                self._write_tags(conn, profile_id, tags)
        return self.get_profile(profile_id)

    def delete_profile(self, profile_id):
        with self._tx() as conn:
            cursor = conn.execute(
                "DELETE FROM people WHERE id = ?",
                (int(profile_id),),
            )
            if cursor.rowcount > 0:
                self._prune_tags(conn)
        return cursor.rowcount > 0
