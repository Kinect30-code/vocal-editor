#!/usr/bin/env bash
# vocal-editor 启动器: 起后端 → 开一个【真正的应用窗口】→ 关窗口即退出。
#
#   ./launch.sh              默认: Chromium 应用窗口 (无地址栏; WebAudio/输出设备选择最完整)
#   ./launch.sh --native     原生 GTK+WebKit2 窗口 (用系统 python3-gi)
#   ./launch.sh --chromium   强制 Chromium 应用窗口
#   ./launch.sh --browser    用默认浏览器
#   ./launch.sh --no-window  只起服务 (服务器/远程访问)
#   ./launch.sh --check      只做依赖自检
#   ./launch.sh --probe      看端口上是自己实例 / 别的程序 / 空闲
#
# 环境变量: VE_PYTHON 指定后端解释器 · VE_PORT 改端口 (默认 8765)
#           VE_SELFTEST=1 窗口自测 · VE_NO_SPLASH=1 不要启动闪屏
#
# 启动过程会同时写进日志 ($VE_LOG, 默认 /tmp/vocal-editor-start.log), 闪屏(splash.py)读它显示进度;
# 双击图标没有终端时, 闪屏就是唯一的反馈 —— 所以启动失败务必留下 FAIL 行。
set -uo pipefail
cd "$(dirname "$0")"
HERE=$(pwd)

MODE=auto
for a in "$@"; do
  case "$a" in
    --browser) MODE=browser ;;
    --chromium) MODE=chromium ;;
    --native) MODE=native ;;
    --no-window) MODE=server ;;
    --check) MODE=check ;;
    --probe) MODE=probe ;;
  esac
done

# 后端解释器: 打包版用自带的 vocal-editor (入口在二进制里), 源码版用 .venv
PY=${VE_PYTHON:-}
if [ -z "$PY" ]; then
  if [ -x "$HERE/vocal-editor" ]; then PY="$HERE/vocal-editor"
  elif [ -x "$HERE/.venv/bin/python" ]; then PY="$HERE/.venv/bin/python"
  else PY=$(command -v python3); fi
fi
# 源码运行有 server.py / ve_env.py; 打包运行这两个都在二进制里
if [ -f "$HERE/server.py" ]; then SRV_ARG="server.py"; else SRV_ARG=""; fi
PORT="${VE_PORT:-8765}"
URL="http://127.0.0.1:${PORT}/"
LOG="${VE_LOG:-${XDG_RUNTIME_DIR:-/tmp}/vocal-editor-start.log}"

say() {   # 进度行: 有终端就打终端, 同时进日志给闪屏看
  printf '%s\n' "$*" | tee -a "$LOG" 2>/dev/null || printf '%s\n' "$*" >>"$LOG"
}

if [ "$MODE" = check ]; then      # 只看依赖
  if [ -f "$HERE/ve_env.py" ]; then "$PY" ve_env.py; else "$PY" --check; fi
  exit $?
fi

if [ "$MODE" = server ]; then    # 只起服务
  "$PY" $SRV_ARG
  exit $?
fi

# 端口探测: bash 原生 /dev/tcp, 不依赖任何解释器
# (踩过的坑: 以前用 "$PY" - <<PY 跑内联 python —— 打包版里 $PY 是冻结二进制, 会被当成"再起一个服务"抢端口)
port_says_ours() {
  local resp
  { exec 3<>"/dev/tcp/127.0.0.1/${PORT}"; } 2>/dev/null || return 1
  printf 'GET /api/info HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n' >&3 2>/dev/null || { exec 3<&- 3>&-; return 1; }
  resp=$(timeout 3 cat <&3 2>/dev/null)
  exec 3<&- 3>&- 2>/dev/null
  case "$resp" in *'"engine"'*) return 0 ;; esac
  return 1
}
port_busy() {
  { exec 3<>"/dev/tcp/127.0.0.1/${PORT}"; } 2>/dev/null || return 1
  return 0
}

