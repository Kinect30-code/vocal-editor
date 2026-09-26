#!/usr/bin/env bash
# 打一个自带运行环境的单文件 AppImage: Python 3.12 + numpy/pyworld/parselmouth + 静态 ffmpeg + rubberband
# 目标机不需要装 Python / ffmpeg, 双击即用 (浏览器会自动打开 http://127.0.0.1:8765/)。
#
#   打包机准备:  ./run.sh 能正常跑 + uv pip install --python .venv/bin/python pyinstaller imageio-ffmpeg
#   打包:        ./build_appimage.sh
#   产物:        dist/VocalEditor-x86_64.AppImage
#   目标机自检:  ./VocalEditor-x86_64.AppImage --check
#
# 注意: AppImage 里的 glibc 是打包机上的版本 (不打包 glibc)。在很新的发行版上打包, 老发行版会打不开 ——
#       要兼容老系统就在老的系统 (或老容器) 里打包。打不开时先跑 --check 看缺什么。
set -euo pipefail
cd "$(dirname "$0")"
NAME=VocalEditor
APP=vocal-editor
OUT=dist
BLD=build/appimage
PY=.venv/bin/python
export PATH="$HOME/.local/bin:$PATH"

[ -x "$PY" ] || { echo "找不到 $PY (先建虚拟环境装依赖)"; exit 1; }

echo "== 0/5 打包前自检 =="
"$PY" ve_env.py || { echo "关键依赖缺失, 补齐后再打包"; exit 1; }
"$PY" -c "import PyInstaller" 2>/dev/null || { echo "缺 pyinstaller: uv pip install --python $PY pyinstaller imageio-ffmpeg"; exit 1; }

echo "== 1/5 PyInstaller (Python + numpy/pyworld/parselmouth 全部打进去) =="
rm -rf build/pyi "$OUT"
"$PY" -m PyInstaller --noconfirm --clean --onedir --name "$APP" \
  --distpath "$PWD/build/pyi/dist" --workpath "$PWD/build/pyi/work" --specpath "$PWD/build/pyi" \
  --add-data "$PWD/static:static" --add-data "$PWD/demo:demo" \
  --hidden-import pyworld --hidden-import parselmouth --hidden-import mido \
  "$PWD/server.py"

echo "== 2/5 组装 AppDir =="
rm -rf "$BLD/$NAME.AppDir"; AD="$BLD/$NAME.AppDir"
mkdir -p "$AD/usr/bin" "$AD/usr/lib" "$AD/usr/share/applications" "$AD/usr/share/icons/hicolor/256x256/apps"
cp -r "build/pyi/dist/$APP" "$AD/usr/lib/$APP"

# rubberband + 它的"非核心"依赖库 (libc/libstdc++/libm 留给目标机, 免得 glibc 打架)
if command -v rubberband >/dev/null 2>&1; then
  cp "$(command -v rubberband)" "$AD/usr/bin/"
  ldd "$(command -v rubberband)" | awk '{print $3}' | grep '^/' | while read -r so; do
    case "$(basename "$so")" in
      libc.so*|libm.so*|libmvec*|libgcc_s*|libstdc++*|ld-linux*) continue ;;
    esac
    cp -n "$so" "$AD/usr/lib/" || true
  done
  echo "  rubberband + $(ls "$AD/usr/lib" | wc -l) 个依赖库 已打入"
else
  echo "  !! 本机没有 rubberband — 变速会走 PSOLA (音质略降)"
fi

# ffmpeg: 必须用静态版 (系统版链了上百个 .so, 换机器必挂)
FF=$("$PY" -c "import imageio_ffmpeg,sys;sys.stdout.write(imageio_ffmpeg.get_ffmpeg_exe())" 2>/dev/null || true)
if [ -n "${FF:-}" ] && [ -f "$FF" ]; then
  cp "$FF" "$AD/usr/bin/ffmpeg"; echo "  静态 ffmpeg 已打入 ($(du -h "$FF" | cut -f1))"
else
  echo "  !! 没拿到静态 ffmpeg (uv pip install imageio-ffmpeg) — mp3/mp4 导入会不可用"
fi

