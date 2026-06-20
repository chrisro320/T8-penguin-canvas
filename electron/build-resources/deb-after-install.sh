#!/bin/bash
# Electron 的 chrome-sandbox 需要 SUID(root, mode 4755) 才能在不加 --no-sandbox 时启动。
# electron-builder 25 的 deb 默认 postinst 不设置,故在此补上,使安装/重装后双击即可运行。
set -e
SANDBOX='/opt/T8-PenguinCanvas/chrome-sandbox'
if [ -f "$SANDBOX" ]; then
  chown root:root "$SANDBOX" || true
  chmod 4755 "$SANDBOX" || true
fi

# 某些桌面会话(如本机 plasmashell)的进程环境里残留 ELECTRON_RUN_AS_NODE=1,
# 会让从桌面启动的 electron 当成纯 node 跑、不开窗口(双击打不开)。
# 在 .desktop 的 Exec 前加 env -u 剥掉该变量,使启动免疫于被污染的父进程环境。
DESKTOP='/usr/share/applications/t8-penguin-canvas.desktop'
if [ -f "$DESKTOP" ] && ! grep -q 'env -u ELECTRON_RUN_AS_NODE' "$DESKTOP"; then
  sed -i 's#^Exec=/opt/T8-PenguinCanvas/t8-penguin-canvas#Exec=env -u ELECTRON_RUN_AS_NODE /opt/T8-PenguinCanvas/t8-penguin-canvas#' "$DESKTOP" || true
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database /usr/share/applications || true
fi
