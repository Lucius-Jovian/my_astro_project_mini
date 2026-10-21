"""西方占星体系。

整个文件夹可以单独交给别的组维护：它只依赖 common/（共用区），不 import 其它体系。
  astro/       本体系专用的计算（小行星、恒星、特殊点、Lot、相位）
  bridge.py    设置的默认值与校验、排盘计算的组织
  routes.py    页面和接口（/western/、/western/api/...）
  static/      western.js（本体系的前端逻辑）、chart.js（圆形星盘）、western.css
  templates/   western/index.html（页面）、western/manual.html（手册）
"""

from common.system import AstroSystem

from . import bridge, routes

SYSTEM = AstroSystem(
    id="western",
    title="西方占星",
    blueprint=routes.bp,
    settings_defaults=bridge.DEFAULT_SYSTEM_SETTINGS,
    normalize_settings=bridge.normalize_system_settings,
    bootstrap=routes.bootstrap,
    attach=routes.attach,
    order=20,
)
