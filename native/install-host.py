#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""注册 Native Messaging 宿主：一次就好，写的是 HKCU，不需要管理员。

为什么必须打包成 exe：Chrome 用 CreateProcess 直接拉起 manifest 里的 path，
.bat 不是可执行映像（必须经过 cmd.exe），所以「path 指向 .bat」这条路走不通。
本机已有 PyInstaller（6.15），安装器默认会先打一个 onefile 的 xprobe-host.exe。
打包进去的是 log-sink.py、xprobe_db.py 与 xprobe_fs.py：宿主要复用同一份摘要/入库/清理逻辑，绝不抄第二份。

用法（Windows）：
  py -3 native\\install-host.py --ext-id <32位扩展ID>          # 打包 + 注册
  py -3 native\\install-host.py --ext-id <ID> --no-build       # 复用已打好的 exe
  py -3 native\\install-host.py --uninstall                    # 注销并删清单
扩展 ID 在 chrome://extensions 里本扩展那一行（开发者模式打开才看得到完整 ID）。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import winreg
from pathlib import Path

HOST_NAME = "com.yunxiao.xprobe"
HERE = Path(__file__).resolve().parent
REPO = HERE.parent
REG_KEY = r"Software\Google\Chrome\NativeMessagingHosts\%s" % HOST_NAME
EXT_RE = re.compile(r"^[a-p]{32}$")
def _find_legacy_dir():
    """Locate an older data dir (temp/xprobe) under any ancestor of this file or exe."""
    try:
        here = Path(sys.executable).resolve() if getattr(sys, "frozen", False) else Path(__file__).resolve()
    except Exception:
        return None
    for p in here.parents:
        cand = p / "temp" / "xprobe"
        try:
            if cand.is_dir():
                return cand
        except Exception:
            pass
    return None


def _default_dir() -> Path:
    # 与 log-sink.py 同一套兜底：XPROBE_DIR → 作者机器的历史目录（存在就沿用）→ ~/xprobe。别写死盘符。
    env = os.environ.get("XPROBE_DIR")
    if env:
        return Path(env)
    legacy = _find_legacy_dir()
    return legacy if legacy else Path.home() / "xprobe"


DEFAULT_DIR = _default_dir()

# log-sink.py / xprobe_db.py / xprobe_fs.py 是 --add-data 进来的**运行期**动态导入（importlib 按路径加载），
# PyInstaller 静态分析只看入口文件 ⇒ 它们用到的标准库必须自己列出来。漏一个的现场是
# 「exe 一启动就 No module named 'http'」，而打包那一步是绿的 —— 所以这里按三份源码的 import 列全。
# 漏 xprobe_fs.py 的现场更阴：exe 照样起、面板照样 sink-16，只有「清理/占用」那行说「清理模块没导入」
# —— log-sink 把它包在 try 里，缺了不炸，只降级（v0.9.2 重建时实测到）。
HIDDEN = ["argparse", "threading", "datetime", "pathlib", "hashlib", "sqlite3", "re", "shutil",
          "http", "http.server", "http.client", "socketserver",
          "urllib", "urllib.parse", "urllib.request", "urllib.error",
          "email", "email.parser", "email.utils", "email.feedparser"]


def build_exe() -> Path:
    exe = HERE / "dist" / "xprobe-host.exe"
    cmd = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile",
           "--name", "xprobe-host"]
    for m in HIDDEN:
        cmd += ["--hidden-import", m]
    cmd += ["--add-data", "%s;." % (REPO / "log-sink.py"),
            "--add-data", "%s;." % (REPO / "xprobe_db.py"),
            "--add-data", "%s;." % (REPO / "xprobe_fs.py"),
            "--distpath", str(HERE / "dist"),
            "--workpath", str(HERE / "build"),
            "--specpath", str(HERE / "build"),
            str(HERE / "xprobe_host.py")]
    print("打包：%s" % " ".join(cmd))
    r = subprocess.run(cmd, cwd=str(REPO))
    if r.returncode != 0 or not exe.exists():
        raise SystemExit("PyInstaller 打包失败（退出码 %s）。可先 `py -3 -m pip install pyinstaller` 再重试。" % r.returncode)
    return exe


def write_manifest(exe: Path, ext_id: str) -> Path:
    mf = HERE / ("%s.json" % HOST_NAME)
    obj = {"name": HOST_NAME,
           "description": "X 观测探针本机档案库宿主（只写本机 xprobe.db / logs）",
           "path": str(exe),
           "type": "stdio",
           "allowed_origins": ["chrome-extension://%s/" % ext_id]}
    mf.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    return mf


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ext-id", default="", help="chrome://extensions 里本扩展的 32 位 ID")
    ap.add_argument("--dir", default=str(DEFAULT_DIR), help="数据目录（xprobe.db 与 logs 落这里）")
    ap.add_argument("--no-build", action="store_true", help="不重新打包，直接用 native/dist/xprobe-host.exe")
    ap.add_argument("--uninstall", action="store_true")
    a = ap.parse_args()

    if a.uninstall:
        try:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, REG_KEY)
            print("已删除注册表项 HKCU\\%s" % REG_KEY)
        except FileNotFoundError:
            print("注册表项本来就不在（HKCU\\%s）" % REG_KEY)
        mf = HERE / ("%s.json" % HOST_NAME)
        if mf.exists():
            mf.unlink()
            print("已删除清单 %s" % mf)
        print("刷新扩展后，扩展会退回 HTTP 通道（双击 start-sink.bat 那种）。")
        return 0

    if not EXT_RE.match(a.ext_id or ""):
        print("扩展 ID 不对：%r。要 32 位、只用 a-p 的字母（chrome://extensions 复制完整 ID）。" % a.ext_id)
        return 2
    exe = HERE / "dist" / "xprobe-host.exe"
    if not a.no_build or not exe.exists():
        exe = build_exe()
    mf = write_manifest(exe, a.ext_id)
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, REG_KEY) as k:
        winreg.SetValueEx(k, "", 0, winreg.REG_SZ, str(mf))
    (exe.parent / "xprobe_host.json").write_text(
        json.dumps({"dir": str(Path(a.dir))}, ensure_ascii=False, indent=2), encoding="utf-8")
    print("宿主清单: %s" % mf)
    print("注册表:   HKCU\\%s -> %s" % (REG_KEY, mf))
    print("数据目录: %s" % a.dir)
    print("下一步：chrome://extensions 点本扩展的「重新加载」，再刷新 x.com 标签页。")
    # 别再手写版本号：上一版这里写死 native-1，抬了两轮没人管，装完照着这句话核对反而核不出问题。
    hv = re.search(r'^HOST_VER = "(native-\d+)"',
                   (HERE / "xprobe_host.py").read_text(encoding="utf-8"), re.M)
    print("验证：面板页脚「宿主」那截应该显示 %s。" % (hv.group(1) if hv else "（读不到 HOST_VER）"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
