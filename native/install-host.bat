@echo off
chcp 65001 >nul
setlocal
echo ============================================
echo  X 观测探针 / 注册本机宿主（Native Messaging）
echo ============================================
echo 1) 打开 chrome://extensions （右上角开「开发者模式」）
echo 2) 找到本扩展，复制那一行的 32 位 ID
echo.
set /p EXTID=粘贴扩展 ID 后回车: 
if "%EXTID%"=="" goto :nodup
py -3 "%~dp0install-host.py" --ext-id "%EXTID%"
if errorlevel 1 goto :failed
echo.
echo 注册完成。回 chrome://extensions 点「重新加载」，再刷新 x.com。
goto :done

:nodup
echo 没有输入扩展 ID，已取消。
goto :done

:failed
echo.
echo 注册失败：看上面的报错。最常见是 PyInstaller 不在 PATH（py -3 -m pip install pyinstaller）。

:done
pause
endlocal
