#!/usr/bin/env python3
"""后端文件选择器: 在用户桌面上弹一个真正的 GTK 文件对话框, 把选中的路径打到 stdout。

为什么要有它: 桌面窗口用的浏览器引擎可能被沙盒限制 (snap 版 Chromium 就选不了文件),
而**后端是普通进程, 路径随便读** —— 所以"选文件"这件事交给后端做最可靠。

    python3 pickfile.py audio|midi|project [--multi]

返回: 每行一个绝对路径 (取消=不输出任何行); 出错时非 0 退出并往 stderr 写原因。
"""
import os
import sys
import warnings

warnings.filterwarnings("ignore", category=DeprecationWarning)

try:
    import gi
    gi.require_version("Gtk", "3.0")
    from gi.repository import Gtk, Gdk
except Exception as e:
    sys.stderr.write("没有可用的 GTK/python3-gi: %s\n" % e)
    sys.exit(3)

KIND = sys.argv[1] if len(sys.argv) > 1 else "audio"
MULTI = "--multi" in sys.argv

TITLE = {"audio": "导入音频 / 媒体", "midi": "导入 MIDI", "project": "打开工程 (.json)"}
FILTERS = {
    "audio": [("音频 / 媒体",
               "*.wav *.flac *.mp3 *.m4a *.m4s *.aac *.ogg *.opus *.oga *.wma "
               "*.mp4 *.webm *.mkv *.mov *.avi *.ts *.flv *.3gp")],
    "midi": [("MIDI", "*.mid *.midi")],
    "project": [("工程 JSON", "*.json")],
}


def main():
    dlg = Gtk.FileChooserDialog(title=TITLE.get(KIND, "选择文件"),
                                action=Gtk.FileChooserAction.OPEN)
    dlg.add_buttons("取消", Gtk.ResponseType.CANCEL, "打开", Gtk.ResponseType.OK)
    dlg.set_select_multiple(MULTI)
    for name, pats in FILTERS.get(KIND, []):
        f = Gtk.FileFilter()
        f.set_name(name)
        for p in pats.split():
            f.add_pattern(p)
        dlg.add_filter(f)
    allf = Gtk.FileFilter()          # 兜底: 扩展名没匹配上也能选
    allf.set_name("所有文件")
    allf.add_pattern("*")
    dlg.add_filter(allf)

    start = os.environ.get("VE_PICK_DIR") or os.path.expanduser("~/Downloads")
    if not os.path.isdir(start):
        start = os.path.expanduser("~")
    if os.path.isdir(start):
        try:
            dlg.set_current_folder(start)
        except Exception:
            pass
    try:
        dlg.set_keep_above(True)
        dlg.set_position(Gtk.WindowPosition.CENTER)
    except Exception:
        pass
    # 让对话框在当前桌面上显眼一点 (有些 Wayland 合成器不会自动聚焦)
    try:
        dlg.get_window().set_events(dlg.get_window().get_events())
    except Exception:
        pass

    resp = dlg.run()
    paths = list(dlg.get_filenames()) if resp == Gtk.ResponseType.OK else []
    dlg.destroy()
    for p in paths:
        print(p)
    return 0


if __name__ == "__main__":
    sys.exit(main())
