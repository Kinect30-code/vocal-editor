"""包络线工具: 把每首歌的"宏观动态包络"画出来, 供研究多曲拼接怎么切/怎么接。

数据源 = analysis.py 已经算好的【逐小节特征】(比自己重算 RMS 更准, 还自带结构上下文):
    energy          每小节 RMS 能量 (dB)
    onsetDensityNorm 节奏密度 (0~1, 已逐曲归一)
    vocalProxy      人声占比代理
    lowBand         低频/鼓能量
叠加: downbeat 网格 / transitionPoints(过渡点, 按置信度红橙黄着色) / phrases·sections 阴影。

另外把包络数据落盘成 <name>.env.json, 后续拼接可直接拿来做"按能量/密度匹配切点"。

用法:
    python envelope.py <音频1> [音频2 ...] [--out DIR] [--no-overlay]
单首 → 多面板包络图; 多首 → 额外生成跨曲叠加对比图(归一化能量+节奏密度)。
"""
import argparse
import json
import os
import sys

import numpy as np

import analysis as A
import dsp

CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "work", "analysis")
HERE = os.path.dirname(os.path.abspath(__file__))

matplotlib = None


def _ensure_mpl():
    global matplotlib
    if matplotlib is None:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        import matplotlib.font_manager as fm
        cjk = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
        if os.path.isfile(cjk):
            try:
                fm.fontManager.addfont(cjk)
                plt.rcParams["font.family"] = ["Noto Sans CJK SC", "DejaVu Sans"]
            except Exception:
                pass
        plt.rcParams["axes.unicode_minus"] = False
        globals()["plt"] = plt
    return globals().get("plt")


def bar_arrays(r):
    """从分析结果抽取逐小节时间对齐的包络数组。返回 dict(时间, 各特征, 结构)。"""
    f = r.get("features", {})
    t = np.asarray(f.get("barTimes") or [], dtype=float)
    out = {
        "t": t,
        "energy": np.asarray(f.get("energy") or [], dtype=float),
        "dens": np.asarray(f.get("onsetDensityNorm") or [], dtype=float),
        "vocal": np.asarray(f.get("vocalProxy") or [], dtype=float),
        "low": np.asarray(f.get("lowBand") or [], dtype=float),
        "downbeats": np.asarray(r.get("downbeats") or [], dtype=float),
        "trans": r.get("transitionPoints") or [],
        "phrases": r.get("phrases") or [],
        "sections": r.get("sections") or [],
        "bpm": float(r.get("bpm", 0.0)),
        "ppb": int(r.get("ppb", 4)),
        "duration": float(r.get("duration", 0.0)),
        "warning": r.get("warning"),
    }
    return out


