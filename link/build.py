#!/usr/bin/env python3
"""PyInstaller로 데바니온 링크 실행 파일을 만듭니다.

    python -m pip install -r link/requirements.txt -r link/requirements-build.txt
    python link/build.py

결과는 link/dist/에 생깁니다. Windows는 DaevanionLink.exe 한 파일, macOS는 DaevanionLink.app입니다.
"""

import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
LINK = ROOT / "link"
DIST = LINK / "dist"
NAME = "DaevanionLink"


def arguments(platform=sys.platform):
    work = DIST / "work"
    args = [
        "--noconfirm", "--clean", "--windowed", "--name", NAME,
        "--distpath", str(DIST), "--workpath", str(work), "--specpath", str(work),
        # scripts/의 measure_cp, watch_daevanion을 이름으로 가져오므로 찾을 경로를 알려 줍니다.
        "--paths", str(LINK), "--paths", str(ROOT / "scripts"),
        # scapy는 계층 모듈을 이름으로 불러오므로 분석에 잡히지 않습니다.
        "--collect-submodules", "scapy.layers",
        "--hidden-import", "lz4.block",
    ]
    names = ROOT / "boards" / "skill-ids.json"
    if names.exists():
        # 스킬 이름을 보여 주는 데만 쓰는 표입니다. 없어도 동작합니다.
        args += ["--add-data", f"{names}{os.pathsep}boards"]
    if platform == "win32":
        args.append("--onefile")
    return args + [str(LINK / "daevanion_link.py")]


def main():
    import PyInstaller.__main__

    PyInstaller.__main__.run(arguments())
    return 0


if __name__ == "__main__":
    sys.exit(main())