# 图标: 直接用脚本生成 256x256 PNG, 不依赖任何外部素材
"$PY" - "$AD" <<'PYEOF'
import math, os, struct, sys, zlib
ad = sys.argv[1]
W = H = 256
rows = bytearray()
for y in range(H):
    rows.append(0)
    for x in range(W):
        t = (x / W) * 0.7 + (y / H) * 0.3
        r, g, b = int(22 + 36 * t), int(28 + 86 * t), int(38 + 148 * t)
        wy = H * 0.5 + 42 * math.sin(x / W * 6.2831853 * 3.0)
        if abs(y - wy) < 7:
            r, g, b = 244, 63, 94
        rows += bytes((r, g, b))
def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)
png = (b"\x89PNG\r\n\x1a\n"
       + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0))
       + chunk(b"IDAT", zlib.compress(bytes(rows), 9))
       + chunk(b"IEND", b""))
for p in (os.path.join(ad, "vocal-editor.png"),
          os.path.join(ad, "usr/share/icons/hicolor/256x256/apps/vocal-editor.png"),
          os.path.join(ad, ".DirIcon")):
    open(p, "wb").write(png)
print("  icon ok")
PYEOF

cat > "$AD/vocal-editor.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Vocal Editor
Comment=人力VOCAL 编辑器 (MIDI 接管音高 + MIDI 离散块 + 普通变调)
Exec=vocal-editor
Icon=vocal-editor
Categories=AudioVideo;Audio;AudioVideoEditing;
Terminal=false
EOF
cp "$AD/vocal-editor.desktop" "$AD/usr/share/applications/vocal-editor.desktop"

cat > "$AD/usr/bin/vocal-editor" <<'EOF'
#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")/.."
exec "$HERE/lib/vocal-editor/vocal-editor" "$@"
EOF
chmod +x "$AD/usr/bin/vocal-editor"

# 启动器 + 原生窗口程序 (window.py 用【系统的】python3-gi 跑, 见文件头说明)
cp launch.sh "$AD/usr/bin/launch.sh"; chmod +x "$AD/usr/bin/launch.sh"
mkdir -p "$AD/usr/share/vocal-editor"; cp window.py splash.py pickfile.py "$AD/usr/share/vocal-editor/"

cat > "$AD/AppRun" <<'EOF'
#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
export PATH="$HERE/usr/bin:$PATH"
export LD_LIBRARY_PATH="$HERE/usr/lib:${LD_LIBRARY_PATH:-}"
# launch.sh: 起后端 → 开原生窗口 (GTK+WebKit2, 退回 chromium --app=, 再退回浏览器) → 关窗即退出
exec "$HERE/usr/bin/launch.sh" "$@"
EOF
chmod +x "$AD/AppRun"

echo "== 3/5 appimagetool =="
TOOL=build/appimagetool-x86_64.AppImage
if [ ! -x "$TOOL" ]; then
  echo "  下载 appimagetool…"
  curl -fsSL -o "$TOOL" https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage \
    || { echo "  下载失败 (没网络?)"; }
  [ -s "$TOOL" ] && chmod +x "$TOOL" || true
fi
mkdir -p "$OUT"
if [ -x "$TOOL" ]; then
  RT=build/runtime-x86_64
  [ -s "$RT" ] || { echo "  下载 AppImage runtime…"; curl -fsSL -o "$RT" https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-x86_64 || true; chmod +x "$RT" 2>/dev/null; }
  ARCH=x86_64 "$TOOL" --appimage-extract-and-run --no-appstream ${RT:+"--runtime-file" "$RT"} "$AD" "$OUT/$NAME-x86_64.AppImage" \
    || { echo "  appimagetool 失败: AppDir 已就绪, 手动执行 ARCH=x86_64 $TOOL $AD $OUT/$NAME-x86_64.AppImage"; }
else
  echo "  没有 appimagetool: AppDir 已就绪 ($AD), 可自己再打"
fi

echo "== 4/5 冒烟测试 (解包运行 --check, 不需要 FUSE) =="
if [ -f "$OUT/$NAME-x86_64.AppImage" ]; then
  "$OUT/$NAME-x86_64.AppImage" --appimage-extract-and-run --check || echo "  (自检有缺失项, 见上)"
else
  "$AD/AppRun" --check || true
fi

echo "== 5/5 完成 =="
ls -lh "$OUT"/"$NAME"-x86_64.AppImage 2>/dev/null || echo "  只产出 AppDir: $AD"
