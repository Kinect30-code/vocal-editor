"""人力VOCAL编辑器 DSP 引擎: WORLD (pyworld) 优先, Praat PSOLA 兜底.

两个引擎都是"分析 -> 改参数 -> 重合成"架构(和 VocalShifter/Melodyne 同构),
区别于 elastique 那类实时移调算法, 人声持续音上不会出痰音.
"""
import warnings

import numpy as np

warnings.filterwarnings("ignore", message=".*pkg_resources is deprecated.*")   # pyworld 的启动噪声

try:
    import pyworld as _pw
    ENGINE = "world"
except Exception:
    _pw = None
    try:
        import parselmouth as _pm
        from parselmouth.praat import call as _call
        ENGINE = "psola"
    except Exception:
        raise RuntimeError("没有任何可用引擎: 需要 pyworld 或 praat-parselmouth")

_pm_mod = None
_pm_call = None
try:
    import parselmouth as _pm_mod
    from parselmouth.praat import call as _pm_call
except Exception:
    pass


def take_window(x, sr, offset, win):
    """取源窗口 [offset, offset+win); 越过源尾时按【循环源】回绕补齐 (REAPER loop source 语义).
    客户端 Alt+滑动会把 offset 绕进 [0, srcDur), 窗口可能跨过源尾 — 这里负责接上."""
    n = max(1, int(round(float(win) * sr)))
    total = len(x)
    if total < 2:
        return np.zeros(n)
    i0 = int(round(float(offset) * sr)) % total
    if i0 + n <= total:
        return x[i0:i0 + n]
    return x[(np.arange(n) + i0) % total]


def load_mono(path):
    import soundfile as sf
    x, sr = sf.read(path, dtype="float64", always_2d=True)
    return x.mean(axis=1), sr


def save_wav(path, x, sr):
    import soundfile as sf
    sf.write(path, np.clip(x, -1.0, 1.0), sr, subtype="PCM_16")


# ---------- WORLD ----------

def _warp_envelope(sp, sr, ratio):
    """沿频率轴缩放频谱包络(=共振峰移位). ratio>1 共振峰上移."""
    nfr, nb = sp.shape
    fft_size = (nb - 1) * 2
    freqs = np.arange(nb) * (sr / fft_size)
    target = freqs * ratio
    out = np.empty_like(sp)
    for i in range(nfr):
        out[i] = np.interp(target, freqs, sp[i], right=sp[i, -1])
    return out


def _resample_params(mat, n2):
    n = mat.shape[0]
    if n2 == n:
        return mat.copy()
    idx = np.linspace(0.0, n - 1, n2)
    out = np.empty((n2, mat.shape[1]), dtype=mat.dtype)
    for k in range(mat.shape[1]):
        out[:, k] = np.interp(idx, np.arange(n), mat[:, k])
    return out


def world_process(x, sr, semitones=0.0, formant_semitones=0.0, stretch=1.0,
                  f0_floor=50.0, f0_ceil=1100.0, frame_period=5.0):
    f0, t = _pw.harvest(x, sr, f0_floor=f0_floor, f0_ceil=f0_ceil,
                        frame_period=frame_period)
    f0 = _pw.stonemask(x, f0, t, sr)
    fft_size = _pw.get_cheaptrick_fft_size(sr, f0_floor)
    sp = _pw.cheaptrick(x, f0, t, sr, f0_floor=f0_floor, fft_size=fft_size)
    ap = _pw.d4c(x, f0, t, sr, fft_size=fft_size)
    if abs(semitones) > 1e-6:
        f0 = f0 * (2.0 ** (semitones / 12.0))
    if abs(formant_semitones) > 1e-6:
        sp = _warp_envelope(sp, sr, 2.0 ** (formant_semitones / 12.0))
    if abs(stretch - 1.0) > 1e-4:
        n = len(t)
        n2 = max(8, int(round(n * stretch)))
        f0 = np.interp(np.linspace(0, n - 1, n2), np.arange(n), f0)
        sp = _resample_params(sp, n2)
        ap = _resample_params(ap, n2)
    return _pw.synthesize(f0, sp, ap, sr, frame_period)


