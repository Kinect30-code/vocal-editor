#!/usr/bin/env python3
"""vocal-editor v2 本地服务: 多轨工程 API + WORLD/PSOLA 渲染. 只监听 127.0.0.1:8765."""
import hashlib
import json
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import analysis
import dsp
import numpy as np

# 运行路径 (源码运行 = 仓库里; 打包运行 = 只读资源在 _MEIPASS, 数据在用户目录)
from ve_env import APP, DATA, STATIC, WORK, RENDER, INBOX, PROJDIR, user_path as _user_path
import ve_env

ve_env.ensure_dirs()
ROOT = APP
ANALYSIS = os.path.join(WORK, "analysis")   # 结构分析缓存 (key = 音频内容 hash)

RENDER_VER = "r8"   # 渲染语义版本: 变更时递增, 客户端据此重渲染 (r8: FL 式滑音保持目标音高)
LOCK = threading.Lock()
from concurrent.futures import ProcessPoolExecutor
POOL = ProcessPoolExecutor(max_workers=max(2, (os.cpu_count() or 4)))


def _system_python_with_gi():
    """找系统 python3 (带 gi/GTK 的那个) —— gi 是系统绑定, 装不进 venv。"""
    import shutil
    for c in (os.environ.get("VE_SYS_PYTHON"), "python3", "/usr/bin/python3"):
        if not c:
            continue
        p = c if os.path.isabs(c) else shutil.which(c)
        if not p or not os.path.exists(p):
            continue
        try:
            r = subprocess.run([p, "-c", "import gi;gi.require_version('Gtk','3.0')"],
                               capture_output=True, timeout=10)
            if r.returncode == 0:
                return p
        except Exception:
            continue
    return None


def _pick_files(kind="audio", multi=False):
    """在用户桌面上弹 GTK 文件对话框 (独立进程), 返回 (paths, error)。
    桌面窗口的浏览器引擎可能被沙盒限制选不了文件 (snap 版 Chromium 就是),
    而**后端是普通进程** → 选文件交给后端, 选完按路径直接导入。"""
    if not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        return [], "没有图形环境 (DISPLAY/WAYLAND_DISPLAY 都没有)"
    py = _system_python_with_gi()
    if not py:
        return [], "本机没有可用的 python3-gi"
    script = os.path.join(APP, "pickfile.py")
    if not os.path.isfile(script):
        return [], "缺 pickfile.py"
    env = dict(os.environ)
    state = os.path.join(WORK, ".last-import-dir")
    try:
        with open(state, encoding="utf-8") as f:
            env["VE_PICK_DIR"] = f.read().strip()
    except OSError:
        pass
    try:
        r = subprocess.run([py, script, kind] + (["--multi"] if multi else []),
                           capture_output=True, text=True, timeout=1800, env=env)
    except subprocess.TimeoutExpired:
        return [], "文件对话框超时"
    if r.returncode != 0:
        msg = (r.stderr or "").strip().splitlines()
        return [], (msg[-1] if msg else "文件对话框打不开")
    paths = [l.strip() for l in (r.stdout or "").splitlines() if l.strip()]
    paths = [p for p in paths if os.path.isfile(p)]
    if paths:
        try:
            with open(state, "w", encoding="utf-8") as f:
                f.write(os.path.dirname(paths[0]))
        except OSError:
            pass
    return paths, None


def _info(path):
    import soundfile as sf
    i = sf.info(path)
    return {"sr": i.samplerate, "duration": i.duration, "channels": i.channels}


def _render_key(src, offset, win, pitch, stretch, tk=None):
    eng = "rb" if dsp.rubberband_available() else ("psola" if dsp._pm_mod is not None else "world")
    tkj = ("tk5|" + json.dumps(tk, sort_keys=True)) if tk else ""
    key = hashlib.md5(("%s|%s|%s|%.4f|%.4f|%.4f|%.4f" % (eng, tkj, src, offset, win, pitch, stretch)).encode()).hexdigest()
    return os.path.join(RENDER, key + ".wav")


