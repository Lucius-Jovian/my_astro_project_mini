from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
import csv
import io
import json
import math
import re
import threading
import unicodedata

from .driver import apply_key, sqlite as sqlite3

# 必备字段（人名、时间、历法、地点）直接是 people 表的列，不属于“自定义字段”，
# 因此既不能被删除，也不允许用同名再建一个自定义字段。
# CSV 的固定列名也在这里，避免自定义字段与它们重名、导入时分不清。
CORE_FIELD_LABELS = {
    "id", "人物名称", "人物姓名", "姓名", "名称",
    "出生时间", "时间", "本地时间", "历法", "时区", "UTC 时区",
    "纬度", "经度", "地点", "出生地点",
    "标签", "分类标签", "创建时间", "修改时间",
}

MAX_LABEL_LEN = 40
MAX_VALUE_LEN = 20000
MAX_TAG_LEN = 30
MAX_TAGS_PER_PROFILE = 20
MAX_OPTION_LEN = 30
MAX_OPTIONS = 200
MAX_FIELD_FILTERS = 10

SCHEMA_VERSION = 6
MAX_FIELD_DEPTH = 5          # 字段最多嵌套 5 层
PATH_SEP = "/"               # 字段路径的分隔符（CSV 表头写成 婚姻/是否二婚），字段名里不能出现
POOL_SIZE = 4                # 每个档案库保留的空闲连接数

DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 200

# 选择人物列表的排序依据，以及各自的默认方向（切换排序依据时自动换成它的默认方向）。
# 另有 field:<数字 / 日期字段 id>，默认正序。
SORT_DEFAULT_ORDER = {"opened": "desc", "name": "asc", "birth": "asc", "updated": "desc", "created": "desc"}
FIELD_SORT_DEFAULT_ORDER = "asc"
DEFAULT_SORT = "opened"      # 新档案库、或者保存的排序已经失效（例如排序用的字段被删了）时用它


def default_order(sort):
    """某个排序依据的默认方向。"""
    sort = str(sort or "")
    if sort.startswith("field:"):
        return FIELD_SORT_DEFAULT_ORDER
    return SORT_DEFAULT_ORDER.get(sort, SORT_DEFAULT_ORDER[DEFAULT_SORT])


def fraction_to_ms(digits):
    """秒的小数部分（数字串，可以任意长）→ 毫秒整数，四舍五入到 3 位小数。

    进位到 1000 时记成 999，不再往分钟进位：差别不到 1 毫秒，远小于出生时间能达到的精度。
    """
    if not digits:
        return 0
    return min(999, int(round(float("0." + digits) * 1000)))


def ms_suffix(ms):
    """毫秒 → 秒后面的小数部分：0 → ""，500 → ".5"，25 → ".025"。"""
    return f".{ms:03d}".rstrip("0") if ms else ""

# 历法：起盘的必备要素之一。
CALENDARS = {"g": "格里历", "j": "儒略历"}

# 自定义字段的类型：
#   text    文本（可多行，如长篇分析）。原文参与全文检索。
#   number  数字。另存解析出的数值 num_value，并建 (字段, 数值) 索引：可排序、可按范围筛选。
#   date    日期。可写 2020-05-12、2020-05 或 2020；num_value 存 YYYYMMDD 整数
#           （缺月/日记 00），同样可排序、可按范围筛选。
#   choice  单选。选项事先定义好，只能选一个；选中的选项另存进 profile_choices 并建索引。
#   multi   多选。同上，可以选多个。
#   group   分组。自己不存值，只用来收纳下级字段（例如“婚姻”下面放“是否二婚”“结婚次数”）。
# 任何字段都可以有下级字段（parent_id 指向上级），最多 MAX_FIELD_DEPTH 层。
# 数据库里只放“人物相关的数据”和“排盘必要的要素”，不记录星座、度数之类的星盘结果。
FIELD_KINDS = {
    "text": "文本",
    "number": "数字",
    "date": "日期",
    "choice": "单选",
    "multi": "多选",
    "group": "分组",
}
NUMERIC_KINDS = frozenset({"number", "date"})     # 有 num_value，可排序、可范围筛选
CHOICE_KINDS = frozenset({"choice", "multi"})      # 有 profile_choices，可按选项筛选

# 多选值、标签在文本里的分隔符（显示时用“、”连接）。
_LIST_SPLIT_RE = re.compile(r"[,，、;；\n]+")
_OPTION_FORBIDDEN = set(",，、;；\n")


# ====================================================================== 解析工具
# 这些都是不依赖数据库的纯函数。

def _norm(text):
    """全角→半角、统一负号，并去掉首尾空白。"""
    s = unicodedata.normalize("NFKC", str(text))
    return s.replace("−", "-").replace("–", "-").strip()


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


def is_leap_year(year, calendar):
    if calendar == "j":
        return year % 4 == 0
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)


def days_in_month(year, month, calendar):
    if month == 2:
        return 29 if is_leap_year(year, calendar) else 28
    return 30 if month in (4, 6, 9, 11) else 31


def _jdn(year, month, day, calendar):
    a = (14 - month) // 12
    y = year + 4800 - a
    m = month + 12 * a - 3
    base = day + (153 * m + 2) // 5 + 365 * y + y // 4
    return base - 32083 if calendar == "j" else base - y // 100 + y // 400 - 32045


