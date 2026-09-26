"""音乐结构分析 —— 确定性信号分析, 只用 numpy (不引入 librosa/madmom 等重依赖)。

流程 (自上而下, 每一步都能单独看/单独验):
    音频 → STFT → 谱流量 onset 包络 → 节拍(DP 节拍跟踪) → downbeat 相位 → 小节
         → 逐小节特征(onset密度 / 重音模式 / 能量 / 谱流量 / 人声带代理)
         → 边界新颖度 → 乐句 → 过渡点 + 分项分数

设计原则 (与需求 §21 一致): 不是"AI 听完告诉你哪里剪", 而是
**信号 → 数学特征 → 结构边界 → 可视化标记**, 结果确定、可解释、可复现。

输出 JSON 见 analyze() 的 docstring。
"""
import hashlib
import json
import os

import numpy as np

ANALYSIS_VER = 1          # 算法版本: 变更时递增, 缓存据此失效
SR = 22050                # 分析采样率 (远低于工程 44.1k, 分析不需要那么细)
N_FFT = 2048
HOP = 512
PPB = 4                   # 每小节拍数 (先按 4/4, 全曲统一)


# ---------------------------------------------------------------- 载入 / STFT
def _load_mono(path, sr=SR):
    """读单声道 + 线性重采样到分析采样率。"""
    import soundfile as sf
    x, xsr = sf.read(path, always_2d=True, dtype="float32")
    x = x.mean(axis=1)
    if xsr != sr and len(x) > 1:
        n = max(1, int(round(len(x) * sr / float(xsr))))
        x = np.interp(np.linspace(0.0, len(x) - 1.0, n), np.arange(len(x)), x).astype(np.float32)
    return x, sr


def _stft_mag(x, n_fft=N_FFT, hop=HOP):
    """幅度谱 (帧 × 频点)。短音频补零到一帧。"""
    win = np.hanning(n_fft).astype(np.float32)
    if len(x) < n_fft:
        x = np.pad(x, (0, n_fft - len(x)))
    nf = 1 + (len(x) - n_fft) // hop
    idx = np.arange(n_fft)[None, :] + hop * np.arange(nf)[:, None]
    frames = x[idx] * win
    return np.abs(np.fft.rfft(frames, axis=1)).astype(np.float32)


def _smooth(o, w):
    """移动平均 (same 长度)。"""
    w = max(1, int(w))
    if w <= 1:
        return o.copy()
    k = np.ones(w, dtype=np.float32) / w
    return np.convolve(o, k, mode="same").astype(np.float32)


def _norm01(a):
    a = np.asarray(a, dtype=np.float32)
    lo, hi = float(a.min()), float(a.max())
    return (a - lo) / (hi - lo) if hi - lo > 1e-9 else np.zeros_like(a)


# ---------------------------------------------------------------- 特征包络
def _envelopes(x, sr):
    """返回 (onset包络, 低频包络(鼓), 人声带包络, 逐帧rms, 逐帧谱流量)。"""
    S = _stft_mag(x)
    fps = sr / float(HOP)
    freqs = np.fft.rfftfreq(N_FFT, 1.0 / sr)
    # onset: 对数压缩后的谱流量 (对绝对音量不敏感, 保留瞬态)
    Sdb = np.log1p(1000.0 * S)
    d = np.diff(Sdb, axis=0, prepend=Sdb[:1])
    flux_frame = np.maximum(0.0, d).sum(axis=1)
    oenv = np.maximum(0.0, flux_frame - _smooth(flux_frame, int(round(fps * 1.0))))
    oenv = oenv / (oenv.max() + 1e-9)

    lo_m = freqs < 200.0
    hi_m = (freqs >= 3200.0) & (freqs < 8000.0)
    vo_m = (freqs >= 300.0) & (freqs < 3400.0)
    band_lo = S[:, lo_m].sum(axis=1)
    band_hi = S[:, hi_m].sum(axis=1)
    band_vo = S[:, vo_m].sum(axis=1)
    total = S.sum(axis=1) + 1e-9

    # 低频/高频/人声带的"攻击性" = 该带的谱流量, 再归一
    def band_flux(b):
        bd = np.maximum(0.0, np.diff(np.log1p(1000.0 * b), prepend=np.log1p(1000.0 * b[:1])))
        bd = np.maximum(0.0, bd - _smooth(bd, int(round(fps * 1.0))))
        return (bd / (bd.max() + 1e-9)).astype(np.float32)

    rms = np.sqrt((S ** 2).sum(axis=1) / float(N_FFT) ** 2).astype(np.float32)
    # 底鼓频段(40~120Hz)能量: downbeat 判定的主证据 (低音鼓/贝斯在"1"上最实)
    kick_m = (freqs >= 40.0) & (freqs < 120.0)
    kick = S[:, kick_m].sum(axis=1)
    kick = (kick / (np.percentile(kick, 95) + 1e-9)).astype(np.float32)
    # 中频(军鼓体 150~400Hz)能量: 反拍军鼓 + 小节线"能量上跳"判相的主线索 (实测判别力 6.1 倍)
    mid_m = (freqs >= 150.0) & (freqs < 400.0)
    midb = S[:, mid_m].sum(axis=1)
    midb = (midb / (np.percentile(midb, 95) + 1e-9)).astype(np.float32)
    # 十二平均律色度(chroma): 和声/编排在小节线上变化最大 → 相位自相似用
    fp = freqs[1:]
    valid = fp > 55.0
    midi = np.round(69 + 12 * np.log2(np.maximum(fp[valid], 1e-6) / 440.0)).astype(np.int64)
    pc = np.mod(midi, 12)
    chroma_map = np.zeros((len(fp), 12), dtype=np.float32)
    idx = np.flatnonzero(valid)
    for k, p_ in zip(idx, pc):
        chroma_map[k, p_] = 1.0
    chroma = S[:, 1:] @ chroma_map                      # (nf, 12)
    chroma = chroma / (np.linalg.norm(chroma, axis=1, keepdims=True) + 1e-9)
    return {
        "fps": fps,
        "onset": oenv.astype(np.float32),
        "lo": band_flux(band_lo),          # 低音/底鼓攻击 → downbeat 证据
        "hi": band_flux(band_hi),          # 镲/齿音
        "vocal": band_flux(band_vo),       # 人声带代理(不是分离出来的 stem, 见 README)
        "vocalRatio": (band_vo / total).astype(np.float32),
        "rms": rms,
        "flux": flux_frame.astype(np.float32),
        "kick": kick,
        "mid": midb,
        "perc": _perc_envelope({"fps": fps}, S, freqs),
        "chroma": chroma.astype(np.float32),
    }


