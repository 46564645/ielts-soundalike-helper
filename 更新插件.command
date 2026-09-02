#!/bin/zsh

set -u

PLUGIN_DIR="${0:A:h}"
cd -- "$PLUGIN_DIR" || exit 1

echo "正在检查听写辨音助手更新……"
echo

if ! command -v git >/dev/null 2>&1; then
  echo "未找到 Git，暂时无法更新。"
  echo "按任意键关闭窗口。"
  read -k 1
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "当前文件夹还没有连接 GitHub 仓库。"
  echo "按任意键关闭窗口。"
  read -k 1
  exit 1
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "当前文件夹还没有连接 GitHub 远程仓库。"
  echo "按任意键关闭窗口。"
  read -k 1
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "检测到尚未保存到 Git 的本地修改。为避免覆盖，本次没有更新。"
  echo "请先提交或备份修改，然后重新运行。"
  echo "按任意键关闭窗口。"
  read -k 1
  exit 1
fi

if git pull --ff-only; then
  echo
  echo "代码已经更新完成。"
  echo "接下来打开 chrome://extensions，找到“听写辨音助手”，点击“重新加载”。"
  open -a "Google Chrome" "chrome://extensions" >/dev/null 2>&1 || true
else
  echo
  echo "更新没有完成，请检查网络或 GitHub 登录状态。"
fi

echo
echo "按任意键关闭窗口。"
read -k 1

