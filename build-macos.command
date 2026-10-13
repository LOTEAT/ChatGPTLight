#!/bin/bash
set -uo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
build_script="$project_dir/scripts/build-macos.sh"

# Keep command-line arguments available for automation; double-clicking uses the menu.
if [[ $# -gt 0 ]]; then exec /bin/bash "$build_script" "$@"; fi

# Finder launches may not include Homebrew or the Node installer in PATH.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if [[ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" == 1 ]]; then default_choice=1;
else default_choice=2; fi

printf 'ChatGPT Light · 打包 Mac 应用\n\n'
printf '1. M 系列芯片版（ARM）\n'
printf '2. Intel 芯片版\n'
printf '3. 通用版（同时支持 M 系列和 Intel）\n'
printf '0. 退出\n\n'
printf '直接按回车，会打包适合你这台 Mac 的版本。\n'
while true; do
  IFS= read -r -p "选择版本 [$default_choice]：" choice || exit 0
  choice="${choice:-$default_choice}"
  case "$choice" in
    1) target_arch=arm64; break ;;
    2) target_arch=x64; break ;;
    3) target_arch=universal; break ;;
    0) exit 0 ;;
    *) printf '请输入 1、2、3 或 0。\n' ;;
  esac
done

printf '\n正在打包，请等到显示“打包完成”…\n\n'
if /bin/bash "$build_script" "$target_arch"; then
  build_status=0
  output_dir="$project_dir/dist/release/$target_arch"
  open "$output_dir"
  printf '\n已打开结果文件夹，里面的 .dmg 可以用于安装和分享。\n'
else
  build_status=$?
  printf '\n打包未完成，请查看上面的错误信息。\n'
fi
IFS= read -r -p '按回车结束…' ignored || true
exit "$build_status"
