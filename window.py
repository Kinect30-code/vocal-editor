#!/usr/bin/env python3
"""原生桌面窗口 (GTK3 + WebKit2GTK), 给 vocal-editor 一个真正的应用窗口 —— 不是浏览器标签页。

用【系统的 python3 + python3-gi】运行 (gi 是系统绑定, 没法装进 venv):
    python3 window.py [url]
桌面发行版基本都自带 python3-gi + gir1.2-webkit2-4.1 (GNOME/KDE 一堆程序用它);
没有的话 launch.sh 会自动退回 chromium --app= / 浏览器。

- 关窗口 = 退出 (launch.sh 收到退出码后关掉后端服务)
- 下载 (导出混音) 存到 ~/Downloads, 并在终端打印落盘路径
"""
import os
import sys

try:
    import gi
    gi.require_version("Gtk", "3.0")
    gi.require_version("WebKit2", "4.1")
    from gi.repository import Gtk, WebKit2, GLib
except Exception as e:                       # 系统没有 gi/webkit → 让 launch.sh 走别的路子
    sys.stderr.write("window.py: 没有可用的 GTK/WebKit2 (%s)\n" % e)
    sys.exit(3)

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/"
SELFTEST = os.environ.get("VE_SELFTEST") == "1"


def download_dir():
    d = os.path.join(os.path.expanduser("~"), "Downloads")
    if not os.path.isdir(d):
        try:
            os.makedirs(d, exist_ok=True)
        except Exception:
            d = os.path.expanduser("~")
    return d


def pick_name(suggested):
    """同名不覆盖: mixdown.wav → mixdown-2.wav"""
    base, ext = os.path.splitext(suggested or "download")
    path = os.path.join(download_dir(), (base + ext))
    i = 2
    while os.path.exists(path):
        path = os.path.join(download_dir(), "%s-%d%s" % (base, i, ext))
        i += 1
    return path


def main():
    win = Gtk.Window(title="Vocal Editor")
    win.set_default_size(1500, 950)
    win.set_position(Gtk.WindowPosition.CENTER)

    view = WebKit2.WebView()
    view.set_zoom_level(float(os.environ.get("VE_ZOOM", "1")))
    win.add(view)

    def on_load(_v, ev):
        if ev == WebKit2.LoadEvent.FINISHED:
            sys.stdout.write("窗口已加载: %s\n" % URL)
            sys.stdout.flush()
            if SELFTEST:
                # 自测: 走应用导出用的同一条路 (Blob + <a download>) → 验证下载落盘
                view.run_javascript(
                    "(function(){var b=new Blob([new Uint8Array([82,73,70,70])],{type:'audio/wav'});"
                    "var a=document.createElement('a');a.href=URL.createObjectURL(b);"
                    "a.download='ve-download-test.wav';document.body.appendChild(a);a.click();})()",
                    None, None, None)
                GLib.timeout_add(2500, Gtk.main_quit)

    def on_download(_ctx, dl):
        def decide(d, suggested):
            p = pick_name(suggested)
            d.set_destination("file://" + p)
            sys.stdout.write("下载中: %s\n" % p)
            sys.stdout.flush()
            return True
        try:
            dl.connect("decide-destination", decide)
        except Exception:
            pass

        def finished(d):
            dest = d.get_destination() or ""
            sys.stdout.write("已保存: %s\n" % dest.replace("file://", ""))
            sys.stdout.flush()
            if SELFTEST:
                Gtk.main_quit()
        try:
            dl.connect("finished", finished)
        except Exception:
            pass

    # 下载信号在 WebKitWebView / WebContext 上都有版本差异, 两边都试
    for obj, sig in ((view, "download-started"), (view.get_context(), "download-started")):
        try:
            obj.connect(sig, on_download)
        except Exception:
            pass

    view.connect("load-changed", on_load)
    win.connect("destroy", Gtk.main_quit)
    win.show_all()
    if SELFTEST:
        GLib.timeout_add(30000, Gtk.main_quit)      # 兜底, 别把自测挂死
    view.load_uri(URL)
    Gtk.main()
    return 0


if __name__ == "__main__":
    sys.exit(main())
