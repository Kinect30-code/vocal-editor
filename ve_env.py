#!/usr/bin/env python3
"""运行环境: 路径解析 + 依赖自检。

- 路径: 源码运行 = 就在仓库里 (老行为, 不动); 打包运行 (PyInstaller/AppImage) = 只读资源在 _MEIPASS,
  可写数据 (work / projects) 放用户目录 (AppImage 是只读挂载, 写不进去)。
  可用环境变量覆盖: VE_DATA_DIR=/somewhere
- 自检: python3 ve_env.py [--strict]  或打包后 ./VocalEditor-x86_64.AppImage --check
"""
import importlib
import os
import shutil
import sys
import tempfile

FROZEN = bool(getattr(sys, "frozen", False))          # PyInstaller 打包运行
ROOT = os.path.dirname(os.path.abspath(__file__))
APP = getattr(sys, "_MEIPASS", None) or ROOT          # 只读资源 (static / demo) 所在目录


def _data_root():
    env = os.environ.get("VE_DATA_DIR")
    if env:
        return os.path.abspath(os.path.expanduser(env))
    if not FROZEN:
        return ROOT                                    # 源码运行: work/ projects/ 就在仓库
    base = os.environ.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share")
    return os.path.join(base, "vocal-editor")


DATA = _data_root()
STATIC = os.path.join(APP, "static")
DEMO = os.path.join(APP, "demo")
WORK = os.path.join(DATA, "work")
RENDER = os.path.join(WORK, "render")
INBOX = os.path.join(WORK, "inbox")
PROJDIR = os.path.join(DATA, "projects")


def ensure_dirs():
    for d in (RENDER, INBOX, PROJDIR):
        os.makedirs(d, exist_ok=True)


def user_path(p):
    """用户给的路径: 相对路径按数据目录解析 (打包后 CWD 不可控), 绝对路径照旧。"""
    p = os.path.expanduser(str(p or ""))
    if not os.path.isabs(p):
        p = os.path.join(DATA, p)
    return os.path.abspath(p)


# ---------------- 依赖自检 ----------------
MODS = [
    ("numpy", "数值计算 (DSP 基础)", True),
    ("soundfile", "读写 wav", True),
    ("pyworld", "WORLD 引擎 (推荐: 变调/接管音质最好)", False),
    ("parselmouth", "Praat PSOLA 兜底引擎", False),
    ("mido", "导入 .mid", False),
]
BINS = [
    ("ffmpeg", "导入 mp3/mp4 等压缩音频 (必需)", True),
    ("rubberband", "快速变速变调 (没有则走 PSOLA, 音质略降)", False),
]


def _mod(name):
    try:
        m = importlib.import_module(name)
        return True, str(getattr(m, "__version__", "") or "")
    except Exception as e:
        return False, str(e)[:70]


def _writable(d):
    try:
        os.makedirs(d, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=d, delete=True):
            pass
        return True, "可写"
    except Exception as e:
        return False, str(e)[:70]


def check(strict=False):
    """打印体检报告; 返回 True = 关键依赖齐全。"""
    rows, bad, warn = [], [], []
    v = sys.version_info
    py_ok = v >= (3, 9)
    rows.append(("Python ≥ 3.9", py_ok, "%d.%d.%d" % v[:3]))
    if not py_ok:
        bad.append("Python 版本过低 (需要 ≥ 3.9)")
    engine = False
    for name, label, crit in MODS:
        got, info = _mod(name)
        rows.append((label, got, info if got else ""))
        if got and name in ("pyworld", "parselmouth"):
            engine = True
        elif not got:
            (bad if crit else warn).append("缺少 %s — %s" % (name, label))
    rows.append(("音高引擎 (pyworld / parselmouth 至少一个)", engine, "已就绪" if engine else ""))
    if not engine:
        bad.append("没有任何音高引擎: uv pip install pyworld (或 praat-parselmouth)")
    for b, label, crit in BINS:
        p = shutil.which(b)
        rows.append((label, bool(p), p or ""))
        if not p:
            (bad if crit else warn).append("缺少 %s — %s" % (b, label))
    okd, dinfo = _writable(WORK)
    rows.append(("数据目录可写", okd, "%s (%s)" % (DATA, dinfo)))
    if not okd:
        bad.append("数据目录不可写: %s (可用 VE_DATA_DIR 指定别处)" % DATA)
    okp, pinfo = _writable(PROJDIR)
    rows.append(("工程目录可写", okp, "%s (%s)" % (PROJDIR, pinfo)))
    if not okp:
        bad.append("工程目录不可写: %s" % PROJDIR)
    oks, sinfo = (os.path.isfile(os.path.join(STATIC, "index.html")), STATIC)
    rows.append(("界面文件 (static/index.html)", oks, sinfo))
    if not oks:
        bad.append("找不到界面文件: %s" % sinfo)

    def w(s):   # 中文算两格, 好对齐
        return sum(2 if ord(c) > 0x2E80 else 1 for c in s)

    print("vocal-editor 环境自检" + (" (打包运行)" if FROZEN else " (源码运行)"))
    print("-" * 78)
    for label, ok, info in rows:
        print("  %s %s %s" % ("[OK]" if ok else "[!!]", label + " " * max(1, 46 - w(label)), info))
    print("-" * 78)
    if warn:
        print("警告 (不影响启动):")
        for w in warn:
            print("  - " + w)
    if bad:
        print("缺失 (会影响功能 / 无法启动):")
        for b in bad:
            print("  - " + b)
        print("\n修: uv pip install -r requirements.txt  (或 pip install numpy soundfile pyworld)")
        print("    ffmpeg/rubberband 是系统命令: apt install ffmpeg rubberband-cli")
    if not bad:
        print("关键依赖齐全, 可以启动。")
    return not bad


if __name__ == "__main__":
    sys.exit(0 if check("--strict" in sys.argv) else 2)
