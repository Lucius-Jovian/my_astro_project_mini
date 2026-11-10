"""把两个旧项目（原印度占星、原西方占星）的数据搬进合并后的新项目。

用法（在新项目文件夹里运行；先关掉新旧程序）：
    python tools/migrate_from_old.py --vedic D:\\github\\旧印占项目 --western D:\\github\\旧西占项目
    python tools/migrate_from_old.py --vedic ... --western ... --dry-run     只列出要做的事，不改任何文件

会做的事（旧项目里的文件只读，不删除、不修改）：
  1. 星历文件：旧项目 quant_astro/ephe/ 下的 .se1、ast*/ 子目录 → common/astro/ephe/
  2. KP 数据表：旧印占 quant_astro/data/sub-sub.csv → systems/vedic/astro/data/
  3. 档案库：旧项目 user_data/libraries/*.sqlite3（以及更旧版本的 user_data/people.sqlite3）
     → user_data/libraries/。两个旧项目里同名的档案库：内容相同只拷一份；内容不同时
     分别改名为「名字（印占）」「名字（西占）」。用 SQLite 的备份接口复制，运行中的 -wal 内容也会带上。
  4. 设置：旧西占的计算设置、星体配置、相位 → systems.western；旧印占的计算设置、模块开关、
     南北印度盘样式 → systems.vedic；默认地点、历法、外观、上次选中的人物 → 共用设置。

新项目如果已经开启了档案库加密：搬进来的明文档案库会在下次解锁时自动加密、删除明文。
"""

from __future__ import annotations

import argparse
import filecmp
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from common.paths import SETTINGS_PATH, USER_DATA_DIR  # noqa: E402
from common.profiles.crypto import bytes_to_plain_file, plain_file_to_bytes  # noqa: E402

EPHE_DIR = ROOT / "common" / "astro" / "ephe"
KP_DATA_DIR = ROOT / "systems" / "vedic" / "astro" / "data"
LIB_DIR = USER_DATA_DIR / "libraries"
TAGS = {"vedic": "印占", "western": "西占"}


class Plan:
    def __init__(self, dry_run):
        self.dry = dry_run
        self.lines = []

    def say(self, text):
        self.lines.append(text)
        print(text)

    def copy(self, src, dst):
        if dst.exists() and filecmp.cmp(src, dst, shallow=False):
            self.say(f"  相同，跳过：{dst.relative_to(ROOT)}")
            return
        if dst.exists():
            self.say(f"  ！已存在且内容不同，保留新项目里的：{dst.relative_to(ROOT)}（旧文件：{src}）")
            return
        self.say(f"  复制：{src} → {dst.relative_to(ROOT)}")
        if not self.dry:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)


# ---------------------------------------------------------------------- 1、2 星历和 KP 表

def migrate_files(plan, old_root, label):
    ephe = old_root / "quant_astro" / "ephe"
    if ephe.is_dir():
        plan.say(f"[{label}] 星历文件：{ephe}")
        for src in sorted(ephe.rglob("*")):
            if src.is_file():
                plan.copy(src, EPHE_DIR / src.relative_to(ephe))
    data = old_root / "quant_astro" / "data"
    if label == TAGS["vedic"] and data.is_dir():
        plan.say(f"[{label}] KP 数据表：{data}")
        for src in sorted(data.glob("*.csv")):
            plan.copy(src, KP_DATA_DIR / src.name)


# ---------------------------------------------------------------------- 3 档案库

def _old_libraries(old_root):
    found = {}
    lib_dir = old_root / "user_data" / "libraries"
    if lib_dir.is_dir():
        for path in sorted(lib_dir.glob("*.sqlite3")):
            found[path.name[: -len(".sqlite3")]] = path
    legacy = old_root / "user_data" / "people.sqlite3"
    if legacy.exists() and not found:
        found["档案库"] = legacy
    return found


def _db_bytes(path):
    # 用 SQLite 备份接口读（带上 -wal 里还没合并的内容），并去掉 WAL 标记，方便比较和写出。
    return plain_file_to_bytes(path)


def _write_db(path, data):
    bytes_to_plain_file(data, path)


