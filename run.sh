#!/usr/bin/env bash
# 源码方式启动 (开发用): 起服务 + 开原生应用窗口, 关窗口即退出。
#   只看依赖:   ./launch.sh --check
#   只起服务:   ./launch.sh --no-window
#   用浏览器:   ./launch.sh --browser
cd "$(dirname "$0")" || exit 1
exec ./launch.sh "$@"
