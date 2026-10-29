#!/bin/bash
# 备用启动方式：如果双击「桌面小伙伴.app」没有反应，双击本文件，终端窗口里会显示错误信息。
cd "$(dirname "$0")"
RES="$(pwd)/桌面小伙伴.app/Contents/Resources"
/usr/bin/osascript -l JavaScript "$RES/DesktopPet.js" "$RES"
