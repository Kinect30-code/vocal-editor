"""按结构标记把两首歌拼起来 (串烧) —— 确定性算法, 每一步都能单独验证。

原理 (对齐 DJ 软件的做法, 不是"硬接"):
  ① 两首都做结构分析 → 拿到 BPM、拍网格、downbeat、乐句边界、候选切点
  ② BPM 不同 → 用 rubberband 把 B **时间拉伸**到 A 的速度 (保音高; 与工程导出同一算法)
  ③ **相位对齐**: 把 B 的 downbeat 压在"A 的网格跨过接缝继续下去"的那个位置上 ——
     接缝两侧的"第 1 拍"重合, 网格才连续。**只统一 BPM 是不够的** (用户实测: BPM 拉齐了还是接不上) ✗
  ④ 两种接法:
       hard  = 小节线硬接 + 极短淡化 (消咔哒声)      ← 多数串烧剪辑的做法
       cross = 按小节等功率交叉淡化 (默认 8 小节)     ← DJ 做法; 代价是两边人声会重叠
  ⑤ 输出 WAV, 并做**接缝自检**: 接缝附近打击乐峰相对网格的相位直方图, 是否和曲中一样"尖"。
     (相位错的话, 接缝附近一定塌下来 ✗)

用法:
    python mixjoin.py <A> <B> --out work/join_demo/x.wav [--tA 秒] [--tB 秒]
                      [--mode hard|cross] [--bars 8] [--auto]
"""
import argparse
import os
import sys

import numpy as np

import analysis as A
import dsp

CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "work", "analysis")


def grid_of(path):
    """结构分析 (带缓存)。返回 (分析结果, 是否来自缓存)。"""
    r, cached = A.analyze_cached(path, CACHE)
    return r, cached


def snap_downbeat(r, t, tol=0.5):
    """把时间吸附到最近的 downbeat (分析的网格线), 保证切在小节线上。"""
    d = np.asarray(r.get("downbeats") or [], dtype=float)
    if len(d) == 0:
        return float(t), False
    i = int(np.argmin(np.abs(d - t)))
    if abs(d[i] - t) <= tol:
        return float(d[i]), True
    return float(t), False


def stretch_to(x, sr, factor):
    """时间拉伸保音高 (factor>1 = 变长/变慢)。rubberband, 与工程导出同一算法。"""
    if abs(factor - 1.0) < 1e-4:
        return x, 1.0
    return dsp.process(x, sr, semitones=0.0, stretch=float(factor)), factor


def resample_lin(x, src_sr, dst_sr):
    if src_sr == dst_sr or len(x) < 2:
        return x
    n = max(1, int(round(len(x) * dst_sr / float(src_sr))))
    return np.interp(np.linspace(0.0, len(x) - 1.0, n), np.arange(len(x)), x)


def join(pathA, pathB, out, tA=None, tB=None, mode="hard", bars=8,
         fade=0.03, auto=False, bend=None, crossfade_func=np.sin):
    """把 A 的 [0, tA] 与 B 的 [tB, end] 接起来。tA/tB 缺省时自动挑置信度最高的标记。

    返回 dict: 接缝位置/两首 BPM/是否拉伸/网格质量 等, 便于核对。
    """
    rA, cA = grid_of(pathA)
    rB, cB = grid_of(pathB)
    for tag, r in (("A", rA), ("B", rB)):
        if r.get("warning"):
            raise SystemExit("素材 %s 无法拼接: %s" % (tag, r["warning"]))
    if auto or tA is None:
        tA = sorted(rA["transitionPoints"], key=lambda x: -x["confidence"])[0]["time"]
    if auto or tB is None:
        tB = sorted(rB["transitionPoints"], key=lambda x: -x["confidence"])[0]["time"]
    tA, okA = snap_downbeat(rA, tA)
    tB, okB = snap_downbeat(rB, tB)

    xa, sr = dsp.load_mono(pathA)
    xb, srB = dsp.load_mono(pathB)
    xb = resample_lin(xb, srB, sr)

    bpmA, bpmB = float(rA["bpm"]), float(rB["bpm"])
    factor = bpmB / bpmA                     # B 快 f 倍 → 拉长 f 倍
    stretched = abs(factor - 1.0) > 5e-4
    if stretched:
        xb, _ = stretch_to(xb, sr, factor)

    ia = int(round(tA * sr))
    ib = int(round(tB * factor * sr))
    if bend is not None:                     # 只取 B 的前 bend 秒 (演示用, 免得输出过长)
        xb = xb[:ib + int(round(bend * factor * sr))]
    bar = 240.0 / bpmA                       # 一小节(4拍)在 A 的速度下的秒数
    ov = int(round(bars * bar * sr))

    if mode == "cross":
        ov = min(ov, ia, len(xb) - ib)
        if ov <= 0:
            raise SystemExit("交叉淡化长度不合法 (切点太靠边)")
        t = np.linspace(0.0, 1.0, ov)
        fout, fin = np.cos(t * np.pi / 2.0), crossfade_func(t * np.pi / 2.0)
        y = np.concatenate([xa[:ia - ov], xa[ia - ov:ia] * fout + xb[ib:ib + ov] * fin, xb[ib + ov:]])
        seam = (ia - ov + ov / 2.0) / sr
        keep_b = len(xb) - ib - ov
    else:
        nf = max(0, int(round(fade * sr)))
        segA, segB = xa[:ia].copy(), xb[ib:].copy()
        if nf > 0:
            ao = min(nf, len(segA)); bo = min(nf, len(segB))
            segA[-ao:] *= np.linspace(1.0, 0.0, ao)
            segB[:bo] *= np.linspace(0.0, 1.0, bo)
        y = np.concatenate([segA, segB])
        seam = ia / sr
        keep_b = len(segB)

    pk = float(np.abs(y).max())
    if pk > 1e-9:
        y = y / pk * 0.95                      # 轻归一, 避免削顶
    dsp.save_wav(out, y, sr)
    return {
        "out": out, "bpmA": bpmA, "bpmB": bpmB, "stretch": factor if stretched else 1.0,
        "tA": tA, "tB": tB, "snapA": okA, "snapB": okB, "mode": mode, "bars": bars,
        "seam": seam, "durA_part": ia / sr, "durB_part": keep_b / sr,
        "gridQualityA": rA.get("gridQuality"), "gridQualityB": rB.get("gridQuality"),
        "cache": (cA, cB),
    }