if [ "$MODE" = probe ]; then
  if port_says_ours; then echo "${PORT}: 是 vocal-editor 实例"
  elif port_busy; then echo "${PORT}: 被别的程序占用"
  else echo "${PORT}: 空闲"; fi
  exit 0
fi

# ---------------- 启动闪屏 (有图形环境 + 系统 python3-gi 才开) ----------------
SPLASH=""
: >"$LOG"
if [ -z "${VE_NO_SPLASH:-}" ] && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  for p in "$HERE/splash.py" "$HERE/../share/vocal-editor/splash.py" "$HERE/usr/share/vocal-editor/splash.py"; do
    [ -f "$p" ] && SPLASH="$p" && break
  done
  if [ -n "$SPLASH" ] && python3 -c "import gi;gi.require_version('Gtk','3.0')" >/dev/null 2>&1; then
    python3 "$SPLASH" "$LOG" >/dev/null 2>&1 &
    SPLASH_PID=$!
  else
    SPLASH=""
  fi
fi
say "Vocal Editor 启动中…  (端口 ${PORT})"

cleanup() {
  if [ "$SRV" = "byport" ]; then      # 用的是别人的实例: 按端口找到它再结束
    local p
    p=$(ss -ltnpH "sport = :${PORT}" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1)
    [ -n "$p" ] && kill "$p" 2>/dev/null
  else
    [ -n "$SRV" ] && kill "$SRV" 2>/dev/null
  fi
  [ -n "${SPLASH_PID:-}" ] && kill "$SPLASH_PID" 2>/dev/null
}
trap cleanup EXIT INT TERM

# ---------------- 依赖自检 ----------------
say "→ 依赖自检…"
if [ -f "$HERE/ve_env.py" ]; then
  if ! "$PY" ve_env.py >/dev/null 2>&1; then
    say "  自检有缺失项 (下面列出, 不致命):"
    "$PY" ve_env.py 2>&1 | sed 's/^/  /' | tee -a "$LOG"
  fi
else
  "$PY" --check >/dev/null 2>&1 || say "  自检有缺失项 (见日志)"
fi

# ---------------- 起后端 ----------------
SRV=""
if port_says_ours; then
  say "→ 端口 ${PORT} 上已有 vocal-editor 在跑, 直接用它"
  SRV="byport"
elif port_busy; then
  say "FAIL 端口 ${PORT} 被别的程序占用了。"
  say "     换个端口:  VE_PORT=8766 $0"
  say "     或先查:    ss -ltnp | grep ${PORT}"
  exit 1
else
  say "→ 启动后端 (端口 ${PORT})…"
  # shellcheck disable=SC2086
  VE_QUIET=1 VE_DESKTOP=1 "$PY" $SRV_ARG >>"$LOG" 2>&1 &
  SRV=$!
  for _ in $(seq 1 80); do port_says_ours && break; sleep 0.25; done
  if ! port_says_ours; then
    say "FAIL 后端没起来 —— 最后几行日志:"
    tail -n 6 "$LOG" | sed 's/^/     /' | tee -a "$LOG"
    exit 1
  fi
fi
say "→ 后端就绪 (http://127.0.0.1:${PORT}/)"

