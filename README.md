# 桌面小伙伴 · Mac 版

透明无边框的桌面宠物，约 205×285，浮在屏幕右下角。逻辑与 Windows 版一致：摸摸、喂食、睡觉、跳舞、打屁屁、拖动、右键菜单。用系统自带的 JavaScript for Automation 运行，不需要 Xcode。

适用 macOS 10.13 及以上，已在 macOS Sequoia 15（Intel 与 Apple 芯片）上跑过自动测试。

## 打开

1. 解压 `dist/桌面小伙伴-Mac.zip`，得到 `桌面小伙伴.app`。可以放进「应用程序」，放桌面也可以。
2. 第一次打开会被系统拦截（这个 App 没有苹果开发者签名）。

macOS 15 Sequoia：

1. 双击 `桌面小伙伴.app`，出现「无法打开 / 无法验证开发者」时点「完成」或「好」。
2. 打开「系统设置 → 隐私与安全性」，在「安全性」里找到「已阻止使用桌面小伙伴」，点「仍要打开」，输入开机密码。
3. 再双击一次，在弹窗里点「打开」。

也可以在终端执行（路径按实际位置改）：

```bash
xattr -dr com.apple.quarantine /Applications/桌面小伙伴.app
```

之后就能直接双击。旧系统上右键「打开」有时也能跳过拦截；macOS 15 起请用上面的「仍要打开」。

双击没有反应时，双击旁边的 `启动桌宠（备用）.command`。日志在 `~/Library/Logs/桌面小伙伴.log`。

互动说明见 [使用说明.txt](使用说明.txt)。Esc 只隐藏底部工具栏，不退出。退出用右键菜单「退出桌宠」，或点一下桌宠再按 ⌘Q。本 App 不需要辅助功能或屏幕录制权限。

## 仓库里有什么

- `桌面小伙伴.app`：bash 启动器 `Contents/MacOS/DesktopPet` 调用 `/usr/bin/osascript -l JavaScript`，界面在 `Contents/Resources/DesktopPet.js`。
- `scripts/ci_exercise.py`：在图形会话里启动 App、截图、并用 cliclick / JXA `CGEvent` 点击。
- `.github/workflows/macos-pet.yml`：在 `macos-15-intel`（Intel x86_64，Sequoia）和 `macos-15`（Apple 芯片，Sequoia）上跑上述测试，把截图和日志提交回 `test-results/<runner>/`。

GitHub 已在 2025-12-04 停用 `macos-13`。Intel 测试改用 `macos-15-intel`，对应 2019 款 MacBook Pro 在 Sequoia 15 上的环境。
