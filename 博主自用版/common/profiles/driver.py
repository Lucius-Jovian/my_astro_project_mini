"""档案库用的 SQLite 驱动。

装了 sqlcipher3（pip install sqlcipher3-wheels）时用它：它就是带 SQLCipher 加密扩展的 SQLite，
打开普通（未加密）的 .sqlite3 文件和标准库 sqlite3 完全一样，同时支持按库加密。
没装时退回 Python 自带的 sqlite3，除了不能加密，其它功能都不受影响。

整个档案系统只从这里取 sqlite 模块，保证异常类型（IntegrityError 等）前后一致。
"""

from __future__ import annotations

try:  # pragma: no cover - 取决于用户环境
    import sqlcipher3.dbapi2 as sqlite
    HAS_SQLCIPHER = True
except ImportError:  # pragma: no cover
    import sqlite3 as sqlite
    HAS_SQLCIPHER = False

PLAIN_HEADER = b"SQLite format 3\x00"


class LockedError(Exception):
    """档案库已加密且尚未解锁。library 是被锁定的库名。"""

    def __init__(self, library=None, message=None):
        self.library = library
        super().__init__(message or (f"档案库「{library}」已加密并锁定，请先输入密码解锁。" if library
                                     else "档案库已加密并锁定，请先输入密码解锁。"))


class WrongPassword(ValueError):
    pass


def quote(text):
    """SQL 字符串字面量（PRAGMA key 不能用参数绑定）。"""
    return "'" + str(text).replace("'", "''") + "'"


def apply_key(conn, key):
    """给刚打开的连接设置密码，并立刻读一次库头核对：密码不对时抛 WrongPassword。"""
    conn.execute("PRAGMA cipher_log_level = NONE")    # 密码不对时不往命令行打印底层错误
    conn.execute(f"PRAGMA key = {quote(key)}")
    try:
        conn.execute("SELECT count(*) FROM sqlite_master").fetchone()
    except sqlite.DatabaseError as exc:
        raise WrongPassword("密码不对，或者文件已损坏。") from exc