def psola_process(x, sr, semitones=0.0, formant_semitones=0.0, stretch=1.0):
    """Praat Manipulation PSOLA: 改 PitchTier/DurationTier 后 overlap-add 重合成.

    formant_semitones 在 PSOLA 路径不支持 (process() 会把带共振峰的需求路由给 WORLD).
    """
    snd = _pm_mod.Sound(np.ascontiguousarray(x, dtype=np.float64), sampling_frequency=sr)
    manip = _pm_call(snd, "To Manipulation", 0.01, 60.0, 1100.0)
    if abs(semitones) > 1e-6:
        pt = _pm_call(manip, "Extract pitch tier")
        _pm_call(pt, "Multiply frequencies", 0.0, snd.duration, 2.0 ** (semitones / 12.0))
        _pm_call([manip, pt], "Replace pitch tier")
    if abs(stretch - 1.0) > 1e-4:
        dt = _pm_call(manip, "Extract duration tier")
        _pm_call(dt, "Add point", 0.0, float(stretch))
        _pm_call([manip, dt], "Replace duration tier")
    out = _pm_call(manip, "Get resynthesis (overlap-add)")
    return out.values[0]


def process(x, sr, semitones=0.0, formant_semitones=0.0, stretch=1.0):
    """auto: Rubber Band R3 > Praat PSOLA > WORLD. formant_semitones 只有 WORLD 支持."""
    x = np.ascontiguousarray(x, dtype=np.float64)
    if abs(formant_semitones) > 1e-6:
        return world_process(x, sr, semitones, formant_semitones, stretch)
    if rubberband_available():
        return rubberband_process(x, sr, semitones, stretch)
    if _pm_mod is not None:
        return psola_process(x, sr, semitones, formant_semitones, stretch)
    return world_process(x, sr, semitones, formant_semitones, stretch)


_RB = None
def rubberband_available():
    global _RB
    if _RB is None:
        import shutil
        _RB = shutil.which("rubberband") is not None
    return _RB


def rubberband_process(x, sr, semitones=0.0, stretch=1.0):
    """Rubber Band R3 离线拉伸/变调 --formant, 对真实人声最干净."""
    import subprocess, tempfile, os
    import soundfile as sf
    with tempfile.TemporaryDirectory() as td:
        i = os.path.join(td, "in.wav")
        o = os.path.join(td, "out.wav")
        sf.write(i, np.clip(np.asarray(x, dtype=np.float64), -1, 1), sr, subtype="PCM_16")
        cmd = ["rubberband", "-3", "--fine", "-t", "%.6f" % max(0.05, stretch)]
        if abs(semitones) > 1e-6:
            cmd += ["--formant", "-p", "%.6f" % semitones]
        cmd += [i, o]
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
        if p.returncode != 0 or not os.path.exists(o) or os.path.getsize(o) < 44:
            raise RuntimeError("rubberband 失败: " + (p.stderr or "").strip()[-300:])
        y, osr = sf.read(o, dtype="float64", always_2d=True)
        if osr != sr:
            raise RuntimeError("rubberband 采样率异常 %d" % osr)
        return y.mean(axis=1)


# ---------- 音高轨迹 ----------

def _frame_rms(x, sr, t, win=0.020):
    idx = (t * sr).astype(int)
    n = int(win * sr)
    out = np.empty(len(t))
    for k, i in enumerate(idx):
        seg = x[i:i + n]
        out[k] = np.sqrt(np.mean(seg * seg)) if len(seg) else 0.0
    return out


