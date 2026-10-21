"""占星体系的挂接接口。

每个体系是 systems/ 下的一个文件夹（Python 包），在 __init__.py 里提供一个 SYSTEM 对象。
程序启动时自动扫描 systems/ 下的所有文件夹并挂上去，所以：
  - 加一个体系 = 放进一个新文件夹；
  - 去掉一个体系 = 删掉它的文件夹（其它体系和共用部分不受影响）；
  - 只把某一个体系交给别的组：给他们 common/、app.py 和 systems/ 下那一个文件夹即可。

一个体系的所有东西（计算、设置、接口、页面、JS、CSS、手册）都在它自己的文件夹里，
只依赖 common/，体系之间互不 import。
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass, field
from typing import Callable

from flask import Blueprint

from .paths import SYSTEMS_DIR


@dataclass
class AstroSystem:
    id: str                                  # 网址和设置里用的名字，如 "vedic"
    title: str                               # 页面上显示的名字，如 "印度占星"
    blueprint: Blueprint                     # 这个体系的页面和接口，挂在 /<id>/ 下
    settings_defaults: dict                  # settings.json → systems.<id> 的默认值
    normalize_settings: Callable | None      # 读设置时的整理函数
    bootstrap: Callable                      # bootstrap(store) -> {"settings": {...}, "options": {...}}
    attach: Callable                         # attach(store, libraries)：启动时把共用对象交给体系
    order: int = 100                         # 顶部切换按钮的顺序
    extra: dict = field(default_factory=dict)

    @property
    def url(self):
        return f"/{self.id}/"

    @property
    def api(self):
        return f"/{self.id}/api"


def discover_systems():
    found = []
    if not SYSTEMS_DIR.is_dir():
        return found
    for folder in sorted(SYSTEMS_DIR.iterdir()):
        if not folder.is_dir() or folder.name.startswith(("_", ".")) or not (folder / "__init__.py").exists():
            continue
        module = importlib.import_module(f"systems.{folder.name}")
        system = getattr(module, "SYSTEM", None)
        if not isinstance(system, AstroSystem):
            raise RuntimeError(f"systems/{folder.name}/__init__.py 里没有 SYSTEM（AstroSystem）。")
        found.append(system)
    found.sort(key=lambda s: (s.order, s.id))
    return found
