"""项目里用到的几个目录。"""

from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
COMMON_DIR = BASE_DIR / "common"
SYSTEMS_DIR = BASE_DIR / "systems"
USER_DATA_DIR = BASE_DIR / "user_data"
SETTINGS_PATH = USER_DATA_DIR / "settings.json"