def rms_fallback(path):
    """分析失败(无稳定节拍)时的兜底: 直接算 ~0.5s 一帧的 RMS 包络。"""
    x, sr = dsp.load_mono(path)
    fps = 2.0
    hop = int(sr / fps)
    n = len(x)
    nf = max(1, n // hop)
    env = np.array([np.sqrt(np.mean(x[i * hop:(i + 1) * hop] ** 2)) for i in range(nf)])
    env = env / (env.max() + 1e-9)
    t = np.arange(nf) / fps
    return {
        "t": t, "energy": env, "dens": env, "vocal": env * 0.0 + 0.5,
        "low": env, "downbeats": np.array([]), "trans": [], "phrases": [],
        "sections": [], "bpm": 0.0, "ppb": 4, "duration": n / sr,
        "warning": "无稳定节拍 → 用 RMS 兜底包络",
    }


def load_envelope(path):
    r, cached = A.analyze_cached(path, CACHE)
    if r.get("warning") and not r.get("bars"):
        return rms_fallback(path), cached
    return bar_arrays(r), cached


def _conf_color(c):
    if c >= 0.85:
        return "#ff3b30"
    if c >= 0.60:
        return "#ff9500"
    if c >= 0.40:
        return "#ffcc00"
    return "#8e8e93"


def plot_song(path, out_png):
    e, cached = load_envelope(path)
    plt = _ensure_mpl()
    name = os.path.splitext(os.path.basename(path))[0]

    if e["warning"] and len(e["energy"]) == 0:
        fig, ax = plt.subplots(figsize=(12, 2.2))
        ax.text(0.5, 0.5, "无法生成包络: %s" % e["warning"], ha="center", va="center")
        fig.savefig(out_png, dpi=110, bbox_inches="tight")
        plt.close(fig)
        return e, cached

    t = e["t"]
    fig, axs = plt.subplots(4, 1, figsize=(13, 9), sharex=True)
    fig.suptitle("%s  |  BPM %.1f  |  %d 小节  |  时长 %.1fs  |  缓存=%s"
                 % (name, e["bpm"], len(t), e["duration"], "Y" if cached else "N"),
                 fontsize=13, y=0.995)

    panels = [
        ("能量 energy (dB)", e["energy"], "#1f77b4", "fill"),
        ("节奏密度 onsetDensityNorm (0~1)", e["dens"], "#2ca02c", "line"),
        ("人声占比 vocalProxy", e["vocal"], "#9467bd", "line"),
        ("低频/鼓 lowBand", e["low"], "#d62728", "fill"),
    ]
    for ax, (title, y, color, kind) in zip(axs, panels):
        if kind == "fill":
            ax.fill_between(t, y, color=color, alpha=0.35)
            ax.plot(t, y, color=color, lw=1.0)
        else:
            ax.plot(t, y, color=color, lw=1.2)
        ax.set_ylabel(title, fontsize=9)
        ax.grid(alpha=0.25)

    # 结构叠加: 仅画在最上方面板, 用两个 ax 透明叠放更清晰 -> 简单起见画在所有面板
    for ax in axs:
        # downbeat 网格 (每 4 拍一条主小节线, 这里 downbeats 已是每小节起点)
        for d in e["downbeats"]:
            ax.axvline(d, color="#000000", lw=0.25, alpha=0.18)
    # transitionPoints 标在最上面板
    for tr in e["trans"]:
        c = _conf_color(tr.get("confidence", 0.0))
        axs[0].scatter([tr["time"]], [axs[0].get_ylim()[1]], color=c, s=18, zorder=5)
    # phrases / sections 阴影 (画在能量面板)
    for p in e["phrases"]:
        axs[0].axvspan(p["start"], p["end"], color="#888888", alpha=0.10)
    for s in e["sections"]:
        axs[0].axvspan(s["start"], s["end"], color="#4444aa", alpha=0.06)
    axs[3].set_xlabel("时间 (秒)")
    fig.savefig(out_png, dpi=110, bbox_inches="tight")
    plt.close(fig)
    return e, cached


def plot_overlay(paths, out_png):
    """把多首歌的归一化能量 + 节奏密度叠在同一时间轴, 直接看密度差/能量错位。"""
    plt = _ensure_mpl()
    fig, axs = plt.subplots(2, 1, figsize=(13, 7), sharex=True)
    labels = []
    for p in paths:
        e, _ = load_envelope(p)
        name = os.path.splitext(os.path.basename(p))[0]
        labels.append(name)
        t = e["t"]
        en = e["energy"]
        en = (en - en.min()) / (en.max() - en.min() + 1e-9) if len(en) else t * 0
        dn = e["dens"]
        dn = (dn - dn.min()) / (dn.max() - dn.min() + 1e-9) if len(dn) else t * 0
        axs[0].plot(t, en, lw=1.3, label=name)
        axs[1].plot(t, dn, lw=1.3, label=name)
    axs[0].set_title("归一化能量包络 (跨曲对比) — 看能量错位/落差")
    axs[1].set_title("归一化节奏密度 (跨曲对比) — 看节奏密度差")
    axs[0].legend(fontsize=8, loc="upper right")
    axs[1].legend(fontsize=8, loc="upper right")
    for ax in axs:
        ax.grid(alpha=0.25)
        ax.set_ylabel("0~1")
    axs[1].set_xlabel("时间 (秒)")
    fig.savefig(out_png, dpi=110, bbox_inches="tight")
    plt.close(fig)


def save_env_json(path, e, out_dir):
    name = os.path.splitext(os.path.basename(path))[0]
    d = {
        "name": name, "bpm": e["bpm"], "ppb": e["ppb"], "duration": e["duration"],
        "t": e["t"].tolist(), "energy": e["energy"].tolist(),
        "onsetDensityNorm": e["dens"].tolist(), "vocalProxy": e["vocal"].tolist(),
        "lowBand": e["low"].tolist(), "downbeats": e["downbeats"].tolist(),
        "transitions": [{"time": tr["time"], "confidence": tr.get("confidence", 0.0),
                         "type": tr.get("type", "")} for tr in e["trans"]],
        "warning": e["warning"],
    }
    fp = os.path.join(out_dir, name + ".env.json")
    with open(fp, "w", encoding="utf-8") as fo:
        json.dump(d, fo, ensure_ascii=False)
    return fp


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="+")
    ap.add_argument("--out", default=os.path.join(HERE, "work", "envelope"))
    ap.add_argument("--no-overlay", action="store_true")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    pngs = []
    for p in a.paths:
        png = os.path.join(a.out, os.path.splitext(os.path.basename(p))[0] + ".png")
        e, cached = plot_song(p, png)
        jf = save_env_json(p, e, a.out)
        print("  %-40s 缓存=%s 小节=%d 警告=%s" % (os.path.basename(p), "Y" if cached else "N",
                                                    len(e["t"]), e["warning"] or "无"))
        print("    图: %s" % png)
        print("    数: %s" % jf)
        pngs.append(png)
    if len(a.paths) > 1 and not a.no_overlay:
        ov = os.path.join(a.out, "overlay.png")
        plot_overlay(a.paths, ov)
        print("  跨曲叠加: %s" % ov)
        pngs.append(ov)
    return pngs


if __name__ == "__main__":
    main()