# ---------------------------------------------------------------- 节拍
def _tempo_period(oenv, fps):
    """自相关 + 对数正态先验 → 每拍帧数。"""
    o = oenv - oenv.mean()
    ac = np.correlate(o, o, mode="full")[len(o) - 1:]
    ac = ac / (ac[0] + 1e-9)
    lag_lo = max(2, int(round(fps * 60.0 / 220.0)))     # 220 BPM
    lag_hi = min(len(ac) - 1, int(round(fps * 60.0 / 50.0)))   # 50 BPM
    if lag_hi <= lag_lo:
        return max(2.0, fps * 0.5)
    lags = np.arange(lag_lo, lag_hi + 1)
    bpm = 60.0 * fps / lags
    prior = np.exp(-0.5 * ((np.log2(bpm / 120.0)) / 0.9) ** 2)
    return float(lags[int(np.argmax(ac[lag_lo:lag_hi + 1] * prior))])


def _perc_envelope(env, S, freqs):
    """打击乐权重包络: 底鼓带 + 军鼓带 + 镲带的流量之和。
    节拍网格要靠**打击乐**对齐, 不能用人声/旋律的 onset (那些不在拍上)。"""
    def fl(mask):
        b = S[:, mask].sum(axis=1)
        d = np.maximum(0.0, np.diff(np.log1p(1000.0 * b), prepend=np.log1p(1000.0 * b[:1])))
        d = np.maximum(0.0, d - _smooth(d, int(round(env["fps"]))))
        return d / (d.max() + 1e-9)
    p = (1.0 * fl((freqs >= 40) & (freqs < 150)) +
         0.8 * fl((freqs >= 150) & (freqs < 400)) +
         0.4 * fl(freqs >= 6000))
    return (p / (p.max() + 1e-9)).astype(np.float32)


def _phase_metrics(peak_t, bpm):
    """强打击乐峰的"拍内相位"直方图 → (峰均值比, 最优相位偏移)。

    **峰均值比** 是判"这个 BPM/相位对不对"的硬指标, 实测能一刀切开真假:
      真歌: 姑娘(128BPM)=3.93, imp_5f8b=4.60, 6b0c(160BPM)=4.70 ✓
      纯人声 哈基米=1.28 ✗, 渲染片段 73da879f=1.37 ✗ → <2.0 直接拒答
    必须用**全部峰**算 (踩过的坑: 先按拟合度筛峰再算, 任何网格都会"看起来对齐" ✗)。
    它同时天然排除半速: 半速时峰会裂成 0/0.5 两簇 → 最强格下降 → 比值掉下来 ✓
    """
    per = 60.0 / bpm
    ph = (peak_t / per) % 1.0
    h, _ = np.histogram(ph, bins=10, range=(0.0, 1.0))
    if h.sum() < 12:
        return 0.0, 0.0
    ptm = float(h.max()) / (float(h.mean()) + 1e-9)
    k = int(np.argmax(h))
    lo, hi = k / 10.0, (k + 1) / 10.0
    sel = (ph >= lo) & (ph < hi)
    if sel.sum() >= 4:
        c = float(np.angle(np.exp(1j * (ph[sel] * 2 * np.pi)).mean())) / (2 * np.pi)
        if c < 0:
            c += 1.0
        fine = c if lo <= c < hi else lo + 0.05
    else:
        fine = lo + 0.05
    return ptm, float((fine % 1.0) * per)


