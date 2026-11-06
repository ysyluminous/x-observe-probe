@echo off
chcp 65001 >nul
title xprobe log sink (127.0.0.1:8765)
echo 启动 X 观测探针日志接收端...
python -X utf8 "%~dp0log-sink.py"
echo.
echo sink 已退出。窗口可关闭。
pause
