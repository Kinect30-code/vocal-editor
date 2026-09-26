#!/usr/bin/env bash
# vocal-editor 启动器: 起后端服务 → 开一个【真正的应用窗口】→ 关窗口即退出。
#
#   ./launch.sh              原生窗口 (GTK + WebKit2, 用系统 python3-gi) → 失败退回 chromium --app=
#   ./launch.sh --chromium   应用窗口用 Chromium 开 (声音最稳)
#   ./launch.sh --browser    直接用默认浏览器
#   ./launch.sh --no-window  只起服务 (放服务器上/远程访问用)
#   ./launch.sh --check      只做依赖自检
#
# 环境变量: VE_PYTHON 指定后端解释器 · VE_PORT 改端口 (默认 8765) · VE_SELFTEST=1 窗口自测
set -uo pipefail
cd "$(dirname "$0")"
HERE=$(pwd)

MODE=auto
for a in "$@"; do
  case "$a" in
    --browser) MODE=browser ;;
    --chromium) MODE=chromium ;;   # 无地址栏的应用窗口用 Chromium 开 (声音最稳, 网页引擎侧没声音时的兜底)
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
URL="http://127.0.0.1:8765/"
# 源码运行有 server.py / ve_env.py; 打包运行这两个都在二进制里
if [ -f "$HERE/server.py" ]; then SRV_ARG="server.py"; else SRV_ARG=""; fi

if [ "$MODE" = check ]; then      # 只看依赖, 不起服务
  if [ -f "$HERE/ve_env.py" ]; then "$PY" ve_env.py; else "$PY" --check; fi
  exit $?
fi

if [ "$MODE" = server ]; then    # 只起服务 (远程/服务器用)
  "$PY" $SRV_ARG
  exit $?
fi

# 依赖自检: 有问题才打印 (服务端自己会打印完整表格, 免得刷两遍)
if [ -f "$HERE/ve_env.py" ]; then
  "$PY" ve_env.py >/dev/null 2>&1 || { echo "依赖自检有问题:"; "$PY" ve_env.py; }
else
  "$PY" --check >/dev/null 2>&1 || { echo "依赖自检有问题:"; "$PY" --check; }
fi

PORT="${VE_PORT:-8765}"
URL="http://127.0.0.1:${PORT}/"

# 端口探测: 用 bash 原生 /dev/tcp, 不依赖任何解释器。
# (踩过的坑: 以前这里写 "$PY" - <<PY 跑内联 python —— 打包版里 $PY 是冻结二进制,
#  会被当成"再启动一个服务" → 两个服务抢 8765 → Address already in use / 卡住)
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

if [ "$MODE" = probe ]; then      # 排查用: 看端口上是谁
  if port_says_ours; then echo "${PORT}: 是 vocal-editor 实例"
  elif port_busy; then echo "${PORT}: 被别的程序占用"
  else echo "${PORT}: 空闲"; fi
  exit 0
fi

SRV=""
if port_says_ours; then
  echo "端口 ${PORT} 上已经有一个 vocal-editor 在跑 —— 直接用它开窗口 (关窗口时会一起结束它)"
  SRV="byport"
elif port_busy; then
  echo "端口 ${PORT} 被别的程序占用了。换个端口:  VE_PORT=8766 $0"
  exit 1
else
  echo "启动后端… (端口 ${PORT})"
  # shellcheck disable=SC2086
  VE_QUIET=1 "$PY" $SRV_ARG &
  SRV=$!
  for _ in $(seq 1 80); do port_says_ours && break; sleep 0.25; done
  if ! port_says_ours; then echo "后端没起来, 看上面的报错"; exit 1; fi
fi

cleanup() {
  if [ "$SRV" = "byport" ]; then      # 用的是别人的实例: 按端口找到它再结束
    local p
    p=$(ss -ltnpH "sport = :${PORT}" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1)
    [ -n "$p" ] && kill "$p" 2>/dev/null
  else
    [ -n "$SRV" ] && kill "$SRV" 2>/dev/null
  fi
}
trap cleanup EXIT INT TERM

window_py() {   # 源码: 同目录; 打包: usr/share/vocal-editor/
  local p
  for p in "$HERE/window.py" "$HERE/../share/vocal-editor/window.py" "$HERE/usr/share/vocal-editor/window.py"; do
    [ -f "$p" ] && { printf '%s' "$p"; return 0; }
  done
  return 1
}
sys_py() {      # 系统的 python3 能不能跑 GTK+WebKit2 窗口
  local c
  for c in python3 /usr/bin/python3; do
    command -v "$c" >/dev/null 2>&1 || continue
    "$c" -c "import gi;gi.require_version('WebKit2','4.1');from gi.repository import WebKit2" >/dev/null 2>&1 \
      && { command -v "$c"; return 0; }
  done
  return 1
}
open_native() {
  local wp sp
  wp=$(window_py) || return 1
  sp=$(sys_py) || return 1
  echo "打开原生窗口 (GTK + WebKit2)…"
  if [ "${VE_SELFTEST:-}" = "1" ]; then VE_SELFTEST=1 "$sp" "$wp" "$URL"; return $?; fi
  "$sp" "$wp" "$URL"
  return $?
}
open_appwin() {
  local b prof
  prof="${XDG_DATA_HOME:-$HOME/.local/share}/vocal-editor/browser-profile"
  mkdir -p "$prof" 2>/dev/null
  for b in chromium chromium-browser google-chrome brave-browser microsoft-edge; do
    command -v "$b" >/dev/null 2>&1 || continue
    echo "打开应用窗口 ($b --app, 没有地址栏)…"
    setsid "$b" --app="$URL" --window-size=1500,950 --user-data-dir="$prof" \
      --no-first-run --no-default-browser-check >/dev/null 2>&1 &
    return 0
  done
  return 1
}
open_default() { echo "用默认浏览器打开 $URL"; xdg-open "$URL" >/dev/null 2>&1 || true; }

case "$MODE" in
  browser) open_default; echo "关掉这个终端 (Ctrl+C) 即退出。"; wait $SRV ;;
  chromium)
    if open_appwin; then echo "关掉这个终端 (Ctrl+C) 即退出。"; wait $SRV; else open_default; wait $SRV; fi ;;
  *)
    if open_native; then
      exit 0                       # 窗口关闭 → 退出, trap 收掉后端
    elif open_appwin; then
      echo "关掉这个终端 (Ctrl+C) 即退出。"; wait $SRV
    else
      open_default; echo "关掉这个终端 (Ctrl+C) 即退出。"; wait $SRV
    fi ;;
esac
