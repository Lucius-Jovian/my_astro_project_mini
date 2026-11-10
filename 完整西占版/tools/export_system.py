"""把某一个占星体系连同共用区打成一个 zip，交给只维护这个体系的组。

用法：
    python tools/export_system.py vedic       → dist/quant-astro-vedic.zip
    python tools/export_system.py western     → dist/quant-astro-western.zip

包里有：app.py、requirements.txt、README.md、调用方法.txt、common/、tools/、systems/__init__.py 和 systems/<体系>/。
不包括：user_data/（档案和设置）、星历 .se1 文件、KP 数据表 .csv（体积大、或属于你们自己的数据，按需另给）。
对方拿到后直接 python app.py 就能运行，页面上只有这一个体系。
"""

from __future__ import annotations

import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIP_SUFFIXES = {".pyc", ".se1", ".csv", ".tmp"}
SKIP_DIRS = {"__pycache__", "user_data", "dist", ".git"}


def wanted(path):
    rel = path.relative_to(ROOT)
    if any(part in SKIP_DIRS for part in rel.parts):
        return False
    return path.is_file() and path.suffix not in SKIP_SUFFIXES


def main():
    systems = sorted(p.name for p in (ROOT / "systems").iterdir() if (p / "__init__.py").exists())
    if len(sys.argv) != 2 or sys.argv[1] not in systems:
        sys.exit(f"用法：python tools/export_system.py <{'|'.join(systems)}>")
    target = sys.argv[1]
    out = ROOT / "dist" / f"quant-astro-{target}.zip"
    out.parent.mkdir(exist_ok=True)
    roots = [ROOT / "common", ROOT / "tools", ROOT / "systems" / target]
    singles = [ROOT / name for name in ("app.py", "requirements.txt", "README.md", "调用方法.txt")] + [ROOT / "systems" / "__init__.py"]
    count = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in singles:
            if path.exists():
                zf.write(path, path.relative_to(ROOT))
                count += 1
        for root in roots:
            for path in sorted(root.rglob("*")):
                if wanted(path):
                    zf.write(path, path.relative_to(ROOT))
                    count += 1
    print(f"已生成 {out}（{count} 个文件）")


if __name__ == "__main__":
    main()
