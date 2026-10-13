#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'HELP'
用法：bash scripts/build-macos.sh [native|arm64|x64|universal|all] [--app-only]

  native       当前 Mac 的芯片架构（默认）
  arm64        Apple Silicon / M 系列
  x64          Intel
  universal    一个应用同时支持 ARM 和 Intel
  all          分别打包 ARM 和 Intel 两个版本
  --app-only   只生成 .app；默认同时生成 .app 和 .dmg

产物目录：dist/release/<架构>/
需要 macOS、Node.js 22 或更新版本、npm；缺少项目依赖时自动运行 npm ci。
HELP
}

fail() { printf '%s\n' "$1" >&2; exit 1; }
trap 'printf "打包失败，请检查上方错误信息。\n" >&2' ERR

requested_arch=native
arch_selected=false
app_only=false
for argument in "$@"; do
  case "$argument" in
    -h|--help) usage; exit 0 ;;
    --app-only) app_only=true ;;
    native|arm64|x64|universal|all)
      if $arch_selected; then fail '一次只能指定一个架构选项；多个版本请使用 all。'; fi
      requested_arch="$argument"
      arch_selected=true
      ;;
    *) fail "不支持的选项：$argument（使用 --help 查看用法）" ;;
  esac
done

[[ "$(uname -s)" == Darwin ]] || fail '这个脚本需要在 macOS 上运行。'
command -v node >/dev/null || fail '请先安装 Node.js 22 或更新版本。'
command -v npm >/dev/null || fail '未找到 npm，请检查 Node.js 安装。'
[[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -ge 22 ]] || fail '需要 Node.js 22 或更新版本。'
command -v lipo >/dev/null || fail '未找到 lipo；请先运行 xcode-select --install 安装命令行工具。'

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"
if [[ ! -f node_modules/electron-builder/out/cli/cli.js || ! -f node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ]]; then
  printf '安装项目依赖…\n'
  npm ci
fi

if [[ "$requested_arch" == native ]]; then
  if [[ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" == 1 ]]; then requested_arch=arm64;
  else requested_arch=x64; fi
fi
architectures=("$requested_arch")
if [[ "$requested_arch" == all ]]; then architectures=(arm64 x64); fi

cached_dist="$project_dir/node_modules/electron/dist"
cached_arch="$(lipo -archs "$cached_dist/Electron.app/Contents/MacOS/Electron")"
for arch in "${architectures[@]}"; do
  output_dir="$project_dir/dist/release/$arch"
  build_args=(--mac "--$arch" --publish=never "--config.directories.output=$output_dir")
  if $app_only; then build_args+=(--dir); fi
  # Reuse only a runtime that exactly matches the target. Other architectures are downloaded by the builder.
  if [[ "$arch" == arm64 && "$cached_arch" == arm64 ]] || [[ "$arch" == x64 && "$cached_arch" == x86_64 ]]; then
    build_args+=("--config.electronDist=$cached_dist")
  fi

  printf '开始打包 %s…\n' "$arch"
  npm run build -- "${build_args[@]}"

  app_found=false
  for bundle in "$output_dir"/*.app "$output_dir"/*/*.app; do
    [[ -d "$bundle" ]] || continue
    executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$bundle/Contents/Info.plist")"
    binary_arch="$(lipo -archs "$bundle/Contents/MacOS/$executable")"
    case "$arch" in
      arm64) [[ "$binary_arch" == arm64 ]] || fail '生成的应用不是 ARM64 架构。' ;;
      x64) [[ "$binary_arch" == x86_64 ]] || fail '生成的应用不是 Intel 架构。' ;;
      universal) [[ " $binary_arch " == *' arm64 '* && " $binary_arch " == *' x86_64 '* ]] || fail '通用应用缺少 ARM 或 Intel 架构。' ;;
    esac
    app_found=true
    printf 'APP：%s\n' "$bundle"
  done
  $app_found || fail '未找到打包后的 .app。'
  if ! $app_only; then
    dmg_found=false
    for image in "$output_dir"/*.dmg; do
      [[ -f "$image" ]] || continue
      dmg_found=true
      printf 'DMG：%s\n' "$image"
    done
    $dmg_found || fail '未找到打包后的 .dmg。'
  fi
  printf '打包完成：%s\n' "$output_dir"
done
