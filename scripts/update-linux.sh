#!/usr/bin/env bash
# ============================================================================
# update-linux.sh — 一键把上游更新合进本地 Linux 定制版并重打 .deb
#
# 维护模型:
#   - 所有 Linux 定制改动(deb target / afterInstall / LLM base URL 可自定义)
#     都在 linux-build 分支上,以普通 commit 形式叠在上游之上。
#   - 上游(origin/main)发新版本 → 本脚本 fetch + rebase + 重编 deb。
#
# 用法:
#   bash scripts/update-linux.sh            # 拉上游 + rebase + 重打 deb
#   bash scripts/update-linux.sh --install  # 额外 dpkg 安装(需 sudo)
#   bash scripts/update-linux.sh --no-pull  # 跳过拉取,仅用当前代码重打 deb
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

BRANCH="linux-build"
DO_PULL=1
DO_INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --install) DO_INSTALL=1 ;;
    --no-pull) DO_PULL=0 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

echo "==> 当前分支: $(git branch --show-current)"
if [ "$(git branch --show-current)" != "$BRANCH" ]; then
  echo "切到 $BRANCH"; git checkout "$BRANCH"
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "✗ 工作区有未提交改动,先 commit 或 stash 再跑。" >&2
  git status -s >&2
  exit 1
fi

if [ "$DO_PULL" = 1 ]; then
  echo "==> 拉取上游 origin/main"
  git fetch origin
  echo "==> rebase 本地定制到上游之上"
  if ! git rebase origin/main; then
    echo "✗ rebase 冲突。手动解决后 git rebase --continue,再重跑本脚本 --no-pull。" >&2
    exit 1
  fi
  echo "==> 同步依赖(若上游改了 package.json)"
  npm install
fi

echo "==> 构建 Linux deb"
npm run dist:linux

DEB=$(ls -t dist_electron/*.deb 2>/dev/null | head -1)
if [ -z "$DEB" ]; then
  echo "✗ 没找到产物 .deb" >&2; exit 1
fi
echo "==> 产物: $DEB"

if [ "$DO_INSTALL" = 1 ]; then
  echo "==> 安装(sudo dpkg -i)"
  sudo dpkg -i "$DEB"
  echo "✓ 已安装。应用菜单搜 T8-PenguinCanvas 启动。"
else
  echo "如需安装: sudo dpkg -i \"$DEB\""
fi

# 更新成功后刷新异地备份(rebase 改写了历史,故 force-with-lease)。myfork 不存在则跳过。
if git remote get-url myfork >/dev/null 2>&1; then
  echo "==> 刷新备份 myfork/$BRANCH"
  git push --force-with-lease myfork "$BRANCH" || echo "  (备份推送失败,可稍后手动 git push --force-with-lease myfork $BRANCH)"
fi
