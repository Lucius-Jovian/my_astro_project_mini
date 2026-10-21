"""Quant Astro 本地排盘：印度占星 + 西方占星，共用一套人物档案。

启动：python app.py，浏览器打开 http://127.0.0.1:5300/（端口以 user_data/settings.json 的 server.port 为准）。

目录：
  common/          共用区：天文基础（星历、宫位、日出日落）、人物档案（前后端）、设置、页面外壳
  systems/vedic/   印度占星（KP、Vimshottari Dasha、南北印度盘）
  systems/western/ 西方占星（小行星、恒星、Lot、相位、圆形星盘）
  user_data/       设置和档案库（不属于代码，备份时连同它一起备份）

systems/ 下的体系是自动发现的：删掉某个体系的文件夹，程序照常运行，只是少了那个体系。
"""

from __future__ import annotations

from flask import Flask

from common.paths import COMMON_DIR, SETTINGS_PATH, USER_DATA_DIR
from common.profiles import ProfileLibraries, create_blueprint
from common.settings import SHARED_DEFAULTS, SettingsStore
from common.shell import init_shell
from common.system import discover_systems


def create_app():
    USER_DATA_DIR.mkdir(parents=True, exist_ok=True)

    app = Flask(
        __name__,
        template_folder=str(COMMON_DIR / "templates"),
        static_folder=str(COMMON_DIR / "static"),
        static_url_path="/static",
    )
    app.config["JSON_AS_ASCII"] = False
    # Flask 默认会把返回的 JSON 的键按字母序重排：行星、宫头的顺序就全乱了。关掉后行序 = 后端的计算顺序。
    app.json.sort_keys = False

    systems = discover_systems()
    store = SettingsStore(SETTINGS_PATH)
    for system in systems:
        store.register_system(system.id, system.settings_defaults, system.normalize_settings)
    store.load()

    # 档案库：每套档案一个 SQLite 文件（user_data/libraries/），两个体系共用。
    libraries = ProfileLibraries(USER_DATA_DIR)
    libraries.select((store.data.get("session") or {}).get("library") or "")

    app.register_blueprint(create_blueprint(libraries, store))
    app.register_blueprint(init_shell(store, libraries, systems))
    for system in systems:
        system.attach(store, libraries)
        app.register_blueprint(system.blueprint, url_prefix=f"/{system.id}")

    app.extensions["astro"] = {"store": store, "libraries": libraries, "systems": systems}
    return app


app = create_app()


if __name__ == "__main__":
    server = app.extensions["astro"]["store"].data.get("server", {})
    app.run(
        host=str(server.get("host", SHARED_DEFAULTS["server"]["host"])),
        port=int(server.get("port", SHARED_DEFAULTS["server"]["port"])),
        debug=False,
        use_reloader=False,
        threaded=True,
    )