def pitch_track(x, sr, time_step=0.005, floor=50.0, ceil=1100.0):
    """返回 (times, f0); 未发声帧 f0=0. 低能量帧(静音)强制置 0, 防止音高轨迹桥接气口."""
    x = np.ascontiguousarray(x, dtype=np.float64)
    if _pm_mod is not None:
        snd = _pm_mod.Sound(x, sampling_frequency=sr)
        p = snd.to_pitch(time_step, floor, ceil)
        f0 = p.selected_array["frequency"].astype(np.float64)
        try:
            t = p.ts()
        except Exception:
            t = np.arange(len(f0)) * time_step
    else:
        f0, t = _pw.harvest(x, sr, f0_floor=floor, f0_ceil=ceil,
                            frame_period=time_step * 1000)
        f0 = _pw.stonemask(x, f0, t, sr)
    if len(t) > 1:
        rms = _frame_rms(x, sr, t)
        thr = max(10 ** (-50 / 20.0), float(rms.max()) * 0.01)
        f0 = np.where(rms >= thr, f0, 0.0)
    f0[f0 < floor * 0.5] = 0.0
    return t, f0



# ---------- MIDI ----------

def parse_midi(path):
    import mido
    mid = mido.MidiFile(path)
    notes, active = [], {}
    t = 0.0
    for msg in mid:
        t += msg.time
        if msg.type == "note_on" and msg.velocity > 0:
            active.setdefault((msg.channel, msg.note), []).append(t)
        elif msg.type == "note_off" or (msg.type == "note_on" and msg.velocity == 0):
            q = active.get((msg.channel, msg.note))
            if q:
                s = q.pop(0)
                if t - s >= 0.03:
                    notes.append({"start": round(s, 4), "end": round(t, 4),
                                  "midi": int(msg.note)})
    notes.sort(key=lambda d: d["start"])
    return notes




def _slide_cmds(notes):
    """FL 式滑音指令流 (与前端 buildSlideCommands 同构):
    普通键 = 音高台阶; 滑音键 = 从"该刻当前音高"在其跨度内线性滑向自身音高.
    同刻先普通后滑音 (滑音要以其底下的持续音为起点)."""
    evs = []
    for n in notes:
        evs.append({
            "t": float(n["start"]),
            "e": float(n["end"]),
            "p": float(n["midi"]),
            "slide": bool(n.get("slide")),
            "none": bool(n.get("none")),
        })
    # 同刻顺序: 释放 → 普通键 → 滑音键 (释放先落地, 该刻开始的键才接得上)
    evs.sort(key=lambda x: (x["t"], 0 if x["none"] else (2 if x["slide"] else 1)))
    cmds = []
    for x in evs:
        if x["none"]:
            cmds.append({"t": x["t"], "kind": 2})          # 释放: 交还素材原音高
        elif x["slide"]:
            cmds.append({"t": x["t"], "kind": 1,
                         "t1": max(x["e"], x["t"] + 1e-6), "p": x["p"]})
        else:
            cmds.append({"t": x["t"], "kind": 0, "p": x["p"]})
    return cmds


def _cmd_pitch(cmds, tt):
    """半音数 (含转调) 的逐时刻求值; 无事件覆盖 → None.
    滑音结束后保留目标音高 (不会弹回底下的长音) — 这是 FL 滑音键的关键语义.
    kind 2 = 释放: 从这里起不再接管 (沿用素材原音高) —— MIDI 块是离散的,
    一块结束就交还控制权, 不能把上一块的尾巴一直吊到下一块的头."""
    cur = None
    ramp = None
    for c in cmds:
        if c["t"] > tt + 1e-9:
            break
        if c["kind"] == 2:
            cur = None
            ramp = None
        elif c["kind"] == 0:
            cur = c["p"]
            ramp = None
        else:
            ramp = (c["p"] if cur is None else cur, c)
            cur = c["p"]
    if ramp is not None and tt < ramp[1]["t1"]:
        base, c = ramp
        return base + (c["p"] - base) * ((tt - c["t"]) / (c["t1"] - c["t"]))
    return cur