# ---------------- 开窗口 ----------------
window_py() {   # 源码: 同目录; 打包: usr/share/vocal-editor/
  local p
  for p in "$HERE/window.py" "$HERE/../share/vocal-editor/window.py" "$HERE/usr/share/vocal-editor/window.py"; do
    [ -f "$p" ] && { printf '%s' "$p"; return 0; }
  done
  return 1
}
sys_py() {      # 系统的 python3 能不能跑 GTK+WebKit2
  local c
  for c in python3 /usr/bin/python3; do
    command -v "$c" >/dev/null 2>&1 || continue
    "$c" -c "import gi;gi.require_version('WebKit2','4.1');from gi.repository import WebKit2" >/dev/null 2>&1 \
      && { command -v "$c"; return 0; }
  done
  return 1
}
browser_profile() {   # snap 版浏览器访问不了 ~/.local 这类隐藏目录 → 给它 ~/snap/<name>/common
  # 注意: /snap/bin/chromium 是软链到 /usr/bin/snap, readlink -f 会拿到 /usr/bin/snap ✗
  #      所以要先看命令路径本身, 再看解析后的路径
  local cmd exe snap=""
  cmd=$(command -v "$1" 2>/dev/null || printf '%s' "$1")
  case "$cmd" in
    /snap/bin/*) snap=$(printf '%s' "$cmd" | cut -d/ -f4) ;;
    /snap/*) snap=$(printf '%s' "$cmd" | cut -d/ -f3) ;;
    *)
      exe=$(readlink -f "$cmd" 2>/dev/null || printf '%s' "$cmd")
      case "$exe" in /snap/*) snap=$(printf '%s' "$exe" | cut -d/ -f3) ;; esac ;;
  esac
  if [ -n "$snap" ]; then
    printf '%s' "$HOME/snap/$snap/common/vocal-editor-profile"
  else
    printf '%s' "${XDG_DATA_HOME:-$HOME/.local/share}/vocal-editor/browser-profile"
  fi
}
open_native() {
  local wp sp
  wp=$(window_py) || return 1
  sp=$(sys_py) || return 1
  say "→ 打开原生窗口 (GTK + WebKit2)…"
  if [ "${VE_SELFTEST:-}" = "1" ]; then VE_SELFTEST=1 "$sp" "$wp" "$URL" >>"$LOG" 2>&1; return $?; fi
  "$sp" "$wp" "$URL" >>"$LOG" 2>&1
  return $?
}
open_appwin() {
  local b prof
  for b in chromium chromium-browser google-chrome google-chrome-stable brave-browser microsoft-edge; do
    command -v "$b" >/dev/null 2>&1 || continue
    prof=$(browser_profile "$(command -v "$b")")
    mkdir -p "$prof" 2>/dev/null || { say "  ! 建不了 profile 目录 $prof, 换下一个"; continue; }
    say "→ 打开应用窗口 ($b --app, 无地址栏, profile: $prof)"
    setsid "$b" --app="$URL" --window-size=1500,950 --user-data-dir="$prof" \
      --no-first-run --no-default-browser-check >>"$LOG" 2>&1 &
    local i
    for i in $(seq 1 30); do            # 等窗口进程真起来; 起不来就换下一个 (snap 被挡时就是这种情况)
      sleep 0.2
      pgrep -f "app=$URL" >/dev/null 2>&1 && return 0
    done
    say "  ! $b 没能起窗口 (多为沙盒/权限限制), 换下一个"
  done
  return 1
}
open_default() { say "→ 用默认浏览器打开 $URL"; xdg-open "$URL" >/dev/null 2>&1 || true; }

case "$MODE" in
  browser) open_default; say READY; say "   关掉这个终端 (Ctrl+C) 即退出。"; wait $SRV ;;
  chromium)
    if open_appwin; then say READY; say "   关掉这个终端 (Ctrl+C) 即退出。"; wait $SRV
    else open_default; say READY; wait $SRV; fi ;;
  native)
    if window_py >/dev/null && sys_py >/dev/null; then say READY; open_native; exit 0; fi
    say "FAIL 原生窗口不可用 (缺 python3-gi / WebKit2GTK)"; exit 1 ;;
  *)
    # 默认走 Chromium 应用窗口: WebAudio 与"输出设备选择"最完整 (GTK/WebKit 那层在部分机器上不出声)
    if open_appwin; then
      say READY; say "   关掉这个终端 (Ctrl+C) 即退出。"; wait $SRV
    elif window_py >/dev/null && sys_py >/dev/null; then
      say READY; say "   正在打开原生窗口 (GTK + WebKit2)…"
      open_native; exit 0               # 原生窗口阻塞: 关窗口 → 退出, trap 收掉后端
    else
      open_default; say READY; say "   关掉这个终端 (Ctrl+C) 即退出。"; wait $SRV
    fi ;;
esac
