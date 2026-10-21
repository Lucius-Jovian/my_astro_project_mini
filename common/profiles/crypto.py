"""档案库加密（SQLCipher）。

每个档案库可以单独加密，各有各的密码。加密后的库仍是 user_data/libraries/<名字>.sqlite3，
只是整个文件按页用 AES-256 加密（SQLCipher 4 默认参数：每页 4096 字节、HMAC-SHA512 校验、
PBKDF2-HMAC-SHA512 256000 次迭代推导密钥）。读写都直接在磁盘上按页进行，不需要把整库载入内存，
几十万份档案和未加密时一样流畅。WAL 日志文件同样是密文。

- 程序只在内存里记住已解锁库的密码，关掉程序即全部锁上。密码不写进任何文件。
  **忘记密码，这个档案库无法找回**。
- 用 DB Browser for SQLite（选 SQLCipher 4 默认设置）输入同一个密码也能直接打开加密库。
- 需要 sqlcipher3（pip install sqlcipher3-wheels）。没装时加密功能不可用，其它功能照常。
"""

from __future__ import annotations

import os
from pathlib import Path

from .driver import HAS_SQLCIPHER, PLAIN_HEADER, WrongPassword, apply_key, sqlite

MIN_PASSWORD = 6


def crypto_available():
    return HAS_SQLCIPHER


def is_encrypted(path):
    """文件头不是 "SQLite format 3" 的非空文件视为 SQLCipher 加密库。"""
    path = Path(path)
    try:
        if path.stat().st_size == 0:
            return False
        with path.open("rb") as fh:
            return fh.read(16) != PLAIN_HEADER
    except OSError:
        return False


def check_new_password(password):
    if not isinstance(password, str) or len(password) < MIN_PASSWORD:
        raise ValueError(f"密码至少 {MIN_PASSWORD} 个字符。")
    if not HAS_SQLCIPHER:
        raise ValueError("加密功能需要 sqlcipher3 库：请先运行 pip install sqlcipher3-wheels，然后重新启动程序。")


def verify(path, key):
    """核对密码；不对时抛 WrongPassword。"""
    conn = sqlite.connect(str(path))
    try:
        apply_key(conn, key)
    finally:
        conn.close()


def remove_sqlite_files(path):
    for suffix in ("", "-wal", "-shm", "-journal"):
        p = Path(str(path) + suffix)
        if p.exists():
            p.unlink()


def _export(path, old_key, new_key):
    """把 path 整库导出到同目录的临时文件（old_key → new_key；None 表示不加密），再替换原文件。

    先把原库切回普通日志模式（合并并删掉 -wal），确保替换后不会有旧的 WAL 文件残留在新库旁边。
    导出完成之前原文件不动，中途出错时原库完好。
    """
    if not HAS_SQLCIPHER:
        raise ValueError("加密功能需要 sqlcipher3 库：请先运行 pip install sqlcipher3-wheels。")
    path = Path(path)
    tmp = path.with_name(path.name + ".tmp")
    remove_sqlite_files(tmp)
    conn = sqlite.connect(str(path), isolation_level=None)
    try:
        if old_key is not None:
            apply_key(conn, old_key)
        conn.execute("PRAGMA journal_mode = DELETE")
        version = int(conn.execute("PRAGMA user_version").fetchone()[0])
        conn.execute("ATTACH DATABASE ? AS target KEY ?", (str(tmp), new_key or ""))
        conn.execute("SELECT sqlcipher_export('target')")
        conn.execute(f"PRAGMA target.user_version = {version}")
        conn.execute("DETACH DATABASE target")
    except BaseException:
        conn.close()
        remove_sqlite_files(tmp)
        raise
    conn.close()
    for suffix in ("-wal", "-shm", "-journal"):
        leftover = Path(str(path) + suffix)
        if leftover.exists():
            leftover.unlink()
    os.replace(tmp, path)


def encrypt_file(path, password):
    check_new_password(password)
    _export(path, None, password)


def decrypt_file(path, password):
    verify(path, password)
    _export(path, password, None)


def rekey_file(path, old, new):
    check_new_password(new)
    verify(path, old)
    _export(path, old, new)


__all__ = ["WrongPassword", "check_new_password", "crypto_available", "decrypt_file", "encrypt_file",
           "is_encrypted", "rekey_file", "remove_sqlite_files", "verify"]
