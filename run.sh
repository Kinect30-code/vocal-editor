#!/usr/bin/env bash
# 源码方式启动 (开发用). 先体检依赖, 缺东西会直接说清楚缺什么。
cd "$(dirname "$0")" || exit 1
PY=.venv/bin/python
[ -x "$PY" ] || PY=$(command -v python3) || { echo "找不到 python3"; exit 1; }
"$PY" ve_env.py || echo "(上面有缺失项: 仍尝试启动, 但相关功能会不可用)"
export VE_OPEN=${VE_OPEN:-1}
exec "$PY" server.py
