"""印度占星体系。

整个文件夹可以单独交给别的组维护：它只依赖 common/（共用区），不 import 其它体系。
  astro/       本体系专用的计算（KP、Vimshottari Dasha）和数据表 data/*.csv
  bridge.py    设置的默认值与校验、排盘计算的组织
  routes.py    页面和接口（/vedic/、/vedic/api/...）
  static/      vedic.js（本体系的前端逻辑）、chart.js（南北印度盘）、vedic.css
  templates/   vedic/index.html（页面）、vedic/manual.html（手册）
"""

from common.system import AstroSystem

from . import bridge, routes

SYSTEM = AstroSystem(
    id="vedic",
    title="印度占星",
    blueprint=routes.bp,
    settings_defaults=bridge.DEFAULT_SYSTEM_SETTINGS,
    normalize_settings=bridge.normalize_system_settings,
    bootstrap=routes.bootstrap,
    attach=routes.attach,
    order=10,
)