def migrate_libraries(plan, sources):
    """sources: {"vedic": Path|None, "western": Path|None}。返回 {(体系, 旧名): 新名}。"""
    found = {key: _old_libraries(root) for key, root in sources.items() if root}
    names = sorted({name for libs in found.values() for name in libs}, key=str.casefold)
    renamed = {}
    plan.say("[档案库] → user_data/libraries/")
    existing = {p.name[: -len(".sqlite3")].casefold() for p in LIB_DIR.glob("*.sqlite3")} if LIB_DIR.is_dir() else set()
    for name in names:
        holders = [key for key in found if name in found[key]]
        blobs = {key: _db_bytes(found[key][name]) for key in holders}
        same = len(holders) == 2 and blobs["vedic"] == blobs["western"]
        if same:
            holders = ["western"]
        targets = {holders[0]: name} if len(holders) == 1 else {key: f"{name}（{TAGS[key]}）" for key in holders}
        for key, target in targets.items():
            final = target
            n = 2
            while final.casefold() in existing:
                final = f"{target}（{n}）"
                n += 1
            existing.add(final.casefold())
            renamed[(key, name)] = final
            plan.say(f"  {TAGS[key]}「{name}」→「{final}」")
            if not plan.dry:
                LIB_DIR.mkdir(parents=True, exist_ok=True)
                _write_db(LIB_DIR / f"{final}.sqlite3", blobs[key])
        if same:
            renamed[("vedic", name)] = renamed[("western", name)]
    return renamed


# ---------------------------------------------------------------------- 4 设置

def _read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def migrate_settings(plan, sources, renamed):
    new = _read_json(SETTINGS_PATH)
    systems = new.setdefault("systems", {})
    old_v = _read_json(sources["vedic"] / "user_data" / "settings.json") if sources.get("vedic") else {}
    old_w = _read_json(sources["western"] / "user_data" / "settings.json") if sources.get("western") else {}
    plan.say("[设置] → user_data/settings.json")
    if old_w:
        w = systems.setdefault("western", {})
        for key in ("calculation_defaults", "points", "aspects"):
            if key in old_w:
                w[key] = old_w[key]
                plan.say(f"  西占 {key}")
    if old_v:
        v = systems.setdefault("vedic", {})
        for key in ("calculation_defaults", "modules"):
            if key in old_v:
                v[key] = old_v[key]
                plan.say(f"  印占 {key}")
        style = (old_v.get("appearance") or {}).get("chart_style")
        if style in ("north", "south"):
            v["chart_style"] = style
            plan.say("  印占 chart_style")
    base = old_w or old_v
    for key in ("default_location", "birth_defaults"):
        if key in base:
            new[key] = base[key]
            plan.say(f"  共用 {key}")
    appearance = {k: v for k, v in (base.get("appearance") or {}).items() if k == "coord_format"}
    if appearance:
        new.setdefault("appearance", {}).update(appearance)
        plan.say("  共用 appearance")
    session = new.setdefault("session", {})
    last = dict(session.get("last_profile") or {})
    for key, old in (("vedic", old_v), ("western", old_w)):
        for lib, pid in ((old.get("session") or {}).get("last_profile") or {}).items():
            target = renamed.get((key, lib))
            if target and target not in last:
                last[target] = pid
        lib = (old.get("session") or {}).get("library")
        if lib and renamed.get((key, lib)) and not session.get("library"):
            session["library"] = renamed[(key, lib)]
    session["last_profile"] = last
    if not plan.dry:
        SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
        SETTINGS_PATH.write_text(json.dumps(new, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--vedic", type=Path, help="原印度占星项目的文件夹")
    parser.add_argument("--western", type=Path, help="原西方占星项目的文件夹")
    parser.add_argument("--dry-run", action="store_true", help="只列出要做的事，不改任何文件")
    args = parser.parse_args()
    if not args.vedic and not args.western:
        parser.error("至少指定 --vedic 或 --western 之一。")
    sources = {}
    for key in ("vedic", "western"):
        root = getattr(args, key)
        if root:
            root = root.expanduser().resolve()
            if not (root / "quant_astro").is_dir():
                parser.error(f"{root} 看起来不是旧项目（里面没有 quant_astro 文件夹）。")
        sources[key] = root
    plan = Plan(args.dry_run)
    if args.dry_run:
        plan.say("（试运行：不会改动任何文件）")
    for key, root in sources.items():
        if root:
            migrate_files(plan, root, TAGS[key])
    renamed = migrate_libraries(plan, sources)
    migrate_settings(plan, sources, renamed)
    plan.say("完成。" if not args.dry_run else "试运行结束。去掉 --dry-run 再运行一次即可真正搬迁。")


if __name__ == "__main__":
    main()
