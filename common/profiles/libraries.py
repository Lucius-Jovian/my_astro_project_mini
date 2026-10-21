from __future__ import annotations

from pathlib import Path
import re
import threading

from . import crypto
from .db import ProfileDB
from .driver import LockedError

# 档案库：每一套档案（例如“婚姻”“职业”）是 user_data/libraries/ 里的一个独立 SQLite 文件，
# 文件名就是档案库的名字。各库的人物、自定义字段、标签完全互不相干。
#
# 加密按档案库分别设置，每个库有自己的密码。加密前后文件名不变（都是 <名字>.sqlite3），
# 程序看文件头分辨：普通 SQLite 文件以 "SQLite format 3" 开头，SQLCipher 加密文件从第一个字节起就是密文。
# 想加一套现成的档案，把 .sqlite3 文件放进这个文件夹、刷新网页即可（加密的库同样可以，解锁时输入它的密码）。

LIBRARY_SUFFIX = ".sqlite3"
DEFAULT_LIBRARY = "档案库"
MAX_NAME_LEN = 30
_BAD_NAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def clean_library_name(name):
    name = " ".join(str(name or "").split())
    if not name:
        raise ValueError("档案库名称不能为空。")
    if len(name) > MAX_NAME_LEN:
        raise ValueError(f"档案库名称不能超过 {MAX_NAME_LEN} 个字。")
    if _BAD_NAME.search(name) or name.startswith(".") or name.endswith("."):
        raise ValueError('档案库名称里不能有 \\ / : * ? " < > | 这些字符，也不能以点开头或结尾。')
    return name