def _render_worker(task):
    """进程池 worker: 渲染一个块 (多核并行, 绕开 GIL)."""
    (src, offset, win, pitch, stretch, tk, dst) = task
    if os.path.exists(dst) and os.path.getsize(dst) > 44:
        return dst
    x, sr = dsp.load_mono(src)
    seg = dsp.take_window(x, sr, offset, win)   # 循环源: 窗口越过源尾时回绕
    if tk:
        y = dsp.takeover_render(seg, sr, tk, stretch=stretch)
    else:
        y = dsp.process(seg, sr, semitones=pitch, stretch=stretch)
    dsp.save_wav(dst, y, sr)
    return dst


def _render_cached(src, offset, win, pitch, stretch, tk=None):
    dst = _render_key(src, offset, win, pitch, stretch, tk)
    if os.path.exists(dst) and os.path.getsize(dst) > 44:
        return dst
    return POOL.submit(_render_worker, (src, offset, win, pitch, stretch, tk, dst)).result()


def _ffmpeg_to_wav(src, dst):
    """任意 ffmpeg 可读的媒体 (mp3/m4s/mp4/webm/...) → 44.1kHz 单声道 PCM16 wav."""
    base = ["ffmpeg", "-y", "-probesize", "50M", "-analyzeduration", "50M", "-i", src,
            "-vn", "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le"]
    attempts = [base + [dst]]
    ext = os.path.splitext(src)[1].lower()
    if ext in (".m4s", ".mp4", ".webm"):  # 分段/容器魔数不明显时强制 demuxer 重试
        attempts.append(["ffmpeg", "-y", "-f", "mp4", "-probesize", "50M", "-analyzeduration", "50M",
                         "-i", src, "-vn", "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", dst])
    last_err = ""
    for cmd in attempts:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
        if p.returncode == 0 and os.path.exists(dst) and os.path.getsize(dst) > 44:
            return
        last_err = "\n".join((p.stderr or "").strip().splitlines()[-5:])
    raise ValueError("ffmpeg 转换失败 (%s):\n%s" % (os.path.basename(src), last_err))


def _import_media(src):
    st = os.stat(src)
    key = hashlib.md5(("%s|%d|%d" % (os.path.abspath(src), st.st_size, int(st.st_mtime))).encode()).hexdigest()
    dst = os.path.join(RENDER, "imp_" + key + ".wav")
    if not os.path.exists(dst):
        _ffmpeg_to_wav(src, dst)
    info = _info(dst)
    return {"path": dst, "duration": info["duration"], "sr": info["sr"]}