def _fit_grid(perc, fps, dur, lo_bpm=60.0, hi_bpm=200.0, tol_sec=0.07):
    """**全局节拍网格拟合** → (bpm, 相位, 质量, F值, 是否可信)。

    为什么必须这么做(踩坑留档): 老实现"自相关定周期 + 先验" → 报 129.199 而真值约 128.0, 差 1%,
    260 秒漂 5 拍, 拍内相位直方图完全均匀(等于随机) ✗ → 小节/乐句/标记全错 → 用户体感"接不上"。
    现在: 在 BPM/相位上做粗到细搜索, 目标 = 相位直方图峰均值比 × 轻度先验(压 70 以下的半速陷阱)。
    质量 < 2.0 = 检测不到稳定节拍(纯人声/自由速度/渲染片段) → 上层直接拒答, 不再硬给标记 ✓
    """
    peak_t = _pick_peaks(perc, fps, min_gap=0.06, thr=0.12) / fps
    if len(peak_t) < 20:
        return 0.0, 0.0, 0.0, 0.0, False

    def prior(b):
        return float(np.exp(-0.5 * ((np.log2(b / 124.0)) / 0.55) ** 2)) * (1.0 if b >= 70.0 else 0.30)

    def score(b):
        ptm, ph = _phase_metrics(peak_t, b)
        return ptm * prior(b), ptm, ph

    best = None
    for b in np.arange(lo_bpm, hi_bpm, 0.25):
        sc, ptm, ph = score(b)
        if best is None or sc > best[0]:
            best = (sc, b, ptm, ph)
    for span, step in ((0.6, 0.02), (0.05, 0.002)):      # 两轮精修
        b0 = best[1]
        for b in np.arange(max(lo_bpm, b0 - span), min(hi_bpm, b0 + span) + 1e-9, step):
            sc, ptm, ph = score(b)
            if sc > best[0]:
                best = (sc, b, ptm, ph)
    _, bpm, ptm, ph = best

    def nearest(a, b):
        j = np.searchsorted(b, a)
        i0 = np.clip(j - 1, 0, len(b) - 1)
        i1 = np.clip(j, 0, len(b) - 1)
        return np.minimum(np.abs(b[i0] - a), np.abs(b[i1] - a))

    grid = np.arange(ph, dur, 60.0 / bpm)
    f = 0.0
    if len(grid) >= 8:
        prec = float((nearest(grid, peak_t) <= tol_sec).mean())
        rec = float((nearest(peak_t, grid) <= tol_sec).mean())
        f = 0.0 if prec + rec <= 0 else 2 * prec * rec / (prec + rec)
    return float(bpm), float(ph), float(ptm), float(f), bool(ptm >= 2.0)


def _dp_beats(oenv, fps, period, tightness=100.0):
    """Ellis 2007 动态规划节拍跟踪: 在 onset 包络上找一条准周期路径, 允许速度微漂移。"""
    sigma = max(1.0, period / 32.0)
    rad = int(3 * sigma)
    g = np.exp(-0.5 * (np.arange(-rad, rad + 1) / sigma) ** 2)
    local = np.convolve(oenv, g / g.sum(), mode="same")

    n = len(local)
    cum = local.astype(np.float64).copy()
    back = -np.ones(n, dtype=np.int64)
    lo_w = max(1, int(round(period / 2.0)))
    hi_w = max(lo_w + 1, int(round(period * 2.0)))
    for t in range(n):
        a, b = max(0, t - hi_w), t - lo_w
        if b < a:
            continue
        ps = np.arange(a, b + 1)
        dts = (t - ps).astype(np.float64)
        pen = -tightness * (np.log(dts / period) ** 2)
        cand = cum[ps] + pen
        k = int(np.argmax(cand))
        cum[t] = local[t] + cand[k]
        back[t] = ps[k]
    if n == 0:
        return np.array([], dtype=np.int64)
    tail = max(0, n - hi_w)
    t = int(np.argmax(cum[tail:]) + tail)
    out = []
    while t >= 0:
        out.append(t)
        t = int(back[t])
    return np.array(out[::-1], dtype=np.int64)


def _beat_f(oenv, beat_idx, fps, tol=0.12):
    """拍点 vs onset 峰的 F1 —— 用来判"八度错误"。
    节拍太快 → 很多拍点附近没有 onset (precision 掉); 太慢 → 很多 onset 没被解释 (recall 掉)。
    所以这个指标在正确速度上最高, 能自动挑对 P/2、P、2P。"""
    peaks = _pick_peaks(oenv, fps, min_gap=0.05, thr=0.08)
    if len(peaks) == 0 or len(beat_idx) < 2:
        return 0.0
    step = float(np.median(np.diff(beat_idx)))
    tf = max(1.0, tol * step)
    b = beat_idx.astype(np.float64)
    p = peaks.astype(np.float64)
    ins = np.searchsorted(p, b)
    p0 = np.clip(ins - 1, 0, len(p) - 1)
    p1 = np.clip(ins, 0, len(p) - 1)
    dp = np.minimum(np.abs(p[p0] - b), np.abs(p[p1] - b))
    precision = float((dp <= tf).mean())
    ins2 = np.searchsorted(b, p)
    q0 = np.clip(ins2 - 1, 0, len(b) - 1)
    q1 = np.clip(ins2, 0, len(b) - 1)
    db = np.minimum(np.abs(b[q0] - p), np.abs(b[q1] - p))
    recall = float((db <= tf).mean())
    return 0.0 if precision + recall <= 0 else 2 * precision * recall / (precision + recall)