SIMPLE_PITCH_N = 2048          # 相位声码器窗长 (离线, 不追求低延迟)
SIMPLE_PITCH_GRAIN = 0.045     # 极短素材 (< 2 窗) 退化为颗粒法: Hann 窗 45ms


def simple_pitch(x, sr, semitones):
    """普通变调: 只改音高、不改时长.
    相位声码器 (STFT 时间拉伸 ×r + 线性重采样回原长), 与前端 static/app.js 的 simplePitchBuffer
    同一套参数 —— 导出与试听同一算法。不是 PSOLA/elastique 那套 (那套用在 MIDI 接管/音高矫正)。"""
    r = 2.0 ** (float(semitones) / 12.0)
    x = np.ascontiguousarray(x, dtype=np.float64)
    n = len(x)
    if abs(r - 1.0) < 1e-6 or n < 4:
        return x.copy()
    N = SIMPLE_PITCH_N
    if n < 2 * N:                       # 太短, 声码器没有意义 → 颗粒法兜底
        return _grain_pitch(x, sr, r)
    Ha = N // 4
    Hs = max(1, int(round(Ha * r)))     # 时间拉伸 r 倍
    w = np.hanning(N).astype(np.float64)
    nb = N // 2 + 1
    omega = 2.0 * np.pi * np.arange(nb) * Ha / N          # 名义相位推进
    nf = 1 + (n - N) // Ha
    ylen = (nf - 1) * Hs + N
    y = np.zeros(ylen)
    wsum = np.zeros(ylen)
    prev = np.zeros(nb)
    syn = np.zeros(nb)
    for i in range(nf):
        seg = x[i * Ha: i * Ha + N] * w
        X = np.fft.rfft(seg)
        mag = np.abs(X)
        ph = np.angle(X)
        dph = ph - prev - omega
        dph = np.mod(dph + np.pi, 2.0 * np.pi) - np.pi    # 相位残差卷绕
        prev = ph
        syn = syn + (omega + dph) * (Hs / float(Ha))      # 真实频率推进到合成格点
        yi = np.fft.irfft(mag * np.exp(1j * syn), N) * w
        y[i * Hs: i * Hs + N] += yi
        wsum[i * Hs: i * Hs + N] += w * w
    y = np.where(wsum > 1e-6, y / np.maximum(wsum, 1e-9), 0.0)
    # 重采样回原长: 严格按 r 倍速读 (不是按"长度比", 否则拉伸后的余头会带进 0.5~1% 的音高误差)
    if len(y) < 2:
        return np.resize(y, n)
    pos = np.arange(n, dtype=np.float64) * r
    i0 = np.clip(pos.astype(np.int64), 0, len(y) - 2)
    fr = np.clip(pos - i0, 0.0, 1.0)
    return y[i0] + (y[i0 + 1] - y[i0]) * fr