def _demo_project():
    vocal = os.path.join(ROOT, "demo", "offtake.wav")
    midi = os.path.join(ROOT, "demo", "melody.mid")
    d = _info(vocal)["duration"]
    notes = dsp.parse_midi(midi)
    return {
        "bpm": 120,
        "tracks": [
            {"id": "t1", "name": "人声", "vol": 1.0, "pan": 0.0, "mute": False, "solo": False},
            {"id": "t2", "name": "人声2", "vol": 1.0, "pan": 0.0, "mute": False, "solo": False},
            {"id": "t3", "name": "参考MIDI", "vol": 1.0, "pan": 0.0, "mute": False, "solo": False},
        ],
        "clips": [
            {"id": "c1", "trackId": "t1", "src": vocal, "render": None, "name": "offtake",
             "start": 0.0, "offset": 0.0, "length": d, "stretch": 1.0, "pitch": 0.0, "srcDur": d},
            {"id": "c2", "trackId": "t2", "src": vocal, "render": None, "name": "offtake-2",
             "start": 4.5, "offset": 0.0, "length": d, "stretch": 1.0, "pitch": 0.0, "srcDur": d},
        ],
        "midiClips": [
            {"id": "m1", "trackId": "t3", "name": "melody", "start": 0.0, "length": 2.0, "notes": notes},
        ],
    }


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _file(self, path, ctype):
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            return self._send(404, {"error": "not found"})
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _json_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/":
            return self._file(os.path.join(STATIC, "index.html"), "text/html; charset=utf-8")
        if u.path == "/api/info":
            return self._send(200, {"engine": dsp.ENGINE, "rb": dsp.rubberband_available(),
                                    "ver": RENDER_VER, "data": DATA, "port": PORT,
                                    "desktop": os.environ.get("VE_DESKTOP") == "1"})
        if u.path == "/api/demo-project":
            with LOCK:
                return self._send(200, _demo_project())
        if u.path == "/audio":
            p = parse_qs(u.query).get("path", [""])[0]
            if p and os.path.isfile(p):
                return self._file(p, "audio/wav")
            return self._send(404, {"error": "file not found: %s" % p})
        if u.path.startswith("/vendor/") or u.path in ("/app.js", "/style.css"):
            fn = os.path.join(STATIC, u.path.lstrip("/"))
            ctype = "application/javascript" if fn.endswith(".js") else "text/css"
            return self._file(fn, ctype)
        return self._send(404, {"error": "no route"})

    def do_POST(self):
        u = urlparse(self.path)
        try:
            if u.path == "/api/mixdown":
                req = self._json_body()
                with LOCK:
                    items = req.get("items", [])
                    if not items:
                        raise ValueError("没有可导出的音频块")
                    sr = int(req["sr"])
                    total = float(req["duration"])
                    dst = os.path.join(WORK, "mixdown.wav")
                    for it in items:
                        self._audio(it["path"])
                    dsp.mixdown(items, sr, total, dst)
                with open(dst, "rb") as f:
                    data = f.read()
                return self._send(200, data, "audio/wav")
            if u.path == "/api/upload":
                qs = parse_qs(u.query)
                name = os.path.basename(qs.get("name", ["file"])[0]) or "file"
                n = int(self.headers.get("Content-Length") or 0)
                data = self.rfile.read(n)
                dst = os.path.join(INBOX, "%d_%s" % (int(time.time() * 1000) % 10**10, name))
                with open(dst, "wb") as f:
                    f.write(data)
                ext = os.path.splitext(dst)[1].lower()
                if ext in (".mid", ".midi"):
                    notes = dsp.parse_midi(dst)
                    return self._send(200, {"mid": True, "path": dst, "notes": notes})
                out = _import_media(dst)
                out["uploaded"] = dst
                return self._send(200, out)
            req = self._json_body()
            out = self._dispatch(u.path, req)
            return self._send(200, out)
        except Exception as e:
            return self._send(400, {"error": "%s: %s" % (type(e).__name__, e)})

    def _audio(self, p):
        if not p or not os.path.isfile(p):
            raise ValueError("音频文件不存在: %s" % p)
        return p

    def _dispatch(self, route, req):
        if route == "/api/analyze":          # 音乐结构分析 (确定性信号分析; 按音频内容 hash 缓存)
            p = self._audio(req.get("path", ""))
            res, cached = analysis.analyze_cached(p, ANALYSIS)
            res["fromCache"] = cached
            return res
        if route == "/api/pick-file":        # 桌面端: 后端弹系统文件对话框, 返回选中的路径
            paths, err = _pick_files(str(req.get("kind", "audio")), bool(req.get("multi")))
            if err:
                return {"ok": False, "error": err, "paths": []}
            return {"ok": True, "paths": paths}
        if route == "/api/import-midi":      # 按路径导入 MIDI (桌面端选完文件后走这里)
            p = str(req.get("path", ""))
            if not os.path.isfile(p):
                raise ValueError("MIDI 文件不存在: " + p)
            notes = dsp.parse_midi(p)
            if not notes:
                raise ValueError("MIDI 里没有音符")
            return {"ok": True, "name": os.path.basename(p), "notes": notes}
        if route == "/api/load-audio":
            p = self._audio(req.get("path", ""))
            info = _info(p)
            return {"path": p, "sr": info["sr"], "duration": info["duration"]}
        if route == "/api/peaks":
            p = self._audio(req.get("path", ""))
            return dsp.peaks(p, float(req.get("pps", 50)))
        if route == "/api/render-clip":
            p = self._audio(req.get("path", ""))
            offset = max(0.0, float(req["offset"]))
            win = max(0.05, float(req["win"]))
            pitch = float(req.get("pitch", 0))
            stretch = min(16.0, max(0.1, float(req.get("stretch", 1.0))))
            tk = req.get("takeover") or None
            dst = _render_cached(p, offset, win, pitch, stretch, tk)
            return {"path": dst, "duration": _info(dst)["duration"], "engine": "takeover" if tk else ("rb" if dsp.rubberband_available() else ("psola" if dsp._pm_mod is not None else "world"))}
        if route == "/api/mixdown":
            items = req.get("items", [])
            if not items:
                raise ValueError("工程里没有可导出的音频块")
            sr = int(req["sr"])
            total = float(req["duration"])
            dst = _user_path(req["dest"])
            if os.path.isdir(dst):
                raise ValueError("导出路径是目录: %s" % dst)
            os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
            for it in items:
                self._audio(it["path"])
            dsp.mixdown(items, sr, total, dst)
            return {"ok": True, "dest": dst}
        if route == "/api/save-project":
            dst = _user_path(req["dest"])
            os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
            with open(dst, "w", encoding="utf-8") as f:
                json.dump(req.get("project", {}), f, ensure_ascii=False, indent=1)
            return {"ok": True, "dest": dst}
        if route == "/api/open-project":
            pp = _user_path(req.get("path", ""))
            if not os.path.isfile(pp):
                raise ValueError("工程文件不存在: %s" % pp)
            with open(pp, encoding="utf-8") as f:
                return json.load(f)
        raise ValueError("未知接口 " + route)