def _downbeat_phase(env, bidx, ppb=PPB):
    """4/4 下选"第 1 拍"相位。

    试过的失败判据(留档, 别回头): onset/低音**流量**均值 → 标记处强度只有平均拍 1.14 倍, 等随机;
    全曲底鼓/军鼓**绝对值**均值 → 主歌副歌鼓型不同, 平均即洗掉 ✗; 全带/低音带 chroma 变化 → 1.29/1.89 倍, 偏弱。

    真正管用的是**"能量上跳"**: 每拍取 军鼓带/低频带/底鼓 的能量均值, 再看它相对上一拍涨了多少;
    小节第 1 拍(整拍最满)涨幅最大。实测判别力 **6.1 倍 / 5.8 倍**, 且两首歌都指向与鼓型一致的那个相位 ✓
    """
    nframes = len(env["onset"])
    n = len(bidx)
    if n < ppb * 2:
        return 0, 0.0, 0.0
    fps = env["fps"]
    def beat_mean(e):
        out = np.zeros(n)
        for i in range(n):
            a = max(0, int(round(bidx[i])))
            z = int(round(bidx[i + 1])) if i + 1 < n else a + int(round(fps * 0.4))
            z = max(a + 1, min(z, nframes))
            out[i] = float(e[a:z].mean())
        return out
    # 军鼓带上升是主判据 (单独用判别力 6.1/5.8 倍); 低频/底鼓只做同分兜底 ——
    # 混进 0.6/0.6 权重会把判别力稀释到 2.1 倍 ✗, 所以这里只给 0.15
    rise = (1.00 * beat_mean(env["mid"]) +
            0.15 * beat_mean(env["lo"]) +
            0.15 * beat_mean(env["kick"]))
    rise = np.maximum(0.0, np.diff(rise, prepend=rise[:1]))     # 相对上一拍的"上跳"
    scores = [float(rise[ph::ppb].mean()) if len(rise[ph::ppb]) else 0.0 for ph in range(ppb)]
    best = int(np.argmax(scores))
    srt = sorted(scores, reverse=True)
    strength = (srt[0] / (srt[1] + 1e-9)) if len(srt) > 1 else 1.0
    return best, float(scores[best]), float(strength)


def _snap_onset(t, oenv, fps, win=0.045, maxback=5):
    """把时间吸附到最近起音的**攻击起点**: 找到附近最强的 onset 峰, 再顺着上升沿回退到起点。
    切在攻击起点上, 下一首歌的重拍起音才完整保留 (切在峰上会把起音切掉一半)。
    关键: 回退必须**顺着上升沿**(seg[j-1] < seg[j]), 不能按阈值瞎退 ——
    按阈值退会一路退进静音里 (实测标记落到 onset≈0.008 的位置 ✗), 反而更接不上。"""
    if len(oenv) < 3:
        return t
    c = int(round(t * fps))
    a = max(0, c - int(round(win * fps)))
    b = min(len(oenv) - 1, c + int(round(win * fps)))
    if b <= a:
        return t
    seg = oenv[a:b + 1]
    k = int(np.argmax(seg))
    if seg[k] < 0.06:                      # 附近没什么起音 → 保持原样 (改也是瞎改)
        return t
    j = k
    steps = 0
    while j > 0 and steps < maxback and seg[j - 1] < seg[j]:
        j -= 1
        steps += 1
    return (a + j) / fps


# ---------------------------------------------------------------- 逐小节特征
def _bar_features(env, bars):
    """每个小节的: onset 密度 / 重音 4 向量 / 能量 / 谱流量 / 人声代理 / 低音比例。"""
    fps = env["fps"]
    onset, lo, vo, rms, flux = env["onset"], env["lo"], env["vocal"], env["rms"], env["flux"]
    vocalRatio = env["vocalRatio"]
    peaks = _pick_peaks(onset, fps)
    out = []
    for b in bars:
        i0 = max(0, int(round(b["start"] * fps)))
        i1 = min(len(onset), max(i0 + 1, int(round(b["end"] * fps))))
        seg = slice(i0, i1)
        nb = int((peaks >= i0).sum() - (peaks >= i1).sum())
        accent = []
        nbeat = max(1, PPB)
        for k in range(nbeat):
            j0 = i0 + int(round((i1 - i0) * k / nbeat))
            j1 = i0 + int(round((i1 - i0) * (k + 1) / nbeat))
            j1 = max(j0 + 1, j1)
            a = onset[j0:j1].max() if j1 > j0 else 0.0
            accent.append(float(a))
        r = float(np.sqrt(np.mean(rms[seg] ** 2))) if i1 > i0 else 0.0
        out.append({
            "i": b["i"], "start": b["start"], "end": b["end"],
            "onsetCount": float(nb),
            "onsetDensity": float(nb) / max(1e-6, (b["end"] - b["start"])),
            "accent": accent,
            "energy": 20.0 * np.log10(r + 1e-6),
            "flux": float(flux[seg].mean()) if i1 > i0 else 0.0,
            "vocal": float(vo[seg].mean()) if i1 > i0 else 0.0,
            "vocalRatio": float(vocalRatio[seg].mean()) if i1 > i0 else 0.0,
            "lo": float(lo[seg].mean()) if i1 > i0 else 0.0,
            "chroma": float(np.abs(env["chroma"][seg][1:] - env["chroma"][seg][:-1]).sum(axis=1).mean()) if i1 > i0 + 1 else 0.0,
        })
    return out


def _pick_peaks(env, fps, min_gap=0.06, thr=0.10):
    """onset 包络上的峰值帧 (局部最大 + 阈值 + 最小间隔)。返回帧号数组。"""
    if len(env) < 3:
        return np.array([], dtype=np.int64)
    m = np.zeros(len(env), dtype=bool)
    m[1:-1] = (env[1:-1] >= env[:-2]) & (env[1:-1] > env[2:]) & (env[1:-1] > thr)
    idx = np.flatnonzero(m)
    if len(idx) == 0:
        return idx
    gap = max(1, int(round(min_gap * fps)))
    keep = [idx[0]]
    for i in idx[1:]:
        if i - keep[-1] >= gap or env[i] > env[keep[-1]] * 1.5:
            keep.append(i)
    return np.array(keep, dtype=np.int64)