def _grain_pitch(x, sr, r):
    """极短素材兜底: 颗粒重叠相加 (Hann 窗 45ms, 75% 重叠)."""
    n = len(x)
    N = max(32, int(round(sr * SIMPLE_PITCH_GRAIN)))
    H = max(8, N // 4)
    w = 0.5 - 0.5 * np.cos(2.0 * np.pi * np.arange(N) / N)
    acc = np.zeros(n)
    wsum = np.zeros(n)
    for t0 in range(0, n, H):
        m = min(N, n - t0)
        pos = t0 + np.arange(m, dtype=np.float64) * r
        i0 = np.clip(pos.astype(np.int64), 0, n - 1)
        i1 = np.clip(i0 + 1, 0, n - 1)
        fr = pos - i0
        wk = w[:m]
        acc[t0:t0 + m] += (x[i0] + (x[i1] - x[i0]) * fr) * wk
        wsum[t0:t0 + m] += wk
    return np.where(wsum > 0.35, acc / np.maximum(wsum, 1e-9), 0.0)


def takeover_psola(x, sr, notes, f0_floor=60.0, f0_ceil=1100.0):
    """轨道 pitch 接管 + 时间拉伸 (一次重合成同时完成):
    PitchTier = MIDI 目标曲线 (notes 为源窗口内秒, 客户端已按块 Rate 压缩);
    DurationTier = stretch → 输出时长 = 窗口长 × stretch = 块长.
    FL 式滑音: 普通键为音高台阶, 滑音键在自跨度内从当前音高滑向其音高并保持
    (一个长键可叠多个滑音键, 键越长滑得越慢; 多键依次接力).
    音符覆盖之前的时间段沿用素材自身 F0; 素材的辅音/换气(无声段)保持原样.
    """
    x = np.ascontiguousarray(x, dtype=np.float64)
    dur = len(x) / sr
    t, f0 = pitch_track(x, sr, floor=f0_floor, ceil=f0_ceil)
    dt = float(t[1] - t[0]) if len(t) > 1 else 0.005

    def mat_f(tt):
        i = int(round(tt / dt))
        if 0 <= i < len(f0):
            return float(f0[i])
        return 0.0

    cmds = _slide_cmds(notes)

    pts = []
    step = 0.02
    k = 0
    while k * step <= dur + 1e-9:
        tt = min(k * step, dur)
        pn = _cmd_pitch(cmds, tt)          # 半音数; None = 还没有音符事件
        if pn is not None:
            pts.append((tt, 440.0 * 2.0 ** ((pn - 69) / 12.0)))
        else:
            mf = mat_f(tt)                 # 音符覆盖之前 → 沿用素材原 F0
            if mf > 0:
                pts.append((tt, mf))
        k += 1

    snd = _pm_mod.Sound(x, sampling_frequency=sr)
    manip = _pm_call(snd, "To Manipulation", 0.01, f0_floor, f0_ceil)
    tier = _pm_call("Create PitchTier", "takeover", 0.0, dur)
    for (tt, ff) in pts:
        _pm_call(tier, "Add point", tt, ff)
    _pm_call([manip, tier], "Replace pitch tier")
    out = _pm_call(manip, "Get resynthesis (overlap-add)")
    return out.values[0]


def _duration_pass(x, sr, factor):
    """单次 PSOLA 时长拉伸 (factor ≤ 3, Praat overlap-add 有 ~3x 上限)."""
    snd = _pm_mod.Sound(np.ascontiguousarray(x, dtype=np.float64), sampling_frequency=sr)
    manip = _pm_call(snd, "To Manipulation", 0.01, 60.0, 1100.0)
    dt = _pm_call(manip, "Extract duration tier")
    _pm_call(dt, "Add point", 0.0, float(factor))
    _pm_call([manip, dt], "Replace duration tier")
    out = _pm_call(manip, "Get resynthesis (overlap-add)")
    return out.values[0]


def psola_stretch_multi(x, sr, total):
    """多段 PSOLA 拉伸到 total 倍 (每段 ≤2.5, 绕开单次 3x 上限);
    末尾按实际输出长度做一次微校正 (PSOLA 整周期量化会有 ±15% 累计误差)."""
    out = np.ascontiguousarray(x, dtype=np.float64)
    expected = len(out) * float(total)
    remaining = float(total)
    if remaining < 1.0:
        # 加速(压缩): 单段 factor<1, 无上限问题; 不修会走截尾丢一半内容
        out = _duration_pass(out, sr, max(0.05, remaining))
        remaining = 1.0
    while remaining > 1.001:
        f = min(2.5, remaining)
        out = _duration_pass(out, sr, f)
        remaining /= f
    if abs(len(out) - expected) / expected > 0.02 and 0.5 < expected / len(out) < 2.0:
        out = _duration_pass(out, sr, expected / len(out))
    return out


def takeover_render(x, sr, notes, stretch=1.0):
    """whip 接管渲染: pitch 曲线替换 + 拉伸到块长 (rubberband 优先, 其次多段 PSOLA);
    末尾强制精确到块长 (PSOLA 整周期量化会有 ±15% 误差: 长了截尾/短了补零, 零音高伪影)."""
    y = takeover_psola(x, sr, notes)
    if abs(stretch - 1.0) > 1e-4:
        if rubberband_available():
            y = rubberband_process(y, sr, 0.0, stretch)
        else:
            y = psola_stretch_multi(y, sr, stretch)
    target = int(round(len(x) * stretch))
    if len(y) > target:
        y = y[:target]
    elif len(y) < target:
        y = np.concatenate([y, np.zeros(target - len(y))])
    return y


# ---------- 波形峰值 / 混音导出 (v2 多轨) ----------

def peaks(path, pps=50.0):
    """波形峰值包络: 每秒 pps 个 [min,max] 桶, 供时间线快速绘制."""
    x, sr = load_mono(path)
    n = len(x)
    if n == 0:
        return {"pps": pps, "min": [], "max": [], "sr": sr, "duration": 0.0}
    bucket = max(1, int(round(sr / pps)))
    n2 = (n // bucket) * bucket
    m = x[:n2].reshape(-1, bucket)
    return {"pps": sr / bucket, "min": m.min(axis=1).tolist(),
            "max": m.max(axis=1).tolist(), "sr": sr, "duration": n / sr}


def mixdown(items, sr, total_dur, dest):
    """混音: items = [{path,start,offset,length,gainL,gainR,rate?,fadeIn?,fadeOut?}], 等功率声像, 输出立体声 PCM16.
    length 为【源秒】; rate = 每秒时间轴消耗的源秒数 (变速块 >1, 普通块 1), 输出跨度 = length/rate."""
    import soundfile as sf
    n_total = int(round(total_dur * sr))
    outL = np.zeros(n_total)
    outR = np.zeros(n_total)
    for it in items:
        x, xsr = load_mono(it["path"])
        if abs(xsr - sr) > 1:
            raise ValueError("采样率不一致: %s 是 %dHz, 工程是 %dHz" % (it["path"], xsr, sr))
        rate = float(it.get("rate", 1) or 1)
        seg = take_window(x, sr, it["offset"], it["length"])   # 循环源: 网格/窗口越过源尾时回绕
        pit = float(it.get("pitch", 0) or 0)
        if abs(pit) > 1e-6:
            seg = simple_pitch(seg, sr, pit)                   # 普通变调 (保时长): 与前端实时算法一致
        if abs(rate - 1.0) > 1e-6 and len(seg) > 1:
            # 变速块: 与播放端 playbackRate 同构的线性重采样 (音高与时长一起变)
            n_out = max(1, int(round(len(seg) / rate)))
            seg = np.interp(np.linspace(0.0, len(seg) - 1.0, n_out), np.arange(len(seg)), seg)
        i0 = int(round(it["start"] * sr))
        gl, gr = float(it["gainL"]), float(it["gainR"])
        i1 = min(i0 + len(seg), n_total)
        if i1 <= i0:
            continue
        s = seg[: i1 - i0].copy()
        fi = float(it.get("fadeIn", 0) or 0)
        fo = float(it.get("fadeOut", 0) or 0)
        nf = min(int(fi * sr), len(s))
        if nf > 0:
            s[:nf] *= np.linspace(0.0, 1.0, nf)
        nf = min(int(fo * sr), len(s))
        if nf > 0:
            s[-nf:] *= np.linspace(1.0, 0.0, nf)
        outL[i0:i1] += s * gl
        outR[i0:i1] += s * gr
    st = np.stack([np.clip(outL, -1, 1), np.clip(outR, -1, 1)], axis=1)
    sf.write(dest, st, sr, subtype="PCM_16")
    return dest