def _warm_pool():
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        dsp.save_wav(f.name, np.zeros(4410), 44100)
        POOL.submit(_render_worker, (f.name, 0.0, 0.1, 0.0, 1.0, None, f.name + ".r.wav")).result()
        os.unlink(f.name)
        if os.path.exists(f.name + ".r.wav"):
            os.unlink(f.name + ".r.wav")


PORT = int(os.environ.get("VE_PORT", "8765"))


def _open_browser():
    time.sleep(0.9)
    url = "http://127.0.0.1:%d/" % PORT
    for cmd in (["xdg-open", url], ["gio", "open", url], ["open", url]):
        try:
            subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return
        except Exception:
            continue
    print("没能自动打开浏览器, 请手动访问 " + url, flush=True)


def main():
    if "--check" in sys.argv:
        raise SystemExit(0 if ve_env.check(strict=True) else 2)
    if os.environ.get("VE_QUIET") != "1":      # 启动器已经体检过了 → 不重复刷表
        ve_env.check()
    _warm_pool()
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    except OSError as e:
        if getattr(e, "errno", None) == 98:    # EADDRINUSE: 给能照做的提示, 不是丢一堆 traceback
            print("端口 %d 已被占用 —— 多半是上一次没退干净的 vocal-editor。" % PORT, flush=True)
            print("  谁占着:  ss -ltnp | grep %d" % PORT, flush=True)
            print("  结束它:  pkill -f 'vocal-editor|server.py'", flush=True)
            print("  换端口:  启动时带上 VE_PORT=8766", flush=True)
            raise SystemExit(2)
        raise
    print("vocal-editor v2: http://127.0.0.1:%d  (engine=%s)" % (PORT, dsp.ENGINE), flush=True)
    print("数据目录: %s" % DATA, flush=True)
    if os.environ.get("VE_OPEN"):
        threading.Thread(target=_open_browser, daemon=True).start()
    srv.serve_forever()


if __name__ == "__main__":
    main()