# ---------------------------------------------------------------- 边界 / 乐句
def _novelty(feats, win=4):
    """每个小节线的新颖度: 前后 win 小节的特征变化量 (能量/密度/谱流量/重音/人声/低音)。"""
    n = len(feats)
    keys_w = {"energy": 1.0 / 12.0, "onsetDensity": 1.0, "flux": 1.0,
              "vocal": 1.0, "lo": 1.0, "vocalRatio": 1.0, "chroma": 1.0}
    den = {}
    for k in keys_w:
        v = np.array([f[k] for f in feats], dtype=np.float64)
        den[k] = float(np.std(v)) + 1e-6
    nov = np.zeros(n, dtype=np.float64)
    comp = []
    for i in range(n):
        a0, a1 = max(0, i - win), i
        b0, b1 = i, min(n, i + win)
        if a1 <= a0 or b1 <= b0:
            comp.append({})
            continue
        c = {}
        for k, w in keys_w.items():
            va = np.mean([feats[j][k] for j in range(a0, a1)])
            vb = np.mean([feats[j][k] for j in range(b0, b1)])
            c[k] = abs(vb - va) / den[k] * w
        # 重音模式变化: 归一化 4 向量之差的 L1
        aa = np.mean([feats[j]["accent"] for j in range(a0, a1)], axis=0)
        ab = np.mean([feats[j]["accent"] for j in range(b0, b1)], axis=0)
        na, nb = aa / (aa.sum() + 1e-9), ab / (ab.sum() + 1e-9)
        c["accent"] = float(np.abs(na - nb).sum()) * 0.5
        # 和声(音色)变化: 段落线常伴随和弦/编排变化
        cha = np.mean([feats[j].get("chroma", 0.0) for j in range(a0, a1)])
        chb = np.mean([feats[j].get("chroma", 0.0) for j in range(b0, b1)])
        c["harmony"] = min(1.0, abs(chb - cha) / (np.std([f.get("chroma", 0.0) for f in feats]) + 1e-6))
        comp.append(c)
        nov[i] = sum(c.values())
    nov = nov / (np.percentile(nov, 95) + 1e-9)
    return np.clip(nov, 0.0, 2.0), comp


def _phrase_prior(bar_index):
    """位置先验: 乐句边界常见于 4/8/16 小节的整数倍 (但只是先验, 不决定结论)。"""
    if bar_index <= 0:
        return 0.0
    if bar_index % 16 == 0:
        return 0.30
    if bar_index % 8 == 0:
        return 0.22
    if bar_index % 4 == 0:
        return 0.12
    if bar_index % 2 == 0:
        return 0.04
    return 0.0


# ---------------------------------------------------------------- 主入口
def _jsonable(o):
    """numpy 标量/数组 → Python 原生; NaN/Inf → None (JSON 不能带这些)。"""
    if isinstance(o, dict):
        return {k: _jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_jsonable(v) for v in o]
    if isinstance(o, np.ndarray):
        return _jsonable(o.tolist())
    if isinstance(o, (np.bool_, bool)):
        return bool(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating, float)):
        f = float(o)
        return f if np.isfinite(f) else None
    return o


def analyze(path, progress=None):
    """薄壳: 主体返回 numpy 标量, 统一转成可 JSON 的 Python 原生类型。"""
    return _jsonable(_analyze(path, progress))