def _gregorian_from_jdn(jdn):
    a = jdn + 32044
    b = (4 * a + 3) // 146097
    c = a - 146097 * b // 4
    d = (4 * c + 3) // 1461
    e = c - 1461 * d // 4
    m = (5 * e + 2) // 153
    day = e - (153 * m + 2) // 5 + 1
    month = m + 3 - 12 * (m // 10)
    year = 100 * b + d - 4800 + m // 10
    return year, month, day


# 出生时间：接受 1990-05-12 08:30:00、1990/5/12 8:30、1990-05-12T08:30 等写法
# （Excel 另存 CSV 时常把日期改成斜杠、去掉前导零或秒）。
_BIRTH_RE = re.compile(
    r"^\s*(\d{1,4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[ T]+(\d{1,2})[:：时](\d{1,2})(?:[:：分](\d{1,2})(?:\.(\d+))?秒?)?)?\s*$"
)


def parse_birth_time(text, calendar="g"):
    """出生时间文本 → (规范文本, YYYYMMDD, 当天第几秒)；不合法返回 None。

    规范文本按原历法写成 “YYYY-MM-DD HH:MM:SS”，秒可以带最多 3 位小数（如 08:30:05.25），
    更多位数四舍五入到 3 位。当天第几秒只取整数秒，只用于排序和筛选。YYYYMMDD 是换算到格里历后的日期，
    这样格里历、儒略历的档案混在一起时，按出生先后排序、按年份筛选仍然正确。
    """
    m = _BIRTH_RE.match(_norm(text))
    if not m:
        return None
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    h, mi, s = int(m.group(4) or 0), int(m.group(5) or 0), int(m.group(6) or 0)
    if not (1 <= y <= 9999 and 1 <= mo <= 12 and 1 <= d <= days_in_month(y, mo, calendar)):
        return None
    if not (0 <= h <= 23 and 0 <= mi <= 59 and 0 <= s <= 59):
        return None
    gy, gm, gd = (y, mo, d) if calendar == "g" else _gregorian_from_jdn(_jdn(y, mo, d, "j"))
    canonical = f"{y:04d}-{mo:02d}-{d:02d} {h:02d}:{mi:02d}:{s:02d}{ms_suffix(fraction_to_ms(m.group(7)))}"
    return canonical, gy * 10000 + gm * 100 + gd, h * 3600 + mi * 60 + s


def clean_calendar(value):
    text = _norm(value or "g").lower()
    aliases = {"g": "g", "greg": "g", "gregorian": "g", "格里历": "g", "公历": "g", "阳历": "g",
               "j": "j", "jul": "j", "julian": "j", "儒略历": "j"}
    if text not in aliases:
        raise ValueError(f"历法只能是 g（格里历）或 j（儒略历），收到：{value!r}")
    return aliases[text]


_TZ_RE = re.compile(r"^(?:UTC|GMT)?\s*([+-])?(\d{1,2})(?::(\d{2})|\.(\d+))?$", re.IGNORECASE)


def clean_timezone(value):
    """时区：+08:00 / -5:30 / +5.5 / UTC+8 → 规范成 ±HH:MM；超出 ±14 小时报错。"""
    text = _norm(value).replace(" ", "")
    m = _TZ_RE.match(text)
    if not m:
        raise ValueError(f"时区写法不对：{value!r}，请写成 +08:00、-05:30 这样的形式。")
    sign = -1 if m.group(1) == "-" else 1
    hours = int(m.group(2))
    if m.group(3) is not None:
        minutes = int(m.group(3))
    elif m.group(4) is not None:
        minutes = round(float("0." + m.group(4)) * 60)
    else:
        minutes = 0
    if minutes >= 60 or hours * 60 + minutes > 14 * 60:
        raise ValueError(f"时区超出范围：{value!r}")
    return f"{'+' if sign > 0 else '-'}{hours:02d}:{minutes:02d}"


_DATE_RE = re.compile(r"^\s*(\d{1,4})(?:\s*[-/.年]\s*(\d{1,2}))?(?:\s*[-/.月]\s*(\d{1,2}))?\s*日?\s*$")


def parse_date_value(text):
    """日期字段：2020-05-12 / 2020-05 / 2020 / 2020/5/12 / 2020年5月 → (规范文本, YYYYMMDD 数值)。"""
    m = _DATE_RE.match(_norm(text))
    if not m:
        return None
    y = int(m.group(1))
    mo = int(m.group(2)) if m.group(2) else None
    d = int(m.group(3)) if m.group(3) else None
    if not 1 <= y <= 9999:
        return None
    if mo is not None and not 1 <= mo <= 12:
        return None
    if d is not None and not 1 <= d <= days_in_month(y, mo, "g"):
        return None
    canonical = f"{y:04d}" + (f"-{mo:02d}" if mo else "") + (f"-{d:02d}" if d else "")
    return canonical, float(y * 10000 + (mo or 0) * 100 + (d or 0))


def derive_num(kind, text):
    """按字段类型把原文解析成数值；不能解析时返回 None。"""
    if kind == "number":
        return parse_number(text)
    if kind == "date":
        parsed = parse_date_value(text)
        return parsed[1] if parsed else None
    return None


_PERIOD_RE = re.compile(r"^\s*(\d{1,4})(?:\s*[-/.]\s*(\d{1,2}))?(?:\s*[-/.]\s*(\d{1,2}))?\s*$")


def period_bound(text, *, end):
    """日期范围筛选的边界：'1980' / '1980-05' / '1980-05-12' → YYYYMMDD 整数。

    作为起点取这段时间的最前面（缺月 / 日记 00，这样只写了年份的日期字段也会被包含），
    作为终点取最后一天，所以 1980～1989 就是“1980 年初到 1989 年底”。
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
    return year * 10000 + (month or 0) * 100 + (day or 0)


def split_list(text):
    """“A、B; C” → ['A', 'B', 'C']（去空、去重，不分大小写）。"""
    items = [text] if isinstance(text, str) else list(text or [])
    result, seen = [], set()
    for item in items:
        for piece in _LIST_SPLIT_RE.split(str(item)):
            name = " ".join(piece.split())
            if name and name.casefold() not in seen:
                seen.add(name.casefold())
                result.append(name)
    return result


_CJK_RUN_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\U00020000-\U0002fa1f]+")


def cjk_bigrams(text):
    """给“两字词索引”用：把连续的汉字拆成相邻两字一组（“迁居海外” → “迁居 居海 海外”），
    单个汉字原样保留，其它文字不变。FTS5 的 unicode61 分词器再按空格和标点切开。"""
    if not text:
        return ""

    def split(match):
        run = match.group(0)
        if len(run) == 1:
            return f" {run} "
        return " " + " ".join(run[i:i + 2] for i in range(len(run) - 1)) + " "

    return _CJK_RUN_RE.sub(split, str(text))


def _is_cjk_pair(term):
    return len(term) == 2 and bool(_CJK_RUN_RE.fullmatch(term))


def _search_terms(q):
    """全文检索的关键词：空格分开的每个词都必须出现（AND）。"""
    return [t for t in _norm(q).split() if t][:8]


def _excerpt(text, term, width=36):
    """在 text 里找到 term，截取它前后一段作为摘要。"""
    pos = text.casefold().find(term.casefold())
    if pos < 0:
        return None
    start = max(0, pos - width // 2)
    end = min(len(text), pos + len(term) + width)
    snippet = " ".join(text[start:end].split())
    return ("…" if start > 0 else "") + snippet + ("…" if end < len(text) else "")


# ======================================================================= 数据库

class ProfileDB:
    """人物档案库（一个 SQLite 文件；加密时是 SQLCipher 文件，接口完全相同）。

    表结构（schema v6）：
      people           必备字段：名称、出生时间、历法、时区、纬度、经度、创建/更新时间；
                       birth_ymd / birth_tod 是由出生时间派生出的整数（换算到格里历），
                       用来做按日期范围筛选和按出生先后排序。
                       last_opened_at 是最近一次被选为本命盘的时间（没打开过为 NULL），用于「最近打开」排序。
      profile_fields   自定义字段的定义：字段名、类型 kind、单选/多选的选项 options（JSON 数组）、
                       上级字段 parent_id（顶层为 NULL）、同级之间的顺序 position。
                       字段树只是几十到几百行的元数据，嵌套多少层都不影响档案数据的读写速度。
      profile_values   每个人在每个字段上的取值（不管字段在第几层，都是一行）：
                         value      原文（单选 / 多选是用“、”连接的选项文本）
                         num_value  数字 / 日期解析出的数值，其它类型为 NULL
      profile_choices  单选 / 多选字段选中的选项（一人一字段可以多行），按 (字段, 选项) 建索引
      tags             分类标签（名称唯一，不分大小写）
      people_tags      人物 ↔ 标签（多对多）
      profile_fts      全文检索索引（SQLite FTS5，trigram 分词，支持中文任意 3 字以上的片段）：
                       每人一行，内容 = 名字 + 标签 + 全部字段原文。
                       SQLite 不支持 trigram 时自动退回逐条模糊匹配，功能不变、只是慢一些。

    索引原则：
      建索引：人名、出生日期、修改时间、最近打开时间、纬度/经度、(字段, 数值)、(字段, 选项)、(标签, 人物)、全文索引。
      profile_values.value 本身不建普通索引，长文只进全文索引。

    连接：每个库保留一个小连接池（最多 POOL_SIZE 个空闲连接，多线程共用）。
    加密库每打开一个新连接都要做一次密钥推导（约 0.1–0.2 秒），连接池让这笔开销只发生几次；
    未加密库也因此能复用各连接的页缓存。close() 关闭全部连接（改名、锁定、加解密之前调用）。
    """

    def __init__(self, path, key=None):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.key = key
        self.fts = False
        self._pool = []
        self._pool_lock = threading.Lock()
        self._closed = False
        self._init_db()

    # ------------------------------------------------------------------ 连接

    def _connect(self):
        conn = sqlite3.connect(
            str(self.path),
            timeout=10.0,
            isolation_level=None,      # 自动提交模式；需要事务时手动 BEGIN/COMMIT
            check_same_thread=False,   # 连接池里的连接会被不同的请求线程轮流使用（同一时刻只有一个线程在用）
        )
        try:
            if self.key is not None:
                apply_key(conn, self.key)
            conn.row_factory = sqlite3.Row
            conn.create_function("qa_bigrams", 1, cjk_bigrams, deterministic=True)
            conn.execute("PRAGMA foreign_keys = ON")
            # WAL：读不阻塞写、写不阻塞读（Flask 是多线程的），提交时磁盘同步次数也更少。
            # 运行期间旁边会多出 -wal / -shm 两个文件，属正常现象，程序关闭时自动合并回主文件。
            conn.execute("PRAGMA journal_mode = WAL")
            conn.execute("PRAGMA synchronous = NORMAL")
            conn.execute("PRAGMA temp_store = MEMORY")
            conn.execute("PRAGMA cache_size = -32768")  # 每个连接最多 32 MB 页缓存
        except BaseException:
            conn.close()
            raise
        return conn

    def _acquire(self):
        with self._pool_lock:
            if self._pool:
                return self._pool.pop()
        return self._connect()

    def _release(self, conn):
        try:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
        except sqlite3.Error:
            conn.close()
            return
        with self._pool_lock:
            if not self._closed and len(self._pool) < POOL_SIZE:
                self._pool.append(conn)
                return
        conn.close()

    def close(self):
        """关闭全部空闲连接；之后正在使用的连接用完也会直接关闭。"""
        with self._pool_lock:
            self._closed = True
            pool, self._pool = self._pool, []
        for conn in pool:
            conn.close()

    @contextmanager
    def _read(self):
        conn = self._acquire()
        try:
            yield conn
        finally:
            self._release(conn)

    @contextmanager
    def _tx(self):
        """写事务：成功则提交，任何异常则整体回滚。"""
        conn = self._acquire()
        try:
            conn.execute("BEGIN IMMEDIATE")
            try:
                yield conn
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            else:
                conn.execute("COMMIT")
        finally:
            self._release(conn)

    # ------------------------------------------------------------ 建表

    _INDEXES = (
        "CREATE INDEX IF NOT EXISTS idx_people_display_name "
        "ON people(display_name COLLATE NOCASE)",
        "CREATE INDEX IF NOT EXISTS idx_people_birth "
        "ON people(birth_ymd, birth_tod)",
        "CREATE INDEX IF NOT EXISTS idx_people_updated "
        "ON people(updated_at)",
        "CREATE INDEX IF NOT EXISTS idx_people_opened "
        "ON people(last_opened_at)",
        "CREATE INDEX IF NOT EXISTS idx_people_latitude "
        "ON people(latitude)",
        "CREATE INDEX IF NOT EXISTS idx_people_longitude "
        "ON people(longitude)",
        # 同一个上级下面字段名不能重复（不同上级下可以都有“详情”）。
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_fields_sibling_label "
        "ON profile_fields(COALESCE(parent_id, 0), label COLLATE NOCASE)",
        "CREATE INDEX IF NOT EXISTS idx_profile_fields_parent "
        "ON profile_fields(parent_id)",
        # 同时服务：按字段数值排序/筛选、“未填写”筛选、统计某字段被多少人填过、删除字段时的级联清理。
        # 末尾带上 profile_id，让这些查询只读索引（覆盖索引），不必回表去读整行（行里可能有上万字的长文）：
        # 20 万份档案时，按数值筛选从约 0.3 秒（加密库约 1.2 秒）降到几毫秒。
        "CREATE INDEX IF NOT EXISTS idx_pv_field_num_profile "
        "ON profile_values(field_id, num_value, profile_id)",
        "CREATE INDEX IF NOT EXISTS idx_pc_field_option "
        "ON profile_choices(field_id, option COLLATE NOCASE, profile_id)",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name "
        "ON tags(name COLLATE NOCASE)",
        "CREATE INDEX IF NOT EXISTS idx_people_tags_tag "
        "ON people_tags(tag_id, profile_id)",
    )

    _TABLES = (
        """
        CREATE TABLE IF NOT EXISTS people (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            display_name TEXT NOT NULL,
            birth_time TEXT NOT NULL,
            timezone_offset TEXT NOT NULL,
            latitude REAL NOT NULL,
            longitude REAL NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            birth_ymd INTEGER,
            birth_tod INTEGER,
            calendar TEXT NOT NULL DEFAULT 'g',
            last_opened_at TEXT
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS profile_fields (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            label TEXT NOT NULL,
            created_at TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'text',
            options TEXT NOT NULL DEFAULT '[]',
            position INTEGER,
            parent_id INTEGER REFERENCES profile_fields(id) ON DELETE CASCADE
        )
        """,
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
        """,
        """
        CREATE TABLE IF NOT EXISTS profile_choices (
            profile_id INTEGER NOT NULL
                REFERENCES people(id) ON DELETE CASCADE,
            field_id INTEGER NOT NULL
                REFERENCES profile_fields(id) ON DELETE CASCADE,
            option TEXT NOT NULL,
            PRIMARY KEY (profile_id, field_id, option)
        ) WITHOUT ROWID
        """,
        """
        CREATE TABLE IF NOT EXISTS tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS people_tags (
            profile_id INTEGER NOT NULL
                REFERENCES people(id) ON DELETE CASCADE,
            tag_id INTEGER NOT NULL
                REFERENCES tags(id) ON DELETE CASCADE,
            PRIMARY KEY (profile_id, tag_id)
        ) WITHOUT ROWID
        """,
    )

    def _init_db(self):
        with self._tx() as conn:
            version = int(conn.execute("PRAGMA user_version").fetchone()[0])
            for ddl in self._TABLES:
                conn.execute(ddl)
            # 开发期的旧库（schema v5）只差字段的上级一列和新的唯一索引；数据不做其它迁移。
            columns = {row["name"] for row in conn.execute("PRAGMA table_info(profile_fields)")}
            if "parent_id" not in columns:
                conn.execute("ALTER TABLE profile_fields ADD COLUMN parent_id INTEGER "
                             "REFERENCES profile_fields(id) ON DELETE CASCADE")
            # 「最近打开」排序用的一列（选中某人作为本命盘时记下时间）。旧库加上这一列即可，
            # 已有档案的值是 NULL（还没打开过），排在最后；不需要重建全文索引。
            people_columns = {row["name"] for row in conn.execute("PRAGMA table_info(people)")}
            if "last_opened_at" not in people_columns:
                conn.execute("ALTER TABLE people ADD COLUMN last_opened_at TEXT")
            conn.execute("DROP INDEX IF EXISTS idx_profile_fields_label")
            conn.execute("DROP INDEX IF EXISTS idx_pv_field_num")
            conn.execute("UPDATE profile_fields SET position = id WHERE position IS NULL")
            for ddl in self._INDEXES:
                conn.execute(ddl)

            # 全文索引：需要 SQLite 3.34+ 的 trigram 分词；不支持时退回逐条模糊匹配。
            try:
                conn.execute(
                    "CREATE VIRTUAL TABLE IF NOT EXISTS profile_fts "
                    "USING fts5(content, tokenize = 'trigram')"
                )
                # 两字词索引：trigram 至少要 3 个字才能用上索引，而中文最常见的是两字词（离异、晚婚……）。
                # 这里存的是 cjk_bigrams() 拆好的文本，只用来查两个汉字的词，不存原文（content=''）。
                try:
                    conn.execute(
                        "CREATE VIRTUAL TABLE IF NOT EXISTS profile_bigram "
                        "USING fts5(content, content = '', contentless_delete = 1, tokenize = 'unicode61')"
                    )
                except sqlite3.OperationalError:      # SQLite 3.43 以前不支持 contentless_delete：改存原文
                    conn.execute(
                        "CREATE VIRTUAL TABLE IF NOT EXISTS profile_bigram "
                        "USING fts5(content, tokenize = 'unicode61')"
                    )
                self.fts = True
            except sqlite3.OperationalError:
                self.fts = False
            if self.fts and (version < SCHEMA_VERSION or self._fts_out_of_sync(conn)):
                self._rebuild_fts(conn)

            conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

        if version < SCHEMA_VERSION:
            # 刚建好的库：采集一次统计信息，让查询计划从第一天起就是对的。
            with self._read() as conn:
                conn.execute("ANALYZE")

    def optimize(self):
        """大批量导入之后调用：更新查询统计信息。"""
        with self._read() as conn:
            conn.execute("PRAGMA optimize")

    # ------------------------------------------------------------ 全文索引
    #
    # 一个人的全文内容 = 名字 + 标签 + 全部字段原文（按字段 id 顺序）。
    # 用一条 INSERT … SELECT 成批生成：保存一份档案时只处理这一人，
    # 删字段、改标签影响到几万人时也只是几条集合运算，不会逐人往返查询。

    _FTS_CONTENT_SQL = """
        SELECT p.id,
               p.display_name
               || COALESCE(char(10) || (SELECT group_concat(name, char(10)) FROM (
                      SELECT t.name AS name FROM people_tags pt JOIN tags t ON t.id = pt.tag_id
                      WHERE pt.profile_id = p.id ORDER BY t.name)), '')
               || COALESCE(char(10) || (SELECT group_concat(value, char(10)) FROM (
                      SELECT v.value AS value FROM profile_values v
                      WHERE v.profile_id = p.id ORDER BY v.field_id)), '')
        FROM people AS p
    """

    @staticmethod
    def _fts_out_of_sync(conn):
        """用外部工具直接改过数据库后，全文索引可能和 people 表对不上：人数不同就整体重建。"""
        people = conn.execute("SELECT COUNT(*) FROM people").fetchone()[0]
        indexed = conn.execute("SELECT COUNT(*) FROM profile_fts").fetchone()[0]
        bigram = conn.execute("SELECT COUNT(*) FROM profile_bigram").fetchone()[0]
        return not people == indexed == bigram

    def _refresh_fts(self, conn, profile_ids):
        if not self.fts:
            return
        ids = sorted({int(p) for p in profile_ids})
        for start in range(0, len(ids), 500):
            chunk = ids[start:start + 500]
            marks = ",".join("?" * len(chunk))
            conn.execute(f"DELETE FROM profile_fts WHERE rowid IN ({marks})", chunk)
            conn.execute(f"DELETE FROM profile_bigram WHERE rowid IN ({marks})", chunk)
            conn.execute(
                f"INSERT INTO profile_fts (rowid, content) {self._FTS_CONTENT_SQL} WHERE p.id IN ({marks})", chunk
            )
            conn.execute(
                f"INSERT INTO profile_bigram (rowid, content) "
                f"SELECT rowid, qa_bigrams(content) FROM profile_fts WHERE rowid IN ({marks})", chunk
            )

    def _rebuild_fts(self, conn):
        conn.execute("DELETE FROM profile_fts")
        conn.execute("DELETE FROM profile_bigram")
        conn.execute(f"INSERT INTO profile_fts (rowid, content) {self._FTS_CONTENT_SQL}")
        conn.execute("INSERT INTO profile_bigram (rowid, content) SELECT rowid, qa_bigrams(content) FROM profile_fts")

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
        display_name = " ".join(str(data.get("display_name", "")).split())
        if not display_name:
            raise ValueError("人物名称不能为空。")

        calendar = clean_calendar(data.get("calendar", "g"))

        birth_text = str(data.get("birth_time", "")).strip()
        if not birth_text:
            raise ValueError("出生时间不能为空。")
        parsed = parse_birth_time(birth_text, calendar)
        if parsed is None:
            raise ValueError(
                f"出生时间「{birth_text}」不合法（{CALENDARS[calendar]}）：请写成 YYYY-MM-DD HH:MM[:SS[.sss]]，"
                "并确认这一天在该历法里存在。"
            )

        if not str(data.get("timezone_offset", "")).strip():
            raise ValueError("时区不能为空。")
        timezone_offset = clean_timezone(data.get("timezone_offset"))

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
            "birth_time": parsed[0],
            "birth_ymd": parsed[1],
            "birth_tod": parsed[2],
            "calendar": calendar,
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
        if label in CORE_FIELD_LABELS or label.casefold() == "id":
            raise ValueError(f"「{label}」是必备字段或保留名称，不能当作自定义字段名。")
        if PATH_SEP in label:
            raise ValueError(f"字段名里不能有「{PATH_SEP}」（它用来分隔上下级字段）。")
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
    def _clean_option(name):
        name = " ".join(_norm(name).split())
        if not name:
            raise ValueError("选项不能为空。")
        if len(name) > MAX_OPTION_LEN:
            raise ValueError(f"选项不能超过 {MAX_OPTION_LEN} 个字符：{name[:12]}…")
        if _OPTION_FORBIDDEN & set(name):
            raise ValueError(f"选项「{name}」里不能有逗号、顿号、分号或换行（它们用来分隔多个选项）。")
        return name

    def _clean_options(self, raw):
        result, seen = [], set()
        for item in raw or []:
            name = self._clean_option(item)
            if name.casefold() not in seen:
                seen.add(name.casefold())
                result.append(name)
        if len(result) > MAX_OPTIONS:
            raise ValueError(f"一个字段最多 {MAX_OPTIONS} 个选项。")
        return result

    # --------------------------------------------------------- 字段取值的整理与写入

    def _field_defs(self, conn):
        """{字段id: {label, kind, options}}，不含分组（分组自己不存值）。"""
        return {
            int(r["id"]): {"label": r["label"], "kind": r["kind"], "options": json.loads(r["options"] or "[]")}
            for r in conn.execute("SELECT id, label, kind, options FROM profile_fields WHERE kind <> 'group'")
        }

    def _clean_one_value(self, conn, field_id, field, value, *, add_options=False, added=None):
        """一个字段的取值 → (原文, 数值或None, 选项列表或None)。

        add_options=True（CSV 导入用）：单选 / 多选里出现了没定义过的选项时自动加进字段的选项里，
        并记在 added 里；否则直接报错。
        """
        label, kind = field["label"], field["kind"]
        if kind in CHOICE_KINDS:
            picked = split_list(value if value is not None else "")
            known = {o.casefold(): o for o in field["options"]}
            chosen = []
            for name in picked:
                name = self._clean_option(name)
                if name.casefold() in known:
                    chosen.append(known[name.casefold()])
                elif add_options:
                    field["options"].append(name)
                    known[name.casefold()] = name
                    conn.execute(
                        "UPDATE profile_fields SET options = ? WHERE id = ?",
                        (json.dumps(field["options"], ensure_ascii=False), field_id),
                    )
                    if added is not None:
                        added.setdefault(label, []).append(name)
                    chosen.append(name)
                else:
                    raise ValueError(f"字段「{label}」没有「{name}」这个选项。")
            if kind == "choice" and len(chosen) > 1:
                raise ValueError(f"字段「{label}」是单选，只能选一个（收到：{'、'.join(chosen)}）。")
            return "、".join(chosen), None, chosen

        text = "" if value is None else str(value)
        if len(text) > MAX_VALUE_LEN:
            raise ValueError(f"单个字段的内容不能超过 {MAX_VALUE_LEN} 个字符。")
        if kind == "number":
            text = text.strip()
            number = parse_number(text) if text else None
            if text and number is None:
                raise ValueError(f"字段「{label}」是数字类型，无法识别「{text}」（请填 12、-3.5、1,024 这样的数字）。")
            return text, number, None
        if kind == "date":
            text = text.strip()
            if not text:
                return "", None, None
            parsed = parse_date_value(text)
            if parsed is None:
                raise ValueError(f"字段「{label}」是日期类型，无法识别「{text}」（请写 2020-05-12、2020-05 或 2020）。")
            return parsed[0], parsed[1], None
        # 文本：换行统一成 \n，去掉每行行尾和整段首尾的空白。
        text = "\n".join(line.rstrip() for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")).strip("\n")
        return text, None, None

    def _clean_field_values(self, conn, raw, **kwargs):
        """前端传来的 {字段id: 值} → {int: (原文, 数值, 选项)}；未知字段 id 忽略。"""
        if not raw:
            return {}
        defs = self._field_defs(conn)
        clean = {}
        for key, value in dict(raw).items():
            try:
                field_id = int(key)
            except (TypeError, ValueError):
                continue
            if field_id in defs:
                clean[field_id] = self._clean_one_value(conn, field_id, defs[field_id], value, **kwargs)
        return clean

    @staticmethod
    def _write_field_values(conn, profile_id, values):
        for field_id, (text, number, chosen) in values.items():
            conn.execute(
                "DELETE FROM profile_choices WHERE profile_id = ? AND field_id = ?",
                (profile_id, field_id),
            )
            if text.strip() == "":
                conn.execute(
                    "DELETE FROM profile_values WHERE profile_id = ? AND field_id = ?",
                    (profile_id, field_id),
                )
                continue
            conn.execute(
                """
                INSERT INTO profile_values (profile_id, field_id, value, num_value)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(profile_id, field_id) DO UPDATE
                    SET value = excluded.value, num_value = excluded.num_value
                """,
                (profile_id, field_id, text, number),
            )
            for option in chosen or []:
                conn.execute(
                    "INSERT OR IGNORE INTO profile_choices (profile_id, field_id, option) VALUES (?, ?, ?)",
                    (profile_id, field_id, option),
                )

    # ------------------------------------------------------------ 自定义字段（树）
    #
    # 字段可以嵌套：parent_id 指向上级字段，最多 MAX_FIELD_DEPTH 层。
    # 返回给前端的字段列表按“深度优先”排好：上级在前，紧跟着它的全部下级（同级之间按 position）。
    # 每个字段带 parent_id、depth（0 = 顶层）、path（从顶层到自己的字段名列表）。

    @staticmethod
    def _field_dict(row, path, depth):
        kind = row["kind"] if row["kind"] in FIELD_KINDS else "text"
        return {
            "id": int(row["id"]),
            "label": row["label"],
            "kind": kind,
            "kind_label": FIELD_KINDS[kind],
            "options": json.loads(row["options"] or "[]") if kind in CHOICE_KINDS else [],
            "sortable": kind in NUMERIC_KINDS,
            "filterable": kind in NUMERIC_KINDS or kind in CHOICE_KINDS,
            "parent_id": None if row["parent_id"] is None else int(row["parent_id"]),
            "depth": depth,
            "path": path,
        }

    def _field_tree(self, conn):
        """全部字段，深度优先排好的列表。"""
        rows = conn.execute(
            "SELECT id, label, kind, options, parent_id FROM profile_fields ORDER BY position, id"
        ).fetchall()
        children = {}
        ids = {int(r["id"]) for r in rows}
        for r in rows:
            parent = r["parent_id"]
            parent = int(parent) if parent is not None and int(parent) in ids else None
            children.setdefault(parent, []).append(r)
        result = []

        def walk(parent, path, depth):
            for r in children.get(parent, []):
                here = path + [r["label"]]
                result.append(self._field_dict(r, here, depth))
                walk(int(r["id"]), here, depth + 1)

        walk(None, [], 0)
        return result

    def list_fields(self):
        with self._read() as conn:
            return self._field_tree(conn)

    def _get_field(self, field_id):
        return next((f for f in self.list_fields() if f["id"] == int(field_id)), None)

    @staticmethod
    def _subtree_ids(conn, field_id):
        """字段自己 + 全部下级的 id。"""
        return [int(r[0]) for r in conn.execute(
            """
            WITH RECURSIVE sub(id) AS (
                SELECT ? UNION ALL
                SELECT f.id FROM profile_fields f JOIN sub ON f.parent_id = sub.id
            )
            SELECT id FROM sub
            """,
            (int(field_id),),
        )]

    @staticmethod
    def _depth_of(conn, field_id):
        """字段所在的层（顶层 = 0）；field_id 为 None 时返回 -1。"""
        if field_id is None:
            return -1
        row = conn.execute(
            """
            WITH RECURSIVE up(id, parent_id, depth) AS (
                SELECT id, parent_id, 0 FROM profile_fields WHERE id = ?
                UNION ALL
                SELECT f.id, f.parent_id, up.depth + 1 FROM profile_fields f JOIN up ON f.id = up.parent_id
            )
            SELECT MAX(depth) FROM up
            """,
            (int(field_id),),
        ).fetchone()
        if row is None or row[0] is None:
            raise ValueError(f"上级字段不存在：{field_id}")
        return int(row[0])

    def _subtree_height(self, conn, field_id):
        """字段往下还有几层（没有下级 = 0）。"""
        row = conn.execute(
            """
            WITH RECURSIVE sub(id, depth) AS (
                SELECT ?, 0 UNION ALL
                SELECT f.id, sub.depth + 1 FROM profile_fields f JOIN sub ON f.parent_id = sub.id
            )
            SELECT MAX(depth) FROM sub
            """,
            (int(field_id),),
        ).fetchone()
        return int(row[0] or 0)

    @staticmethod
    def _clean_parent(value):
        if value in (None, "", 0, "0"):
            return None
        try:
            return int(value)
        except (TypeError, ValueError):
            raise ValueError(f"上级字段 id 不对：{value!r}")

    def field_usage(self, field_id):
        """删除 / 改类型前提示用：这个字段（含全部下级）有多少份档案填了内容、字段自己有多少份、有几个下级字段。"""
        with self._read() as conn:
            ids = self._subtree_ids(conn, field_id)
            marks = ",".join("?" * len(ids))
            used = conn.execute(
                f"SELECT COUNT(DISTINCT profile_id) FROM profile_values WHERE field_id IN ({marks})", ids
            ).fetchone()[0]
            own = conn.execute(
                "SELECT COUNT(*) FROM profile_values WHERE field_id = ?", (int(field_id),)
            ).fetchone()[0]
        return {"profiles": int(used), "own_profiles": int(own), "descendants": len(ids) - 1}

    def option_usage(self, field_id):
        """单选 / 多选字段每个选项被多少人选了：{选项: 人数}（删除选项前用来提示）。"""
        with self._read() as conn:
            return {
                r["option"]: int(r["n"])
                for r in conn.execute(
                    "SELECT option, COUNT(*) AS n FROM profile_choices WHERE field_id = ? GROUP BY option",
                    (int(field_id),),
                )
            }

    def _insert_field(self, conn, label, kind, options=(), parent_id=None):
        if parent_id is not None and self._depth_of(conn, parent_id) + 1 >= MAX_FIELD_DEPTH:
            raise ValueError(f"字段最多嵌套 {MAX_FIELD_DEPTH} 层。")
        try:
            cursor = conn.execute(
                "INSERT INTO profile_fields (label, created_at, kind, options, position, parent_id) VALUES "
                "(?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM profile_fields), ?)",
                (label, self._now(), kind, json.dumps(list(options), ensure_ascii=False), parent_id),
            )
        except sqlite3.IntegrityError:
            raise ValueError(f"同一级里已经有名为「{label}」的字段了。")
        return int(cursor.lastrowid)

    def reorder_fields(self, field_ids):
        """按给定顺序重排字段（前端按显示顺序传全部 id）：同一上级下的字段按这个先后排列。
        field_ids 里没列到的字段保持原有先后，排在后面。"""
        wanted = []
        for value in field_ids or []:
            fid = int(value)
            if fid not in wanted:
                wanted.append(fid)
        with self._tx() as conn:
            existing = [int(r["id"]) for r in conn.execute(
                "SELECT id FROM profile_fields ORDER BY position, id")]
            order = [fid for fid in wanted if fid in existing]
            order += [fid for fid in existing if fid not in order]
            conn.executemany(
                "UPDATE profile_fields SET position = ? WHERE id = ?",
                [(index + 1, fid) for index, fid in enumerate(order)],
            )
        return self.list_fields()

    def create_field(self, label, kind="text", options=None, parent_id=None):
        label = self._clean_label(label)
        kind = self._clean_kind(kind or "text")
        options = self._clean_options(options) if kind in CHOICE_KINDS else []
        parent_id = self._clean_parent(parent_id)
        with self._tx() as conn:
            if parent_id is not None and conn.execute(
                    "SELECT 1 FROM profile_fields WHERE id = ?", (parent_id,)).fetchone() is None:
                raise ValueError("上级字段不存在。")
            field_id = self._insert_field(conn, label, kind, options, parent_id)
        return self._get_field(field_id)

    def update_field(self, field_id, data):
        """改字段名 / 类型 / 选项 / 上级。

        data 可含：
          label      新名字
          kind       新类型（转换规则见 _convert_kind）
          options    单选 / 多选的完整新选项列表（按这个顺序显示）
          renames    {旧选项: 新选项}：改名的选项，已选它的人跟着改；
                     其余从列表里消失的选项视为删除，已选它的人这一项被清掉。
          parent_id  移到另一个上级下面（null = 移到顶层），连同它的全部下级一起移动，排在新位置的最后。
        """
        field_id = int(field_id)
        current = self._get_field(field_id)
        if current is None:
            return None

        label = self._clean_label(data["label"]) if "label" in data else current["label"]
        kind = self._clean_kind(data["kind"]) if data.get("kind") else current["kind"]

        notes = {}
        try:
            with self._tx() as conn:
                conn.execute("UPDATE profile_fields SET label = ? WHERE id = ?", (label, field_id))
                if "parent_id" in data:
                    self._move_field(conn, field_id, self._clean_parent(data.get("parent_id")), current)
                affected = set()
                if kind != current["kind"]:
                    affected |= {int(r[0]) for r in conn.execute(
                        "SELECT profile_id FROM profile_values WHERE field_id = ?", (field_id,))}
                    notes = self._convert_kind(conn, field_id, current["kind"], kind)
                if "options" in data and kind in CHOICE_KINDS:
                    affected |= self._apply_options(conn, field_id, data.get("options"), data.get("renames") or {})
                self._refresh_fts(conn, affected)
        except sqlite3.IntegrityError:
            raise ValueError(f"同一级里已经有名为「{label}」的字段了。")

        result = self._get_field(field_id)
        result.update(notes)
        return result

    def _move_field(self, conn, field_id, parent_id, current):
        if parent_id == current["parent_id"]:
            return
        if parent_id is not None:
            if parent_id in self._subtree_ids(conn, field_id):
                raise ValueError("不能把字段移到它自己或它的下级里面。")
            if self._depth_of(conn, parent_id) + 1 + self._subtree_height(conn, field_id) >= MAX_FIELD_DEPTH:
                raise ValueError(f"移过去之后会超过 {MAX_FIELD_DEPTH} 层。")
        conn.execute(
            "UPDATE profile_fields SET parent_id = ?, "
            "position = (SELECT COALESCE(MAX(position), 0) + 1 FROM profile_fields) WHERE id = ?",
            (parent_id, field_id),
        )

    def _apply_options(self, conn, field_id, options, renames):
        """写入新选项列表，处理改名和删除；返回受影响的档案 id。"""
        new_options = self._clean_options(options)
        known = {o.casefold() for o in new_options}
        renames = {
            self._clean_option(old): self._clean_option(new)
            for old, new in dict(renames).items()
            if str(old).strip() and str(new).strip()
        }
        for new in renames.values():
            if new.casefold() not in known:
                raise ValueError(f"改名后的选项「{new}」不在新的选项列表里。")
        conn.execute(
            "UPDATE profile_fields SET options = ? WHERE id = ?",
            (json.dumps(new_options, ensure_ascii=False), field_id),
        )

        affected = set()
        rows = conn.execute(
            "SELECT profile_id, option FROM profile_choices WHERE field_id = ?", (field_id,)
        ).fetchall()
        canonical = {o.casefold(): o for o in new_options}
        rename_map = {old.casefold(): new for old, new in renames.items()}
        per_profile = {}
        for r in rows:
            pid, option = int(r["profile_id"]), r["option"]
            if option.casefold() in rename_map:
                target = canonical[rename_map[option.casefold()].casefold()]
            elif option.casefold() in canonical:
                target = canonical[option.casefold()]
            else:
                target = None                      # 选项被删除
            per_profile.setdefault(pid, [])
            if target is not None and target not in per_profile[pid]:
                per_profile[pid].append(target)
            if target != option:
                affected.add(pid)

        order = {o: i for i, o in enumerate(new_options)}
        for pid in affected:
            chosen = sorted(per_profile.get(pid, []), key=lambda o: order.get(o, 0))
            conn.execute("DELETE FROM profile_choices WHERE profile_id = ? AND field_id = ?", (pid, field_id))
            if chosen:
                for option in chosen:
                    conn.execute(
                        "INSERT INTO profile_choices (profile_id, field_id, option) VALUES (?, ?, ?)",
                        (pid, field_id, option),
                    )
                conn.execute(
                    "UPDATE profile_values SET value = ? WHERE profile_id = ? AND field_id = ?",
                    ("、".join(chosen), pid, field_id),
                )
            else:
                conn.execute("DELETE FROM profile_values WHERE profile_id = ? AND field_id = ?", (pid, field_id))
        return affected

    def _convert_kind(self, conn, field_id, old, new):
        """字段换类型。原文尽量一个字不丢：

        文本 / 数字 / 日期 之间互换：原文保留，按新类型重新解析数值；解析不了的条数报告出来
            （原文仍在，只是不参与排序和范围筛选，下次保存这些档案时需要改成合法写法或清空）。
        → 单选 / 多选：把现有的不同取值（多选按“、，；”拆开）自动变成选项。
            转成单选时，如果有人的取值拆开后不止一个，拒绝转换。
        单选 / 多选 → 其它类型：保留“、”连接的原文，去掉选项结构。
        """
        rows = conn.execute(
            "SELECT profile_id, value FROM profile_values WHERE field_id = ?", (field_id,)
        ).fetchall()
        notes = {}

        if new == "group":
            # 改成分组：分组自己不存值，这个字段已填的内容全部清掉（下级字段不受影响）。
            conn.execute("UPDATE profile_fields SET kind = 'group', options = '[]' WHERE id = ?", (field_id,))
            conn.execute("DELETE FROM profile_choices WHERE field_id = ?", (field_id,))
            conn.execute("DELETE FROM profile_values WHERE field_id = ?", (field_id,))
            if rows:
                notes["cleared_count"] = len(rows)
            return notes

        if new in CHOICE_KINDS:
            per_profile, options, seen = {}, [], set()
            for r in rows:
                picked = [self._clean_option(p) for p in split_list(r["value"])]
                if new == "choice" and len(picked) > 1:
                    raise ValueError(
                        f"有档案在这个字段里写了多个值（如「{r['value'][:20]}」），不能转成单选；可以先转成多选。"
                    )
                per_profile[int(r["profile_id"])] = picked
                for p in picked:
                    if p.casefold() not in seen:
                        seen.add(p.casefold())
                        options.append(p)
            if len(options) > MAX_OPTIONS:
                raise ValueError(f"这个字段现有 {len(options)} 种不同的取值，超过选项上限 {MAX_OPTIONS}，不适合转成选项字段。")
            if old in CHOICE_KINDS:
                for o in json.loads(conn.execute("SELECT options FROM profile_fields WHERE id = ?", (field_id,)).fetchone()[0] or "[]"):
                    if o.casefold() not in seen:
                        seen.add(o.casefold())
                        options.append(o)
            canonical = {o.casefold(): o for o in options}
            conn.execute(
                "UPDATE profile_fields SET kind = ?, options = ? WHERE id = ?",
                (new, json.dumps(options, ensure_ascii=False), field_id),
            )
            conn.execute("DELETE FROM profile_choices WHERE field_id = ?", (field_id,))
            for pid, picked in per_profile.items():
                chosen = [canonical[p.casefold()] for p in picked]
                for option in chosen:
                    conn.execute(
                        "INSERT OR IGNORE INTO profile_choices (profile_id, field_id, option) VALUES (?, ?, ?)",
                        (pid, field_id, option),
                    )
                conn.execute(
                    "UPDATE profile_values SET value = ?, num_value = NULL WHERE profile_id = ? AND field_id = ?",
                    ("、".join(chosen), pid, field_id),
                )
            notes["created_options"] = options
            return notes

        conn.execute("UPDATE profile_fields SET kind = ?, options = '[]' WHERE id = ?", (new, field_id))
        conn.execute("DELETE FROM profile_choices WHERE field_id = ?", (field_id,))
        updates, bad = [], 0
        for r in rows:
            number = derive_num(new, r["value"])
            if new in NUMERIC_KINDS and number is None:
                bad += 1
            updates.append((number, int(r["profile_id"]), field_id))
        conn.executemany(
            "UPDATE profile_values SET num_value = ? WHERE profile_id = ? AND field_id = ?", updates
        )
        if bad:
            notes["unparsed_count"] = bad
        return notes

    def delete_field(self, field_id):
        """删除字段和它的全部下级，并（通过外键级联）删除所有档案里这些字段的数据。"""
        with self._tx() as conn:
            ids = self._subtree_ids(conn, field_id)
            marks = ",".join("?" * len(ids))
            affected = [int(r[0]) for r in conn.execute(
                f"SELECT DISTINCT profile_id FROM profile_values WHERE field_id IN ({marks})", ids)]
            cursor = conn.execute("DELETE FROM profile_fields WHERE id = ?", (int(field_id),))
            self._refresh_fts(conn, affected)
        return cursor.rowcount > 0

    # ------------------------------------------------------------------ 标签

    @staticmethod
    def _clean_tags(raw):
        """接受列表或字符串（逗号/顿号/分号/换行分隔）；去空、去重（不分大小写）、限长。"""
        result = split_list(raw if raw is not None else [])
        for name in result:
            if len(name) > MAX_TAG_LEN:
                raise ValueError(f"单个标签不能超过 {MAX_TAG_LEN} 个字符：{name[:12]}…")
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
            row = conn.execute("SELECT id FROM tags WHERE name = ? COLLATE NOCASE", (name,)).fetchone()
            if row is None:
                wanted.add(int(conn.execute("INSERT INTO tags (name) VALUES (?)", (name,)).lastrowid))
            else:
                wanted.add(int(row["id"]))
        current = {
            int(r["tag_id"])
            for r in conn.execute("SELECT tag_id FROM people_tags WHERE profile_id = ?", (profile_id,))
        }
        removed = current - wanted
        for tag_id in removed:
            conn.execute("DELETE FROM people_tags WHERE profile_id = ? AND tag_id = ?", (profile_id, tag_id))
        for tag_id in wanted - current:
            conn.execute("INSERT INTO people_tags (profile_id, tag_id) VALUES (?, ?)", (profile_id, tag_id))
        if removed:
            self._prune_tags(conn)

    def list_tags(self, q=None, limit=200):
        limit = self._int_arg(limit, "limit", 200, 1, 5000)
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

    def rename_tag(self, tag_id, new_name):
        """标签改名；如果新名字已经是另一个标签（不分大小写），两者合并。返回 {name, merged}。"""
        names = self._clean_tags([new_name])
        if len(names) != 1:
            raise ValueError("标签名不能为空，也不能包含逗号、顿号、分号。")
        name = names[0]
        tag_id = int(tag_id)
        with self._tx() as conn:
            if conn.execute("SELECT 1 FROM tags WHERE id = ?", (tag_id,)).fetchone() is None:
                return None
            affected = [int(r[0]) for r in conn.execute(
                "SELECT profile_id FROM people_tags WHERE tag_id = ?", (tag_id,))]
            other = conn.execute(
                "SELECT id FROM tags WHERE name = ? COLLATE NOCASE AND id <> ?", (name, tag_id)
            ).fetchone()
            merged = other is not None
            if merged:
                conn.execute(
                    "INSERT OR IGNORE INTO people_tags (profile_id, tag_id) "
                    "SELECT profile_id, ? FROM people_tags WHERE tag_id = ?",
                    (int(other["id"]), tag_id),
                )
                conn.execute("DELETE FROM tags WHERE id = ?", (tag_id,))
                conn.execute("UPDATE tags SET name = ? WHERE id = ?", (name, int(other["id"])))
            else:
                conn.execute("UPDATE tags SET name = ? WHERE id = ?", (name, tag_id))
            self._refresh_fts(conn, affected)
        return {"name": name, "merged": merged}

    def delete_tag(self, tag_id):
        """把这个标签从所有档案里去掉。"""
        with self._tx() as conn:
            affected = [int(r[0]) for r in conn.execute(
                "SELECT profile_id FROM people_tags WHERE tag_id = ?", (int(tag_id),))]
            cursor = conn.execute("DELETE FROM tags WHERE id = ?", (int(tag_id),))
            self._refresh_fts(conn, affected)
        return cursor.rowcount > 0

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

    # ------------------------------------------------------------------ 档案：列表与检索

    # 排序键白名单：用户传来的 sort 只能在这里查表，绝不会被拼进 SQL。
    # 职业占星师几乎不按坐标找人，经纬度排序已经去掉（经纬度的索引仍保留，以后做地点筛选可以用）。
    _CORE_SORTS = {
        "name": ("p.display_name COLLATE NOCASE",),
        "birth": ("p.birth_ymd", "p.birth_tod"),
        "updated": ("p.updated_at",),
        "created": ("p.id",),
    }
    # 可能没有值的排序列：有值的按值排，没有值的始终排在最后（见 _rows_by_nullable）。
    _NULLABLE_SORTS = {
        "opened": "p.last_opened_at",
    }
    # 列表每一行附带的「排序依据的值」：按这些依据排序时，行尾显示它，用户能看出为什么是这个顺序。
    _SORT_VALUE_COLUMNS = {"opened": "last_opened_at", "updated": "updated_at", "created": "created_at"}

    def _field_kind(self, conn, field_id):
        try:
            field_id = int(field_id)
        except (TypeError, ValueError):
            raise ValueError(f"字段 id 不对：{field_id!r}")
        row = conn.execute("SELECT label, kind FROM profile_fields WHERE id = ?", (field_id,)).fetchone()
        if row is None:
            raise ValueError(f"字段不存在：{field_id}")
        return row["label"], row["kind"]

    def _tag_condition(self, conn, tags, mode):
        names = self._clean_tags(tags)
        if not names:
            return None, []
        ids = []
        for name in names:
            row = conn.execute("SELECT id FROM tags WHERE name = ? COLLATE NOCASE", (name,)).fetchone()
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

    def _field_filter_condition(self, conn, flt):
        """一个字段条件 → (SQL, 参数)。

        数字：{"field": 3, "min": "10", "max": "20"}
        日期：{"field": 5, "min": "2015", "max": "2020-06"}
        单选 / 多选：{"field": 7, "options": ["已婚", "离异"]}（满足任一）；
                     "empty": true 表示“未填写”，可与 options 同时使用（满足任一）。
        """
        if not isinstance(flt, dict):
            raise ValueError("字段筛选条件格式不对。")
        label, kind = self._field_kind(conn, flt.get("field"))
        field_id = int(flt["field"])
        conds, params = [], []

        if kind in NUMERIC_KINDS:
            parts, sub = ["field_id = ?"], [field_id]
            for text, op, end in ((flt.get("min"), ">=", False), (flt.get("max"), "<=", True)):
                if text in (None, ""):
                    continue
                if kind == "number":
                    bound = parse_number(text)
                    if bound is None:
                        raise ValueError(f"「{label}」的筛选值无法识别：{text!r}，请填数字。")
                else:
                    bound = period_bound(text, end=end)
                parts.append(f"num_value {op} ?")
                sub.append(bound)
            if len(parts) > 1:
                conds.append("p.id IN (SELECT profile_id FROM profile_values WHERE " + " AND ".join(parts) + ")")
                params += sub
        elif kind in CHOICE_KINDS:
            options = [self._clean_option(o) for o in flt.get("options") or []]
            if options:
                marks = ",".join("?" * len(options))
                conds.append(
                    "p.id IN (SELECT profile_id FROM profile_choices WHERE field_id = ? "
                    f"AND option COLLATE NOCASE IN ({marks}))"
                )
                params += [field_id] + options
        else:
            raise ValueError(f"字段「{label}」是{FIELD_KINDS.get(kind, kind)}类型，请用全文检索查找其中的内容。")

        if flt.get("empty"):
            conds.append("p.id NOT IN (SELECT profile_id FROM profile_values WHERE field_id = ?)")
            params.append(field_id)
        if not conds:
            return None, []
        return "(" + " OR ".join(conds) + ")", params

    def _search_condition(self, q, scope):
        """名字搜索或全文检索 → (SQL 条件列表, 参数)。全文：空格分开的每个词都要出现。"""
        terms = _search_terms(q or "")
        if not terms:
            return [], []
        if scope != "all":
            conds, params = [], []
            for t in terms:
                conds.append("p.display_name LIKE ? ESCAPE '\\'")
                params.append(self._like(t))
            return conds, params

        if self.fts:
            # trigram 全文索引：3 个字以上的词用索引（整词加引号按短语匹配，多个词一起交给一次 MATCH）；
            # 1–2 个字的词 trigram 索引用不上，用 LIKE 在同一次查询里过滤，
            # 有长词时只需在长词命中的那些人里检查，不必扫全库。
            # 两个汉字的词查两字词索引。只剩 1 个字（或两字里夹着字母数字）的词才需要逐条 LIKE。
            long_terms = [t for t in terms if len(t) >= 3]
            pair_terms = [t for t in terms if _is_cjk_pair(t)]
            short_terms = [t for t in terms if len(t) < 3 and not _is_cjk_pair(t)]
            conds, params = [], []
            if pair_terms:
                conds.append("p.id IN (SELECT rowid FROM profile_bigram WHERE profile_bigram MATCH ?)")
                params.append(" ".join(f'"{t}"' for t in pair_terms))
            parts, sub = [], []
            if long_terms:
                parts.append("profile_fts MATCH ?")
                sub.append(" ".join('"' + t.replace('"', '""') + '"' for t in long_terms))
            for t in short_terms:
                parts.append("content LIKE ? ESCAPE '\\'")
                sub.append(self._like(t))
            if parts:
                conds.append("p.id IN (SELECT rowid FROM profile_fts WHERE " + " AND ".join(parts) + ")")
                params += sub
            return conds, params

        # SQLite 不支持 trigram：逐条模糊匹配（名字、字段原文、标签）。
        conds, params = [], []
        for t in terms:
            like = self._like(t)
            conds.append(
                "(p.display_name LIKE ? ESCAPE '\\' "
                "OR p.id IN (SELECT profile_id FROM profile_values WHERE value LIKE ? ESCAPE '\\') "
                "OR p.id IN (SELECT pt.profile_id FROM people_tags pt JOIN tags t ON t.id = pt.tag_id "
                "            WHERE t.name LIKE ? ESCAPE '\\'))"
            )
            params += [like, like, like]
        return conds, params

    def _match_snippets(self, conn, profile_ids, terms):
        """全文检索时，给当前页每个人找出第一处命中的位置：{id: {"field": 字段名, "text": 摘要}}。"""
        if not profile_ids or not terms:
            return {}
        tree = self._field_tree(conn)
        labels = {f["id"]: PATH_SEP.join(f["path"]) for f in tree}
        order = {f["id"]: i for i, f in enumerate(tree)}
        marks = ",".join("?" * len(profile_ids))
        values = {}
        for r in conn.execute(
            f"SELECT profile_id, field_id, value FROM profile_values WHERE profile_id IN ({marks})",
            list(profile_ids),
        ):
            values.setdefault(int(r["profile_id"]), []).append(
                (order.get(int(r["field_id"]), 0), labels.get(int(r["field_id"]), ""), r["value"]))
        values = {pid: [(label, text) for _, label, text in sorted(items)] for pid, items in values.items()}
        tags = self._tags_of(conn, profile_ids)
        result = {}
        for pid in profile_ids:
            sources = values.get(pid, []) + [("标签", "、".join(tags.get(pid, [])))]
            for term in terms:
                hit = next(((label, _excerpt(text, term)) for label, text in sources if _excerpt(text, term)), None)
                if hit:
                    result[pid] = {"field": hit[0], "text": hit[1], "term": term}
                    break
        return result

    def list_profiles(
        self,
        *,
        page=1,
        page_size=DEFAULT_PAGE_SIZE,
        q=None,
        scope="name",
        tags=None,
        tag_mode="all",
        born_from=None,
        born_to=None,
        field_filters=None,
        sort=DEFAULT_SORT,
        order=None,
        with_total=True,
    ):
        """分页列表：每页只返回 id、名字、出生时间、历法、修改时间、标签（全文检索时另带命中摘要），
        不带自定义字段的内容。

        筛选（可叠加，彼此是“并且”）：
          q + scope        scope=name：名字包含；scope=all：全文检索（名字、标签、所有字段原文），
                           空格分开的每个词都要出现
          tags / tag_mode  标签；all＝必须同时具备（默认），any＝具备其一即可
          born_from/to     出生日期范围，写 1980 / 1980-05 / 1980-05-12 均可
          field_filters    字段条件列表（见 _field_filter_condition），最多 10 条
        排序：sort ＝ opened | name | birth | updated | created | field:<数字/日期字段 id>
              order ＝ asc | desc，不传时用这个排序依据的默认方向（见 SORT_DEFAULT_ORDER）；
              没有值的人（从没打开过、字段没填）始终排在最后。
        按 opened / updated / created / field 排序时，每一项另带 sort_value（排序依据的值）。
        """
        page = self._int_arg(page, "page", 1, 1, 10**9)
        size = self._int_arg(page_size, "page_size", DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE)
        offset = (page - 1) * size

        sort = str(sort or DEFAULT_SORT).strip()
        order = str(order or default_order(sort)).strip().lower()
        if order not in ("asc", "desc"):
            raise ValueError("order 只能是 asc 或 desc。")
        tag_mode = str(tag_mode or "all").strip().lower()
        if tag_mode not in ("all", "any"):
            raise ValueError("tag_mode 只能是 all 或 any。")
        scope = "all" if str(scope or "name").strip().lower() == "all" else "name"
        filters = list(field_filters or [])
        if len(filters) > MAX_FIELD_FILTERS:
            raise ValueError(f"字段条件最多 {MAX_FIELD_FILTERS} 条。")

        with self._read() as conn:
            where, params = self._search_condition(q, scope)

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

            for flt in filters:
                condition, sub = self._field_filter_condition(conn, flt)
                if condition:
                    where.append(condition)
                    params.extend(sub)

            # ---- 排序
            direction = "ASC" if order == "asc" else "DESC"
            field_sort = None
            nullable_sort = None
            order_sql = ""
            if sort.startswith("field:"):
                try:
                    field_sort = int(sort.split(":", 1)[1])
                except ValueError:
                    raise ValueError("sort 里的字段 id 必须是整数，例如 field:3。")
                label, kind = self._field_kind(conn, field_sort)
                if kind not in NUMERIC_KINDS:
                    raise ValueError(f"字段「{label}」不是数字或日期类型，不能按大小排序。")
            elif sort in self._NULLABLE_SORTS:
                nullable_sort = self._NULLABLE_SORTS[sort]
            elif sort in self._CORE_SORTS:
                columns = list(self._CORE_SORTS[sort])
                if sort != "created":
                    columns.append("p.id")   # 并列时按 id 兜底，翻页顺序稳定
                order_sql = ", ".join(f"{col} {direction}" for col in columns)
            else:
                raise ValueError(
                    "sort 只能是 opened / name / birth / updated / created / field:<id>。"
                )

            where_sql = ("WHERE " + " AND ".join(where)) if where else ""

            total = None
            if with_total:
                total = int(conn.execute(f"SELECT COUNT(*) FROM people AS p {where_sql}", params).fetchone()[0])

            if field_sort is not None:
                rows = self._rows_by_field(conn, field_sort, direction, where, params, size + 1, offset)
            elif nullable_sort is not None:
                rows = self._rows_by_nullable(conn, nullable_sort, direction, where, params, size + 1, offset)
            else:
                rows = conn.execute(
                    f"""
                    SELECT {self._LIST_COLUMNS}
                    FROM people AS p
                    {where_sql}
                    ORDER BY {order_sql}
                    LIMIT ? OFFSET ?
                    """,
                    params + [size + 1, offset],   # 多取 1 条，用来判断还有没有下一页
                ).fetchall()

            has_more = len(rows) > size
            rows = rows[:size]
            ids = [int(r["id"]) for r in rows]
            tag_map = self._tags_of(conn, ids)
            snippets = self._match_snippets(conn, ids, _search_terms(q or "")) if scope == "all" else {}
            field_values = {}
            if field_sort is not None and ids:
                marks = ",".join("?" * len(ids))
                field_values = {
                    int(r["profile_id"]): r["value"]
                    for r in conn.execute(
                        f"SELECT profile_id, value FROM profile_values WHERE field_id = ? AND profile_id IN ({marks})",
                        [field_sort] + ids,
                    )
                }

        items = []
        for r in rows:
            item = {
                "id": int(r["id"]),
                "display_name": r["display_name"],
                "birth_time": r["birth_time"],
                "calendar": r["calendar"],
                "updated_at": r["updated_at"],
                "tags": tag_map.get(int(r["id"]), []),
            }
            if sort in self._SORT_VALUE_COLUMNS:
                item["sort_value"] = r[self._SORT_VALUE_COLUMNS[sort]]
            elif field_sort is not None:
                item["sort_value"] = field_values.get(int(r["id"]))
            if int(r["id"]) in snippets:
                item["match"] = snippets[int(r["id"])]
            items.append(item)
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

    _LIST_COLUMNS = "p.id, p.display_name, p.birth_time, p.calendar, p.updated_at, p.created_at, p.last_opened_at"

    @classmethod
    def _rows_by_nullable(cls, conn, column, direction, where, params, limit, offset):
        """按一个可能为空的列排序的一页（含 limit 条），例如「最近打开」。

        和 _rows_by_field 一样分两段读，都能顺着索引提前收工：
          ① 有值的人：按这一列的值排；
          ② 没有值的人（从没打开过）：排在最后，按 id 顺序读。
        column 只来自 _NULLABLE_SORTS 白名单。
        """
        extra = (" AND " + " AND ".join(where)) if where else ""
        columns = cls._LIST_COLUMNS
        rows = conn.execute(
            f"""
            SELECT {columns}
            FROM people AS p
            WHERE {column} IS NOT NULL{extra}
            ORDER BY {column} {direction}, p.id {direction}
            LIMIT ? OFFSET ?
            """,
            params + [limit, offset],
        ).fetchall()
        if len(rows) >= limit:
            return rows

        if rows:
            with_value_count = offset + len(rows)
        elif offset == 0:
            with_value_count = 0
        else:
            with_value_count = conn.execute(
                f"SELECT COUNT(*) FROM people AS p WHERE {column} IS NOT NULL{extra}", params,
            ).fetchone()[0]

        rows += conn.execute(
            f"""
            SELECT {columns}
            FROM people AS p
            WHERE {column} IS NULL{extra}
            ORDER BY p.id {direction}
            LIMIT ? OFFSET ?
            """,
            params + [limit - len(rows), max(0, offset - with_value_count)],
        ).fetchall()
        return rows

    def mark_opened(self, profile_id):
        """某人被选为本命盘时调用：记下打开时间，供「最近打开」排序。

        只改 last_opened_at 一列：不改 updated_at（「最近修改」保持原意），也不碰全文索引。
        """
        with self._tx() as conn:
            conn.execute("UPDATE people SET last_opened_at = ? WHERE id = ?", (self._now(), int(profile_id)))

    @classmethod
    def _rows_by_field(cls, conn, field_id, direction, where, params, limit, offset):
        """按某个数字 / 日期字段的数值排序的一页（含 limit 条）。

        两段读取，各自都能提前收工：
          ① 有数值的人：直接顺着 (字段, 数值) 索引读，读够一页就停；
          ② 没有数值的人（没填，或写的内容无法识别）：排在最后，按 id 顺序读。
        """
        extra = (" AND " + " AND ".join(where)) if where else ""
        columns = cls._LIST_COLUMNS

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
            return rows

        if rows:
            with_value_count = offset + len(rows)
        elif offset == 0:
            with_value_count = 0
        else:
            with_value_count = conn.execute(
                "SELECT COUNT(*) FROM profile_values AS sv JOIN people AS p ON p.id = sv.profile_id "
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
        params = [" ".join(str(name or "").split())]
        if exclude_id not in (None, ""):
            sql += " AND id <> ?"
            params.append(int(exclude_id))
        with self._read() as conn:
            return int(conn.execute(sql, params).fetchone()[0])

    # ------------------------------------------------------------------ 档案：详情 / 写入

    def get_profile(self, profile_id):
        """点开某个人时才调用：必备字段 + 全部自定义字段（含长文）+ 标签。

        fields：{字段id: 原文}；多选字段的值是选项列表，单选是选项文本。
        """
        profile_id = int(profile_id)
        with self._read() as conn:
            row = conn.execute(
                """
                SELECT id, display_name, birth_time, calendar, timezone_offset,
                       latitude, longitude, created_at, updated_at
                FROM people WHERE id = ?
                """,
                (profile_id,),
            ).fetchone()
            if row is None:
                return None
            kinds = {int(r["id"]): r["kind"] for r in conn.execute("SELECT id, kind FROM profile_fields")}
            choices = {}
            for c in conn.execute(
                "SELECT field_id, option FROM profile_choices WHERE profile_id = ?", (profile_id,)
            ):
                choices.setdefault(int(c["field_id"]), []).append(c["option"])
            fields = {}
            for v in conn.execute("SELECT field_id, value FROM profile_values WHERE profile_id = ?", (profile_id,)):
                fid = int(v["field_id"])
                if kinds.get(fid) == "multi":
                    fields[str(fid)] = split_list(v["value"])
                else:
                    fields[str(fid)] = v["value"]
            tags = self._tags_of(conn, [profile_id]).get(profile_id, [])
        item = dict(row)
        item["fields"] = fields
        item["tags"] = tags
        return item

    def _insert_profile(self, conn, data, *, clean=None, field_values=None):
        clean = clean or self._validate(data)
        now = self._now()
        if field_values is None:
            field_values = self._clean_field_values(conn, data.get("fields"))
        tags = self._clean_tags(data.get("tags"))
        cursor = conn.execute(
            """
            INSERT INTO people (
                display_name, birth_time, calendar, timezone_offset,
                latitude, longitude, created_at, updated_at,
                birth_ymd, birth_tod
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                clean["display_name"], clean["birth_time"], clean["calendar"], clean["timezone_offset"],
                clean["latitude"], clean["longitude"], now, now,
                clean["birth_ymd"], clean["birth_tod"],
            ),
        )
        profile_id = int(cursor.lastrowid)
        self._write_field_values(conn, profile_id, field_values)
        if tags:
            self._write_tags(conn, profile_id, tags)
        self._refresh_fts(conn, [profile_id])
        return profile_id

    def _update_profile_row(self, conn, profile_id, data, *, clean=None, field_values=None):
        clean = clean or self._validate(data)
        if field_values is None:
            field_values = self._clean_field_values(conn, data.get("fields"))
        tags = self._clean_tags(data.get("tags")) if "tags" in data else None
        conn.execute(
            """
            UPDATE people
            SET display_name = ?, birth_time = ?, calendar = ?, timezone_offset = ?,
                latitude = ?, longitude = ?, birth_ymd = ?, birth_tod = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                clean["display_name"], clean["birth_time"], clean["calendar"], clean["timezone_offset"],
                clean["latitude"], clean["longitude"], clean["birth_ymd"], clean["birth_tod"],
                self._now(), profile_id,
            ),
        )
        self._write_field_values(conn, profile_id, field_values)
        if tags is not None:
            self._write_tags(conn, profile_id, tags)
        self._refresh_fts(conn, [profile_id])

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
            self._update_profile_row(conn, profile_id, data)
        return self.get_profile(profile_id)

    def delete_profile(self, profile_id):
        with self._tx() as conn:
            cursor = conn.execute("DELETE FROM people WHERE id = ?", (int(profile_id),))
            if cursor.rowcount > 0:
                self._prune_tags(conn)
                if self.fts:
                    conn.execute("DELETE FROM profile_fts WHERE rowid = ?", (int(profile_id),))
                    conn.execute("DELETE FROM profile_bigram WHERE rowid = ?", (int(profile_id),))
        return cursor.rowcount > 0

    # ------------------------------------------------------------------ CSV 导入 / 导出
    #
    # CSV 只是交换格式：程序运行时数据始终在 SQLite 里。
    # 列：id, 人物名称, 出生时间, 历法, 时区, 纬度, 经度, 标签, <每个自定义字段一列>, 创建时间, 修改时间
    #   自定义字段的列名是完整路径：顶层字段直接写名字，下级字段写成 婚姻/是否二婚（分组本身不占列）。
    #   历法写 g / j；时区写成 UTC+08:00（带 UTC 前缀，防止 Excel 把 +08:00 当成时间改掉）；
    #   标签、多选字段的多个值用“; ”分隔。

    CSV_CORE = ["id", "人物名称", "出生时间", "历法", "时区", "纬度", "经度", "标签"]
    CSV_TAIL = ["创建时间", "修改时间"]

    def iter_csv(self):
        """全部档案 → 逐行产出 CSV 文本（UTF-8 带 BOM，Excel / WPS 直接双击打开不乱码）。

        按 id 顺序流式读取：人物、字段值、标签三条有序查询并排推进，内存占用与档案数量无关，
        几十万份档案也不会一次性读进内存。
        """
        out = io.StringIO()
        writer = csv.writer(out, lineterminator="\r\n")

        def flush():
            text = out.getvalue()
            out.seek(0)
            out.truncate(0)
            return text

        with self._read() as conn:
            fields = [f for f in self._field_tree(conn) if f["kind"] != "group"]
            writer.writerow(self.CSV_CORE + [PATH_SEP.join(f["path"]) for f in fields] + self.CSV_TAIL)
            yield "﻿" + flush()
            people = conn.execute(
                "SELECT id, display_name, birth_time, calendar, timezone_offset, latitude, longitude, "
                "created_at, updated_at FROM people ORDER BY id"
            )
            values_conn = self._acquire()
            tags_conn = self._acquire()
            try:
                values = values_conn.execute(
                    "SELECT profile_id, field_id, value FROM profile_values ORDER BY profile_id")
                tags = tags_conn.execute(
                    "SELECT pt.profile_id, t.name FROM people_tags pt JOIN tags t ON t.id = pt.tag_id "
                    "ORDER BY pt.profile_id, t.name COLLATE NOCASE")
                next_value = values.fetchone()
                next_tag = tags.fetchone()
                for count, p in enumerate(people, start=1):
                    pid = int(p["id"])
                    own_values, own_tags = {}, []
                    while next_value is not None and int(next_value[0]) <= pid:
                        if int(next_value[0]) == pid:
                            own_values[int(next_value[1])] = next_value[2]
                        next_value = values.fetchone()
                    while next_tag is not None and int(next_tag[0]) <= pid:
                        if int(next_tag[0]) == pid:
                            own_tags.append(next_tag[1])
                        next_tag = tags.fetchone()
                    row = [
                        pid, p["display_name"], p["birth_time"], p["calendar"], f"UTC{p['timezone_offset']}",
                        repr(float(p["latitude"])), repr(float(p["longitude"])), "; ".join(own_tags),
                    ]
                    for f in fields:
                        text = own_values.get(f["id"], "")
                        if f["kind"] == "multi":
                            text = "; ".join(split_list(text))
                        row.append(text)
                    row += [p["created_at"], p["updated_at"]]
                    writer.writerow(row)
                    if count % 2000 == 0:
                        yield flush()
            finally:
                self._release(values_conn)
                self._release(tags_conn)
        yield flush()

    def export_csv(self):
        return "".join(self.iter_csv())

    @staticmethod
    def _decode_csv(raw):
        if isinstance(raw, str):
            return raw.lstrip("﻿")
        for encoding in ("utf-8-sig", "gb18030"):
            # 中文 Windows 上的 Excel 另存 CSV 默认是 GBK（gb18030 是它的超集）。
            # 用 GBK 另存时，原来的 UTF-8 BOM 可能被当成普通字符留在开头，一并去掉。
            try:
                return raw.decode(encoding).lstrip("﻿")
            except UnicodeDecodeError:
                continue
        raise ValueError("CSV 文件编码无法识别，请另存为 UTF-8 或 GBK 编码。")

    def _field_for_path(self, conn, path_text, by_path, new_fields):
        """CSV 表头 → 字段 id。路径里不存在的上级自动建成分组，最后一级建成文本字段。"""
        parts = [" ".join(p.split()) for p in path_text.split(PATH_SEP)]
        if any(not p for p in parts):
            raise ValueError(f"表头「{path_text}」的写法不对：上下级字段之间用「{PATH_SEP}」分隔，中间不能为空。")
        if len(parts) > MAX_FIELD_DEPTH:
            raise ValueError(f"表头「{path_text}」超过 {MAX_FIELD_DEPTH} 层。")
        parent = None
        for depth, label in enumerate(parts):
            key = PATH_SEP.join(p.casefold() for p in parts[: depth + 1])
            last = depth == len(parts) - 1
            if key not in by_path:
                field_id = self._insert_field(conn, self._clean_label(label), "text" if last else "group", (), parent)
                by_path[key] = {"id": field_id, "kind": "text" if last else "group"}
                new_fields.append(PATH_SEP.join(parts[: depth + 1]))
            parent = by_path[key]["id"]
        if by_path[PATH_SEP.join(p.casefold() for p in parts)]["kind"] == "group":
            raise ValueError(f"「{path_text}」是分组，不存内容，CSV 里不能有这一列。")
        return parent

    def import_csv(self, raw):
        """CSV → 数据库，全部在一个事务里完成：任何一行有错，整个导入都不生效。

        - id 列有值且对应现有档案：更新这份档案（CSV 里出现的列覆盖，空单元格 = 清空该字段）；
          id 为空或找不到：新建档案。
        - 表头里不认识的列：自动新建为文本字段；写成 上级/下级 时，缺少的上级自动建成分组。
        - 单选 / 多选字段里出现新选项：自动加进该字段的选项。
        返回 {"created", "updated", "new_fields", "new_options", "rows"}。
        """
        text = self._decode_csv(raw)
        reader = csv.reader(io.StringIO(text))
        try:
            header = [" ".join(h.replace("﻿", "").split()) for h in next(reader)]
        except StopIteration:
            raise ValueError("CSV 文件是空的。")

        lower = [h.casefold() for h in header]
        need = ["人物名称", "出生时间", "历法", "时区", "纬度", "经度"]
        missing = [n for n in need if n.casefold() not in lower]
        if missing:
            raise ValueError("CSV 缺少必需的列：" + "、".join(missing))
        if len(set(lower)) != len(lower):
            raise ValueError("CSV 表头里有重复的列名。")
        col = {h.casefold(): i for i, h in enumerate(header)}
        known_core = {c.casefold() for c in self.CSV_CORE + self.CSV_TAIL}

        errors, created, updated = [], 0, 0
        new_fields, new_options = [], {}

        with self._tx() as conn:
            by_path = {
                PATH_SEP.join(p.casefold() for p in f["path"]): {"id": f["id"], "kind": f["kind"]}
                for f in self._field_tree(conn)
            }
            field_cols = {}
            for i, h in enumerate(header):
                if not h or h.casefold() in known_core:
                    continue
                field_cols[self._field_for_path(conn, h, by_path, new_fields)] = i
            defs = self._field_defs(conn)
            existing_ids = {int(r[0]) for r in conn.execute("SELECT id FROM people")}

            for line_no, cells in enumerate(reader, start=2):
                if not any(c.strip() for c in cells):
                    continue
                cells = cells + [""] * (len(header) - len(cells))

                def cell(name):
                    i = col.get(name.casefold())
                    return cells[i].strip() if i is not None else ""

                try:
                    data = {
                        "display_name": cell("人物名称"),
                        "birth_time": cell("出生时间"),
                        "calendar": cell("历法") or "g",
                        "timezone_offset": cell("时区"),
                        "latitude": cell("纬度"),
                        "longitude": cell("经度"),
                    }
                    if "标签".casefold() in col:
                        data["tags"] = cell("标签")
                    clean = self._validate(data)
                    raw_values = {fid: cells[i] for fid, i in field_cols.items()}
                    field_values = {
                        fid: self._clean_one_value(conn, fid, defs[fid], value, add_options=True, added=new_options)
                        for fid, value in raw_values.items()
                    }
                    id_text = cell("id")
                    target = int(id_text) if id_text.isdigit() and int(id_text) in existing_ids else None
                    if target is None:
                        self._insert_profile(conn, data, clean=clean, field_values=field_values)
                        created += 1
                    else:
                        self._update_profile_row(conn, target, data, clean=clean, field_values=field_values)
                        updated += 1
                except (ValueError, sqlite3.Error) as exc:
                    errors.append(f"第 {line_no} 行：{exc}")
                    if len(errors) >= 20:
                        break

            if errors:
                # 抛出异常 → 事务整体回滚，数据库保持导入前的样子。
                more = "（只列出前 20 条）" if len(errors) >= 20 else ""
                raise ValueError("导入失败，数据库没有任何改动。请修改 CSV 后重新导入" + more + "：\n" + "\n".join(errors))

        if created + updated > 1000:
            self.optimize()
        return {
            "created": created,
            "updated": updated,
            "new_fields": new_fields,
            "new_options": {k: sorted(set(v)) for k, v in new_options.items()},
            "rows": created + updated,
        }