class ProfileLibraries:
    """管理多个档案库，并记住“当前正在用哪一个”。本地单用户程序，当前库是全局的。

    已解锁的加密库的密码只放在内存里（self._keys），关掉程序即全部锁上。
    """

    def __init__(self, data_dir):
        self.dir = Path(data_dir) / "libraries"
        self.dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._dbs = {}
        self._keys = {}
        self.current = None
        if not self.names():
            self._open(DEFAULT_LIBRARY)

    # ------------------------------------------------------------------ 名字与路径

    def _path(self, name):
        return self.dir / f"{name}{LIBRARY_SUFFIX}"

    def names(self):
        found = [p.name[: -len(LIBRARY_SUFFIX)] for p in self.dir.glob(f"*{LIBRARY_SUFFIX}") if p.is_file()]
        return sorted(found, key=str.casefold)

    def _find(self, name):
        """按名字找档案库（不分大小写，Windows 文件名本来就不分）；找不到返回 None。"""
        wanted = str(name or "").casefold()
        return next((n for n in self.names() if n.casefold() == wanted), None)

    def _require(self, name):
        found = self._find(name)
        if found is None:
            raise ValueError(f"没有名为「{name}」的档案库。")
        return found

    # ------------------------------------------------------------------ 打开 / 关闭

    def is_encrypted(self, name):
        return crypto.is_encrypted(self._path(name))

    def is_locked(self, name):
        return self.is_encrypted(name) and name not in self._keys

    def _require_unlocked(self, name=None):
        name = name or self.current_name()
        if name is not None and self.is_locked(name):
            raise LockedError(name)

    def _open(self, name):
        with self._lock:
            if name in self._dbs:
                return self._dbs[name]
            if self.is_encrypted(name):
                if not crypto.crypto_available():
                    raise ValueError(f"「{name}」是加密的档案库，需要 sqlcipher3 库才能打开："
                                     "请先运行 pip install sqlcipher3-wheels，然后重新启动程序。")
                self._require_unlocked(name)
                self._dbs[name] = ProfileDB(self._path(name), key=self._keys[name])
            else:
                self._dbs[name] = ProfileDB(self._path(name))
            return self._dbs[name]

    def _close(self, name):
        db = self._dbs.pop(name, None)
        if db is not None:
            db.close()

    def summary(self):
        """[{name, count, encrypted, locked}]：下拉框用。锁定的库不打开，人数为空。"""
        result = []
        for name in self.names():
            encrypted = self.is_encrypted(name)
            locked = encrypted and name not in self._keys
            count = None
            if not locked:
                try:
                    count = self._open(name).list_profiles(page_size=1)["total"]
                except Exception:
                    count = None
            result.append({"name": name, "count": count, "encrypted": encrypted, "locked": locked})
        return result

    # ------------------------------------------------------------------ 当前档案库

    def current_name(self):
        with self._lock:
            names = self.names()
            if not names:
                self._open(DEFAULT_LIBRARY)
                names = self.names()
            if self.current is None or self._find(self.current) is None:
                self.current = names[0]
            return self.current

    def db(self):
        with self._lock:
            return self._open(self.current_name())

    def select(self, name):
        """记住要用哪个库，但不打开它（加密且未解锁时也能调用）。"""
        found = self._find(name)
        if found is not None:
            self.current = found
        return found

    def switch(self, name):
        """切换当前库。目标库加密且锁定时也会切换过去，随后的读写返回 LockedError（前端弹出解锁窗口）。"""
        with self._lock:
            self.current = self._require(name)
            return self._open(self.current)

    def create(self, name):
        name = clean_library_name(name)
        with self._lock:
            if self._find(name) is not None:
                raise ValueError(f"已经有名为「{name}」的档案库了。")
            self._open(name)
            return name

    def rename(self, old, new):
        new = clean_library_name(new)
        with self._lock:
            found = self._require(old)
            self._require_unlocked(found)
            other = self._find(new)
            if other is not None and other != found:
                raise ValueError(f"已经有名为「{new}」的档案库了。")
            if new == found:
                return new
            self._close(found)                 # 关掉全部连接，WAL 合并回主文件后才能改名
            for suffix in ("", "-wal", "-shm"):
                source = Path(str(self._path(found)) + suffix)
                if source.exists():
                    source.rename(Path(str(self._path(new)) + suffix))
            if found in self._keys:
                self._keys[new] = self._keys.pop(found)
            if self.current == found:
                self.current = new
            self._open(new)
            return new

    # ------------------------------------------------------------------ 加密（都只作用于一个档案库）

    def security_status(self, name=None):
        name = self._find(name) if name else self.current_name()
        encrypted = bool(name) and self.is_encrypted(name)
        return {
            "library": name,
            "available": crypto.crypto_available(),
            "enabled": encrypted,
            "unlocked": not encrypted or name in self._keys,
            "libraries": len(self.names()),
        }

    def unlock(self, name, password):
        with self._lock:
            name = self._require(name)
            if not self.is_encrypted(name):
                raise ValueError(f"「{name}」没有加密。")
            crypto.verify(self._path(name), password)
            self._close(name)
            self._keys[name] = password
            return {"library": name}

    def lock(self, name):
        with self._lock:
            name = self._require(name)
            self._close(name)
            self._keys.pop(name, None)
            return {"library": name}

    def enable_encryption(self, name, password):
        with self._lock:
            name = self._require(name)
            if self.is_encrypted(name):
                raise ValueError(f"「{name}」已经是加密的了。")
            crypto.check_new_password(password)
            self._close(name)
            crypto.encrypt_file(self._path(name), password)
            self._keys[name] = password
            return {"library": name}

    def disable_encryption(self, name, password):
        with self._lock:
            name = self._require(name)
            if not self.is_encrypted(name):
                raise ValueError(f"「{name}」没有加密。")
            self._close(name)
            crypto.decrypt_file(self._path(name), password)
            self._keys.pop(name, None)
            return {"library": name}

    def change_password(self, name, old, new):
        with self._lock:
            name = self._require(name)
            if not self.is_encrypted(name):
                raise ValueError(f"「{name}」没有加密。")
            self._close(name)
            crypto.rekey_file(self._path(name), old, new)
            self._keys[name] = new
            return {"library": name}