def _analyze(path, progress=None):
    """分析一个音频文件 → 结构 JSON (确定性)。

    返回:
      ver / sr / duration / bpm / ppb
      beatTimes[] / downbeats[] / bars[{i,start,end,beats}]
      features{onsetDensity,energy,spectralFlux,accentPattern,vocalProxy,lowBand,barTimes}
      phrases[{start,end,bars,score,density,accent}]
      sections[{start,end,cluster,startBar,endBar}]
      transitionPoints[{time,bar,confidence,type,why{...}}]
    """
    x, sr = _load_mono(path)
    dur = len(x) / float(sr)
    if dur < 8.0 or len(x) < N_FFT:
        return {"ver": ANALYSIS_VER, "sr": sr, "duration": dur, "bpm": 0.0, "ppb": PPB,
                "beatTimes": [], "downbeats": [], "bars": [], "phrases": [], "sections": [],
                "features": {"onsetDensity": [], "energy": [], "spectralFlux": [],
                             "accentPattern": [], "vocalProxy": [], "lowBand": [], "barTimes": []},
                "transitionPoints": [], "warning": "音频太短 (不足 8s), 不做结构分析"}
    if progress:
        progress("STFT…")
    env = _envelopes(x, sr)
    fps = env["fps"]

    if progress:
        progress("节拍网格拟合…")
    # 全局拟合 BPM+相位 (老实现: 自相关+先验, 实测偏 1% → 全曲漂 5 拍, 网格与音乐脱钩 ✗)
    bpm_f, phase_f, fit_ptm, fit_f, fit_ok = _fit_grid(env["perc"], fps, dur)
    if not fit_ok:
        # 检测不到稳定节拍(纯人声/自由速度/无鼓/渲染片段) → 明确拒答。
        # 硬给一堆"结构标记"只会误导 (实测纯人声素材会算出 1.85 质量的伪节拍) ✗
        why = ("打击乐峰太少 (%d 个)" % len(_pick_peaks(env["perc"], fps, 0.06, 0.12))) if bpm_f <= 0 else \
              ("节拍质量 %.2f < 2.0" % fit_ptm)
        return {"ver": ANALYSIS_VER, "sr": sr, "duration": dur, "bpm": float(bpm_f), "ppb": PPB,
                "beatTimes": [], "downbeats": [], "bars": [], "phrases": [], "sections": [],
                "features": {"onsetDensity": [], "energy": [], "spectralFlux": [],
                             "accentPattern": [], "vocalProxy": [], "lowBand": [], "barTimes": []},
                "transitionPoints": [], "gridQuality": round(float(fit_ptm), 3),
                "warning": "检测不到稳定节拍 (" + why + ") — 可能是纯人声/自由速度/无鼓素材。不做结构分析。"}
    if fit_ok:
        bpm = bpm_f
        period = 60.0 / bpm
        beats = np.arange(phase_f, dur, period)
        bidx = np.clip((beats * fps).astype(np.int64), 0, len(env["onset"]) - 1)
        beat_f1 = fit_f
    else:
        # 兜底(自由速度/无鼓): 退回 DP 节拍跟踪
        period0 = _tempo_period(env["onset"], fps)
        best = None
        for mul in (0.5, 1.0, 2.0):
            p_ = period0 * mul
            bpm_c = 60.0 * fps / p_
            if not (50.0 <= bpm_c <= 220.0):
                continue
            bi = _dp_beats(env["onset"], fps, p_)
            ff = _beat_f(env["onset"], bi, fps)
            sc = ff + 0.03 * float(np.exp(-0.5 * ((np.log2(bpm_c / 120.0)) / 0.9) ** 2))
            if best is None or sc > best[0]:
                best = (sc, p_, bi, ff)
        if best is None:
            best = (0.0, period0, _dp_beats(env["onset"], fps, period0), 0.0)
        _, period, bidx, beat_f1 = best
        beats = bidx / fps
        bpm = 60.0 * fps / period

    ph, ph_score, ph_strength = _downbeat_phase(env, bidx)
    down_idx = bidx[ph::PPB]
    down = down_idx / fps
    if len(down) < 2:
        down = beats[::PPB]
    # 小节线吸附到 onset 起音起点: 标记=切点, 切在起音起点上两首歌才对得齐 (相位误差是"接不上"的主因)
    down = np.array([_snap_onset(float(t), env["onset"], fps) for t in down])
    # 小节: downbeat 之间 (末尾补齐到音频结束)
    edges = list(down) + [dur]
    bars = []
    for i, (a, b) in enumerate(zip(edges[:-1], edges[1:])):
        if b - a < 1e-3:
            continue
        bars.append({"i": len(bars), "start": float(a), "end": float(b), "beats": PPB})
    if not bars:
        return {"ver": ANALYSIS_VER, "sr": sr, "duration": dur, "bpm": bpm, "ppb": PPB,
                "beatTimes": beats.tolist(), "downbeats": down.tolist(), "bars": [],
                "phrases": [], "sections": [], "transitionPoints": [],
                "features": {"onsetDensity": [], "energy": [], "spectralFlux": [],
                             "accentPattern": [], "vocalProxy": [], "lowBand": [], "barTimes": []}}

    if progress:
        progress("逐小节特征…")
    feats = _bar_features(env, bars)
    nov, comp = _novelty(feats)

    if progress:
        progress("乐句与过渡点…")
    phrases = _phrases_full(bars, feats, nov, comp)
    sections = _sections(bars, feats, phrases)
    # 每小节线的起音强度 (±45ms 内 onset 包络的峰值): 决定这个边界"切得齐不齐"
    _w = int(round(0.045 * fps))
    atk = []
    for _b in bars:
        _c = int(round(_b["start"] * fps))
        _a = max(0, _c - _w); _z = min(len(env["onset"]) - 1, _c + _w)
        atk.append(float(env["onset"][_a:_z + 1].max()) if _z > _a else 0.0)
    trans = _transitions(bars, feats, nov, comp, phrases, atk)

    dens = [f["onsetDensity"] for f in feats]
    nrm_dens = _norm01(dens).tolist() if dens else []
    return {
        "ver": ANALYSIS_VER,
        "sr": sr, "duration": dur, "bpm": float(bpm), "ppb": PPB,
        "beatsPerBar": PPB, "beatF1": round(float(beat_f1), 3),
        "gridF": round(float(fit_f), 3), "gridQuality": round(float(fit_ptm), 3),
        "beatTimes": [round(float(t), 4) for t in beats],
        "downbeats": [round(float(t), 4) for t in down],
        "barPhase": int(ph), "downbeatStrength": round(float(ph_strength), 3),
        "bars": bars,
        "features": {
            "barTimes": [b["start"] for b in bars],
            "onsetDensity": [round(f["onsetDensity"], 4) for f in feats],
            "onsetDensityNorm": [round(v, 4) for v in nrm_dens],
            "energy": [round(f["energy"], 3) for f in feats],
            "spectralFlux": [round(f["flux"], 5) for f in feats],
            "accentPattern": [[round(v, 4) for v in f["accent"]] for f in feats],
            "vocalProxy": [round(f["vocal"], 4) for f in feats],
            "vocalRatio": [round(f["vocalRatio"], 4) for f in feats],
            "lowBand": [round(f["lo"], 4) for f in feats],
            "onsetCount": [int(f["onsetCount"]) for f in feats],
        },
        "phrases": phrases,
        "sections": sections,
        "transitionPoints": trans,
        "method": "spectral-flux onset → autocorr tempo + Ellis DP beats → 4/4 downbeat phase → "
                  "per-bar density/accent/energy/flux → novelty → phrase/transition scoring",
    }


