#!/usr/bin/env python3
"""启动闪屏 (REAPER/AE 那种): 让你看得见"在启动 / 没卡死", 启动失败也能直接看到原因。

用【系统的 python3 + python3-gi】跑 (和 window.py 一路)。launch.sh 把启动进度写进日志文件,
这里 tail 它: 出现 READY 自动关, 出现 FAIL 就停住并把红字留在屏幕上。

    python3 splash.py <日志文件>

注意: logo 用纯 GTK 控件拼 (不用 cairo) —— 不少发行版没装 python3-gi-cairo,
      那样 cairo 的 draw 回调会抛 "foreign struct converter for cairo.Context"。
"""
import sys

try:
    import gi
    gi.require_version("Gtk", "3.0")
    from gi.repository import Gtk, Gdk, GLib
except Exception as e:
    sys.stderr.write("splash.py: 没有 GTK (%s)\n" % e)
    sys.exit(3)

LOG = sys.argv[1] if len(sys.argv) > 1 else "/tmp/vocal-editor-start.log"
TAIL_N = 14
BG = (0.086, 0.106, 0.145, 1.0)      # 深底
BAND = (0.027, 0.043, 0.078, 1.0)    # 稍亮的横带


def read_tail(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()
    except OSError:
        return []
    return lines[-TAIL_N:]


def colored(widget, rgba):
    try:
        widget.override_background_color(Gtk.StateFlags.NORMAL, Gdk.RGBA(*rgba))
    except Exception:
        pass


class Splash:
    def __init__(self):
        self.win = Gtk.Window(title="Vocal Editor — 启动中")
        self.win.set_decorated(False)
        self.win.set_default_size(470, 330)
        self.win.set_position(Gtk.WindowPosition.CENTER)
        self.win.set_keep_above(True)
        try:
            self.win.set_type_hint(Gtk.WindowTypeHint.SPLASHSCREEN)
        except Exception:
            pass
        self.win.connect("destroy", Gtk.main_quit)
        colored(self.win, BG)

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self.win.add(box)

        # ---- 顶部 logo: 深色横带 + 大字标 + 两条品牌色细条 (纯控件) ----
        band = Gtk.EventBox()
        colored(band, BAND)
        band.set_size_request(470, 104)
        bb = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        bb.set_valign(Gtk.Align.CENTER)
        band.add(bb)
        wave = Gtk.Label()
        wave.set_markup('<span size="xx-large" foreground="#f43f5e" letter_spacing="2048">'
                        '▁▂▄▆▇▅▃▂▄▇▅▂▁▃▆▇▄▂▁</span>')
        bb.pack_start(wave, False, False, 0)
        name = Gtk.Label()
        name.set_markup('<span size="x-large" weight="bold" foreground="#e6edf7" letter_spacing="1024">'
                        'VOCAL EDITOR</span>')
        bb.pack_start(name, False, False, 0)
        sub = Gtk.Label()
        sub.set_markup('<span size="small" foreground="#7d8ba1">人力VOCAL 编辑器 · MIDI 接管音高 · 普通变调</span>')
        bb.pack_start(sub, False, False, 0)
        box.pack_start(band, False, False, 0)
        bar = Gtk.EventBox()                      # 青色细条 (whip 主色)
        colored(bar, (0.17, 0.83, 0.75, 1.0))
        bar.set_size_request(470, 3)
        box.pack_start(bar, False, False, 0)

        # ---- 当前状态行 ----
        self.status = Gtk.Label(label="正在准备…")
        self.status.set_margin_top(8)
        box.pack_start(self.status, False, False, 0)

        # ---- 日志区 (像命令行一样滚动) ----
        self.buf = Gtk.TextBuffer()
        tv = Gtk.TextView(buffer=self.buf)
        tv.set_editable(False)
        tv.set_cursor_visible(False)
        tv.set_left_margin(8)
        tv.set_top_margin(6)
        css = Gtk.CssProvider()
        try:
            css.load_from_data(b"textview{font-family:monospace;font-size:9pt}")
            Gtk.StyleContext.add_provider_for_screen(
                Gdk.Screen.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        except Exception:
            pass
        sw = Gtk.ScrolledWindow()
        sw.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
        sw.set_margin_top(8)
        sw.set_margin_start(14)
        sw.set_margin_end(14)
        sw.set_margin_bottom(10)
        sw.add(tv)
        box.pack_start(sw, True, True, 0)
        self.tv = tv

        self.close_btn = Gtk.Button(label="关闭")
        self.close_btn.set_margin_bottom(8)
        self.close_btn.connect("clicked", lambda *_a: Gtk.main_quit())
        box.pack_start(self.close_btn, False, False, 0)
        self.close_btn.hide()

        self.win.show_all()
        self.t0 = GLib.get_monotonic_time()
        GLib.timeout_add(150, self.tick)

    def tick(self):
        lines = read_tail(LOG)
        txt = "\n".join(lines)
        cur = self.buf.get_text(self.buf.get_start_iter(), self.buf.get_end_iter(), False)
        if txt != cur:
            self.buf.set_text(txt)
            self.tv.scroll_to_iter(self.buf.get_end_iter(), 0.0, False, 0.0, 0.0)
        status = "正在启动…"
        for ln in reversed(lines):
            if ln.startswith("FAIL"):
                self.status.set_markup('<span color="#f43f5e" weight="bold">'
                                       '启动失败 —— 看下面日志（把这段发给作者）</span>')
                self.close_btn.show()
                return True
            if ln.startswith("READY"):
                Gtk.main_quit()
                return False
            if ln.strip():
                status = ln.strip()[:70]
                break
        self.status.set_text(status)
        if GLib.get_monotonic_time() - self.t0 > 180 * 1000000:   # 兜底
            self.status.set_markup('<span color="#f59e0b">启动很久了 —— 看下面日志，或直接关掉</span>')
            self.close_btn.show()
        return True


def main():
    Splash()
    Gtk.main()
    return 0


if __name__ == "__main__":
    sys.exit(main())