def seam_check(out, seam, win=8.0):
    """接缝自检: 整个文件 vs 接缝 ±win 秒 的相位直方图"峰/均值"。
    相位对齐正确时, 接缝附近应该和曲中一样尖 (掉下来就是没对齐)。"""
    x, sr = dsp.load_mono(out)
    env = A._envelopes(x, sr)
    fps = env["fps"]
    dur = len(x) / sr
    bpm, ph, ptm, f, ok = A._fit_grid(env["perc"], fps, dur)
    pk = A._pick_peaks(env["perc"], fps, min_gap=0.06, thr=0.12) / fps

    def q(t0, t1):
        w = pk[(pk >= t0) & (pk < t1)]
        if len(w) < 6:
            return None, len(w)
        h, _ = np.histogram(((w - ph) / (60.0 / bpm)) % 1.0, bins=10, range=(0, 1))
        return float(h.max()) / (float(h.mean()) + 1e-9), len(w)

    q_all, n_all = q(0, dur)
    q_seam, n_seam = q(max(0, seam - win), min(dur, seam + win))
    q_before, _ = q(max(0, seam - 32), max(0, seam - win))
    q_after, _ = q(min(dur, seam + win), min(dur, seam + 32))
    return {"bpm_out": bpm, "quality_all": q_all, "quality_seam": q_seam,
            "quality_before": q_before, "quality_after": q_after,
            "peaks_seam": n_seam, "peaks_all": n_all, "dur": dur}


def self_join(path, t1, t2, out, mode="hard", bars=8):
    """同一首歌切成 [0,t1] + [t2,end] 再接起来 (串烧剪辑/自我验证: 相位对的话听不出接缝)。"""
    return join(path, path, out, tA=t1, tB=t2, mode=mode, bars=bars)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("a"); ap.add_argument("b")
    ap.add_argument("--out", required=True)
    ap.add_argument("--tA", type=float); ap.add_argument("--tB", type=float)
    ap.add_argument("--mode", default="hard", choices=("hard", "cross"))
    ap.add_argument("--bars", type=int, default=8)
    ap.add_argument("--auto", action="store_true")
    ap.add_argument("--pick", default="", help="自检: 接缝时间(秒), 缺省用拼接点")
    a = ap.parse_args()
    info = join(a.a, a.b, a.out, tA=a.tA, tB=a.tB, mode=a.mode, bars=a.bars, auto=a.auto)
    for k, v in info.items():
        print("  %-12s %s" % (k, v))
    chk = seam_check(a.out, info["seam"])
    print("  [接缝自检] 整曲 %s | 接缝±8s %s | 接缝前 %s | 接缝后 %s | 输出 BPM %.3f" % (
        chk["quality_all"], chk["quality_seam"], chk["quality_before"], chk["quality_after"], chk["bpm_out"]))


if __name__ == "__main__":
    sys.exit(main())