def _phrase_interval_feats(feats, a, b):
    seg = feats[a:b]
    if not seg:
        return 0.0, [0.0] * PPB
    dens = float(np.mean([f["onsetDensity"] for f in seg]))
    acc = np.mean([f["accent"] for f in seg], axis=0)
    s = float(acc.sum()) + 1e-9
    return dens, [float(v / s) for v in acc]


def _phrases_full(bars, feats, nov, comp, min_gap_bars=2):
    n = len(bars)
    if n < 3:
        return []
    cand = []
    for i in range(1, n):
        s = float(nov[i]) + _phrase_prior(i)
        l = float(nov[i - 1]) + _phrase_prior(i - 1) if i - 1 >= 0 else 0.0
        r = float(nov[i + 1]) + _phrase_prior(i + 1) if i + 1 < n else 0.0
        if s >= l - 0.02 and s >= r - 0.02:
            cand.append((i, s))
    cand.sort(key=lambda x: -x[1])
    chosen = []
    for i, s in cand:
        if s < 0.35:
            continue
        if all(abs(i - j) >= min_gap_bars for j, _ in chosen):
            chosen.append((i, s))
    chosen.sort()
    smap = dict(chosen)
    idxs = [0] + [i for i, _ in chosen] + [n]
    out = []
    for a, b in zip(idxs[:-1], idxs[1:]):
        if b - a < 1:
            continue
        dens, acc = _phrase_interval_feats(feats, a, b)
        out.append({"start": bars[a]["start"], "end": bars[b - 1]["end"],
                    "bars": b - a, "firstBar": a + 1, "lastBar": b,
                    "score": round(float(smap.get(a, 0.0)), 4),
                    "density": round(dens, 4), "accent": [round(v, 4) for v in acc]})
    return out


def _sections(bars, feats, phrases):
    """保守的段落聚合: **只合并相邻**且(能量/密度/重音)接近的乐句。
    不猜 verse/chorus —— 只给 intro 与 A/B/C… 中性标签。
    (踩过的坑: 按"最相似组"贪心合并会把不相邻的乐句并成一段, 段跨度直接覆盖全曲 ✗)"""
    if not phrases:
        return []
    keys = []
    for p in phrases:
        f = feats[p["firstBar"] - 1: p["lastBar"]]
        e = float(np.mean([x["energy"] for x in f])) if f else -60.0
        d = float(np.mean([x["onsetDensity"] for x in f])) if f else 0.0
        a = np.mean([x["accent"] for x in f], axis=0) if f else np.zeros(PPB)
        a = a / (a.sum() + 1e-9)
        keys.append((e, d, a))
    E = np.array([k[0] for k in keys]); D = np.array([k[1] for k in keys])
    Es = float(np.std(E)) + 1e-6
    Ds = float(np.std(D)) + 1e-6

    def close(i, j):
        de = abs(keys[i][0] - keys[j][0]) / Es
        dd = abs(keys[i][1] - keys[j][1]) / Ds
        da = float(np.abs(keys[i][2] - keys[j][2]).sum()) * 0.5
        return de < 1.0 and dd < 1.2 and da < 0.45

    segs = [[0]]
    for i in range(1, len(phrases)):
        if close(i, segs[-1][-1]):
            segs[-1].append(i)
        else:
            segs.append([i])

    # 相邻两段若其实很像 (被一个离群乐句切开), 再合回去
    merged = [segs[0]]
    for g in segs[1:]:
        if close(merged[-1][-1], g[0]) and close(merged[-1][0], g[-1]):
            merged[-1].extend(g)
        else:
            merged.append(g)
    segs = merged

    e_med = float(np.median([x["energy"] for x in feats]))
    d_med = float(np.median([x["onsetDensity"] for x in feats]))
    out, labels, li = [], "ABCDEFGH", 0
    for gi, g in enumerate(segs):
        a = phrases[g[0]]["firstBar"] - 1
        b = phrases[g[-1]]["lastBar"]
        e = float(np.mean([feats[j]["energy"] for j in range(a, b)]))
        d = float(np.mean([feats[j]["onsetDensity"] for j in range(a, b)]))
        is_intro = (gi == 0 and (b - a) <= 16 and e < e_med and d < d_med)
        name = "intro" if is_intro else labels[li % len(labels)]
        if not is_intro:
            li += 1
        out.append({"start": round(bars[a]["start"], 4), "end": round(bars[b - 1]["end"], 4),
                    "cluster": name, "startBar": a + 1, "endBar": b,
                    "energy": round(e, 2), "density": round(d, 4),
                    "confidence": 0.6 if is_intro else 0.5})
    return out


def _transitions(bars, feats, nov, comp, phrases, atk=None):
    """每个小节线算一个 transition 分数 (0~1) + 分项, 只留 >=0.30 的。"""
    n = len(bars)
    if n < 3:
        return []
    ph_starts = {p["firstBar"] for p in phrases}
    dens = np.array([f["onsetDensity"] for f in feats])
    dmax = float(np.percentile(dens, 90)) + 1e-6
    out = []
    for i in range(1, n):
        c = comp[i] if i < len(comp) else {}
        if not c:
            continue
        # 各分项 (0~1)
        energy_chg = min(1.0, c.get("energy", 0.0) / 2.0)
        rhythm_chg = min(1.0, c.get("onsetDensity", 0.0) / 2.0)
        timbre_chg = min(1.0, (c.get("flux", 0.0) + c.get("vocalRatio", 0.0)) / 2.5)
        accent_chg = min(1.0, c.get("accent", 0.0) / 0.6)
        low_chg = min(1.0, c.get("lo", 0.0) / 2.0)
        is_phrase = 1.0 if (i in ph_starts) else 0.0
        bar_ok = 1.0 if i % PPB == 0 else 0.0            # 恒为 1 (小节线本就是 4 拍对齐)
        pos_prior = _phrase_prior(i) / 0.30
        # 起音强度: 两首歌按标记对切时, 切点必须落在重音的攻击起点上 → 没起音的边界直接降权
        a_v = float(atk[i - 1]) if (atk is not None and i - 1 < len(atk)) else 0.0
        onset_fac = 0.45 + 0.55 * min(1.0, a_v / 0.25)
        # 权重让"特征变化"主导 (结构项只是加成), 这样强边界才拉得开分, 弱边界自动沉下去
        score = (0.30 * is_phrase + 0.10 * pos_prior +
                 0.20 * energy_chg + 0.18 * rhythm_chg + 0.12 * timbre_chg +
                 0.06 * accent_chg + 0.04 * low_chg)
        score = float(min(1.0, max(0.0, score * onset_fac)))
        # 类型: 看哪个分项最突出
        parts = {"energy": energy_chg, "rhythm": rhythm_chg, "timbre": timbre_chg,
                 "accent": accent_chg, "bass": low_chg}
        top = max(parts, key=parts.get)
        typ = ("phrase" if is_phrase else ("energy" if top == "energy" else
                                           ("rhythm" if top == "rhythm" else "section")))
        out.append({
            "time": round(float(bars[i]["start"]), 4),
            "bar": i + 1,
            "confidence": 0.0,      # 下面按"相对本曲"归一化后再填
            "_raw": score,
            "type": typ,
            "why": {
                "phrase": round(is_phrase, 3),
                "bar": round(bar_ok, 3),
                "energy": round(energy_chg, 3),
                "rhythm": round(rhythm_chg, 3),
                "timbre": round(timbre_chg, 3),
                "accent": round(accent_chg, 3),
                "bass": round(low_chg, 3),
                "novelty": round(float(nov[i]), 3),
                "onset": round(a_v, 3),
            },
        })
    # 绝对分被各特征上限压住 (实测全曲最强也只有 0.6), 直接当置信度看不出差别 ✗
    # → 按本曲所有候选边界归一化: confidence = 相对"本曲最强边界"的分档 (0.25~0.97)
    raws = [t["_raw"] for t in out]
    lo = float(np.percentile(raws, 5)) if raws else 0.0
    hi = float(np.percentile(raws, 95)) if raws else 1.0
    res = []
    for t in out:
        n = 0.0 if hi - lo < 1e-6 else float(np.clip((t["_raw"] - lo) / (hi - lo), 0.0, 1.0))
        t["confidence"] = round(0.25 + 0.72 * n, 3)
        # 硬规则: 起音太弱的边界不可能切得齐 (两首歌对切要落在重音攻击起点上) → 黄色封顶
        # 这样"红/橙"就是真的可以直接拿来做串烧接点的位置, 而不是看着好看
        if t["why"].get("onset", 1.0) < 0.05:
            t["confidence"] = min(t["confidence"], 0.49)
        t["why"]["rawScore"] = round(t.pop("_raw"), 4)
        if t["confidence"] >= 0.30:
            res.append(t)
    # 去噪: 标记太密就没人看 (实测 139 小节会出 116 个 ✗)。
    # 规则: 按置信度优先; 强边界(>=0.85)一律保留, 其余要求间隔 >=2 小节, 总量不超过 每4小节1个
    cap = max(8, int(round(len(bars) / 4.0)))
    keep, used = [], []
    for t in sorted(res, key=lambda x: -x["confidence"]):
        strong = t["confidence"] >= 0.85
        if not strong:
            if len(keep) >= cap:
                continue
            if any(abs(t["bar"] - u) < 2 for u in used):
                continue
        keep.append(t)
        used.append(t["bar"])
    keep.sort(key=lambda x: x["time"])
    return keep


# ---------------------------------------------------------------- 缓存 / 文件
def file_hash(path, block=1 << 20):
    h = hashlib.md5()
    h.update(("v%d|" % ANALYSIS_VER).encode())
    with open(path, "rb") as f:
        while True:
            b = f.read(block)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def cache_path(cache_dir, path):
    return os.path.join(cache_dir, file_hash(path) + ".json")


def analyze_cached(path, cache_dir):
    """带缓存: key = 音频内容 hash + 算法版本。返回 (result, from_cache)。"""
    os.makedirs(cache_dir, exist_ok=True)
    cp = cache_path(cache_dir, path)
    if os.path.isfile(cp):
        try:
            with open(cp, encoding="utf-8") as f:
                j = json.load(f)
            if j.get("ver") == ANALYSIS_VER:
                j["cached"] = True
                j["hash"] = os.path.basename(cp)[:-5]
                return j, True
        except Exception:
            pass
    res = analyze(path)
    res["cached"] = False
    res["hash"] = os.path.basename(cp)[:-5]
    res["source"] = os.path.basename(path)
    try:
        with open(cp, "w", encoding="utf-8") as f:
            json.dump(res, f, ensure_ascii=False)
    except OSError:
        pass
    return res, False
