#!/usr/bin/env python3
"""为 Cursor CLI 的 ACP 模式开启 enableAgentRetries。

背景：交互式 CLI 会对瞬时网络错误自动重试，但 ACP 路径未传入
enableAgentRetries。本脚本在确认结构匹配后，向 ACP 的 run options
插入该开关；结构变化或不适用时拒绝机械替换并给出明确原因。

用法：
  ./scripts/patch-cursor-cli-acp-retry.py           # 补丁当前激活版本
  ./scripts/patch-cursor-cli-acp-retry.py --status  # 仅检查
  ./scripts/patch-cursor-cli-acp-retry.py --dry-run
  ./scripts/patch-cursor-cli-acp-retry.py --all
  ./scripts/patch-cursor-cli-acp-retry.py --version 2026.07.23-e383d2b
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

DEFAULT_VERSIONS_ROOT = Path.home() / ".local/share/cursor-agent/versions"
DEFAULT_BIN = Path.home() / ".local/bin/cursor-agent"

# ACP 独有：仅写 debug 日志的重连文案（交互式 CLI 用 "Connection lost"）
ACP_RECONNECT_LOG = "Connection state: reconnecting"
ACP_CONNECTED_LOG = "Connection state: connected"
FLAG_NAME = "enableAgentRetries"
FLAG_TRUE = "enableAgentRetries:!0"

# 运行时仍支持该开关的证据（在任意 chunk 中出现即可）
RUNTIME_FLAG_HINT = "enableAgentRetries"


@dataclass
class PatchSite:
    file: Path
    object_start: int
    object_end: int  # exclusive, index of closing '}'
    object_text: str
    already_patched: bool


@dataclass
class VersionResult:
    version_dir: Path
    status: str  # patched | already | skip | error
    message: str
    site: PatchSite | None = None


def eprint(*args: object) -> None:
    print(*args, file=sys.stderr, flush=True)


def resolve_active_version_dir(versions_root: Path, bin_path: Path) -> Path | None:
    """通过 cursor-agent 启动脚本解析当前激活的 versions/<id> 目录。"""
    if not bin_path.exists():
        return None
    target = bin_path
    for _ in range(5):
        if target.is_symlink():
            target = Path(os.path.realpath(target))
        else:
            break
    # .../versions/<id>/cursor-agent
    if target.parent.parent == versions_root or target.parent.parent.resolve() == versions_root.resolve():
        return target.parent
    # 容错：从真实路径向上找 versions 下的子目录
    for parent in target.parents:
        if parent.parent.resolve() == versions_root.resolve():
            return parent
    return None


def list_version_dirs(versions_root: Path) -> list[Path]:
    if not versions_root.is_dir():
        return []
    return sorted(
        (p for p in versions_root.iterdir() if p.is_dir()),
        key=lambda p: p.name,
    )


def iter_js_chunks(version_dir: Path) -> Iterable[Path]:
    for path in sorted(version_dir.glob("*.js")):
        if path.name.endswith(".LICENSE.txt") or "LICENSE" in path.name:
            continue
        if path.name == "node":
            continue
        yield path


def runtime_supports_flag(version_dir: Path) -> bool:
    for path in iter_js_chunks(version_dir):
        # index 与大型 chunk 优先；不必读全库
        if path.name not in {"index.js"} and not path.name.endswith(".index.js"):
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        if RUNTIME_FLAG_HINT in text:
            return True
    return False


def find_matching_brace(text: str, open_index: int) -> int | None:
    """从 open_index 的 '{' 起做括号匹配，忽略字符串内的花括号。"""
    if open_index < 0 or open_index >= len(text) or text[open_index] != "{":
        return None
    depth = 0
    i = open_index
    n = len(text)
    in_str: str | None = None
    escape = False
    while i < n:
        ch = text[i]
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == in_str:
                in_str = None
            i += 1
            continue
        if ch in ('"', "'", "`"):
            in_str = ch
            i += 1
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return None


def locate_options_around_reconnect(text: str, reconnect_idx: int) -> tuple[int, int, str] | None:
    """从 ACP reconnect 日志锚点定位外层 run options 对象。

    不逆向解析字符串（易误判），而是：
    1. 向前找到 onConnectionStateChange
    2. 在其左侧短窗口内枚举 '{' 候选
    3. 正向括号匹配，取同时覆盖 reconnect 日志与 onErrorNotRetried 的对象
    """
    ocs = text.rfind("onConnectionStateChange:", 0, reconnect_idx)
    if ocs < 0:
        return None
    if reconnect_idx - ocs > 800:
        return None

    # 已补丁时 flag 在 onConnectionStateChange 之前，窗口需覆盖 enableAgentRetries:!0,
    region_start = max(0, ocs - 160)
    candidates = [
        region_start + m.start() for m in re.finditer(r"\{", text[region_start:ocs])
    ]
    for start in reversed(candidates):
        end = find_matching_brace(text, start)
        if end is None or end < reconnect_idx:
            continue
        obj = text[start : end + 1]
        if ACP_RECONNECT_LOG not in obj or "onErrorNotRetried" not in obj:
            continue
        return start, end + 1, obj
    return None


def is_acp_options_object(obj: str) -> bool:
    """确认对象是 ACP run options，而非交互式 CLI 的重连 UI 路径。"""
    if "onConnectionStateChange" not in obj:
        return False
    if "onErrorNotRetried" not in obj:
        return False
    if ACP_RECONNECT_LOG not in obj:
        return False
    # 交互式路径特征：面向用户的 Connection lost 文案
    if "Connection lost" in obj:
        return False
    # ACP 路径应同时有 connected 的 debug 文案（结构指纹）
    if ACP_CONNECTED_LOG not in obj:
        return False
    # ACP 错误回调通常挂在 sharedServices.configProvider
    if "sharedServices.configProvider" not in obj and "configProvider:this.sharedServices" not in obj:
        # 允许轻微改写，但至少要有 configProvider
        if "configProvider" not in obj:
            return False
    return True


def already_has_flag(obj: str) -> bool:
    return bool(re.search(r"\benableAgentRetries\s*:", obj))


def discover_patch_sites(version_dir: Path) -> tuple[list[PatchSite], list[str]]:
    """在版本目录中定位可补丁位点；返回 (sites, diagnostics)。"""
    sites: list[PatchSite] = []
    diagnostics: list[str] = []

    candidate_files: list[Path] = []
    for path in iter_js_chunks(version_dir):
        try:
            # 先用小探针：只读前若文件很大也无所谓，ACP chunk 通常整文件扫
            sample = path.read_text(encoding="utf-8", errors="ignore")
        except OSError as exc:
            diagnostics.append(f"无法读取 {path.name}: {exc}")
            continue
        if ACP_RECONNECT_LOG not in sample:
            continue
        if "onErrorNotRetried" not in sample:
            diagnostics.append(
                f"{path.name}: 含「{ACP_RECONNECT_LOG}」但无 onErrorNotRetried，跳过"
            )
            continue
        candidate_files.append(path)

        # 每个 reconnect 日志锚点尝试解析外层 options 对象
        start = 0
        while True:
            idx = sample.find(ACP_RECONNECT_LOG, start)
            if idx < 0:
                break
            start = idx + len(ACP_RECONNECT_LOG)

            located = locate_options_around_reconnect(sample, idx)
            if located is None:
                diagnostics.append(
                    f"{path.name}@{idx}: 无法从 onConnectionStateChange 定位完整 options 对象"
                )
                continue

            obj_start, obj_end, obj_text = located
            if not is_acp_options_object(obj_text):
                diagnostics.append(
                    f"{path.name}@{obj_start}: 解析到的对象不符合 ACP options 指纹，已忽略"
                )
                continue

            sites.append(
                PatchSite(
                    file=path,
                    object_start=obj_start,
                    object_end=obj_end,
                    object_text=obj_text,
                    already_patched=already_has_flag(obj_text),
                )
            )

    # 去重（同一对象可能被重复锚到）
    unique: dict[tuple[str, int, int], PatchSite] = {}
    for site in sites:
        key = (str(site.file), site.object_start, site.object_end)
        unique[key] = site
    return list(unique.values()), diagnostics


def build_patched_object(obj_text: str) -> str | None:
    """在 options 对象开头插入 enableAgentRetries:!0。"""
    if not obj_text.startswith("{") or not obj_text.endswith("}"):
        return None
    if already_has_flag(obj_text):
        return obj_text
    inner = obj_text[1:-1]
    # 保持 minify 风格：无空格
    if not inner:
        return "{" + FLAG_TRUE + "}"
    if inner.startswith(","):
        return None
    return "{" + FLAG_TRUE + "," + inner + "}"


def apply_patch(site: PatchSite, *, dry_run: bool, backup: bool) -> None:
    text = site.file.read_text(encoding="utf-8", errors="strict")
    original = text[site.object_start : site.object_end]
    if original != site.object_text:
        raise RuntimeError(
            f"{site.file.name}: 文件内容在定位后发生变化，拒绝写入（期望位点已漂移）"
        )
    patched_obj = build_patched_object(site.object_text)
    if patched_obj is None:
        raise RuntimeError(f"{site.file.name}: 无法构造补丁后的 options 对象")
    if patched_obj == site.object_text:
        return

    new_text = text[: site.object_start] + patched_obj + text[site.object_end :]
    # 写后自检：仍应只有一个 ACP 位点且含 flag
    if dry_run:
        return

    if backup:
        bak = site.file.with_suffix(site.file.suffix + ".acp-retry.bak")
        if not bak.exists():
            shutil.copy2(site.file, bak)

    site.file.write_text(new_text, encoding="utf-8")


def analyze_version(version_dir: Path) -> VersionResult:
    if not version_dir.is_dir():
        return VersionResult(version_dir, "error", f"版本目录不存在: {version_dir}")

    if not runtime_supports_flag(version_dir):
        return VersionResult(
            version_dir,
            "skip",
            "运行时未发现 enableAgentRetries 符号：上游可能已改名或移除该开关，"
            "拒绝盲目插入，以免生成无效字段。",
        )

    sites, diagnostics = discover_patch_sites(version_dir)

    if not sites:
        detail = "；".join(diagnostics[:5]) if diagnostics else "无额外诊断"
        return VersionResult(
            version_dir,
            "skip",
            "未找到可识别的 ACP run options（需同时具备 "
            f"onConnectionStateChange + 「{ACP_RECONNECT_LOG}」+ onErrorNotRetried）。"
            f" 可能官方已内置重试或打包结构已变。诊断: {detail}",
        )

    if len(sites) > 1:
        locs = ", ".join(f"{s.file.name}:{s.object_start}" for s in sites)
        return VersionResult(
            version_dir,
            "skip",
            f"匹配到 {len(sites)} 处 ACP options（{locs}），存在歧义，"
            "拒绝机械替换。请人工确认后升级脚本指纹。",
        )

    site = sites[0]
    if site.already_patched:
        return VersionResult(
            version_dir,
            "already",
            f"已补丁: {site.file.name} 的 ACP options 已包含 {FLAG_NAME}",
            site,
        )

    preview = site.object_text
    if len(preview) > 180:
        preview = preview[:180] + "…"
    return VersionResult(
        version_dir,
        "patched",  # 意图：可补丁（真正写入由调用方决定）
        f"可补丁位点: {site.file.name} @ {site.object_start}；将插入 {FLAG_TRUE}。"
        f" 对象预览: {preview}",
        site,
    )


def clear_compile_cache_hint() -> str:
    if sys.platform == "darwin":
        cache = Path.home() / "Library/Caches/cursor-compile-cache"
    else:
        xdg = os.environ.get("XDG_CACHE_HOME", str(Path.home() / ".cache"))
        cache = Path(xdg) / "cursor-compile-cache"
    return str(cache)


def process_versions(
    version_dirs: list[Path],
    *,
    dry_run: bool,
    status_only: bool,
    backup: bool,
    clear_cache: bool,
) -> int:
    exit_code = 0
    wrote_any = False

    for version_dir in version_dirs:
        result = analyze_version(version_dir)
        label = version_dir.name
        print(f"\n== {label} ==", flush=True)

        if result.status == "error":
            eprint(f"错误: {result.message}")
            exit_code = max(exit_code, 2)
            continue

        if result.status == "skip":
            eprint(f"不适用: {result.message}")
            exit_code = max(exit_code, 1)
            continue

        if result.status == "already":
            print(f"OK: {result.message}")
            continue

        # status == patched（可写入）
        print(result.message)
        if status_only:
            print("状态: 需要补丁（未修改文件，使用不加 --status 以写入）")
            exit_code = max(exit_code, 1)
            continue

        assert result.site is not None
        if dry_run:
            patched_preview = build_patched_object(result.site.object_text)
            print(f"dry-run: 将写入 {result.site.file}")
            if patched_preview:
                shown = patched_preview if len(patched_preview) <= 200 else patched_preview[:200] + "…"
                print(f"dry-run 预览: {shown}")
            continue

        try:
            apply_patch(result.site, dry_run=False, backup=backup)
        except Exception as exc:  # noqa: BLE001 — 对用户给出明确失败原因
            eprint(f"写入失败: {exc}")
            exit_code = max(exit_code, 2)
            continue

        # 写后复核
        verify = analyze_version(version_dir)
        if verify.status != "already":
            eprint(f"写入后复核未通过: {verify.message}")
            exit_code = max(exit_code, 2)
            continue

        print(f"已写入: {result.site.file}")
        if backup:
            bak = result.site.file.with_suffix(result.site.file.suffix + ".acp-retry.bak")
            print(f"备份: {bak}")
        wrote_any = True

    if wrote_any and clear_cache:
        cache = Path(clear_compile_cache_hint())
        if cache.is_dir():
            shutil.rmtree(cache)
            print(f"\n已清理 Node compile cache: {cache}")
        else:
            print(f"\ncompile cache 不存在，无需清理: {cache}")
    elif wrote_any:
        print(
            "\n提示: 若 ACP 行为未变化，可清理 compile cache 后重试:\n"
            f"  rm -rf {clear_compile_cache_hint()}"
        )

    return exit_code


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="为 Cursor CLI ACP 模式结构化打上 enableAgentRetries 补丁",
    )
    p.add_argument(
        "--versions-root",
        type=Path,
        default=Path(os.environ.get("CURSOR_AGENT_VERSIONS", DEFAULT_VERSIONS_ROOT)),
        help="cursor-agent versions 根目录",
    )
    p.add_argument(
        "--bin",
        type=Path,
        default=Path(os.environ.get("CURSOR_AGENT_BIN", DEFAULT_BIN)),
        help="cursor-agent 可执行文件路径（用于解析当前激活版本）",
    )
    p.add_argument(
        "--version",
        action="append",
        default=[],
        help="指定版本目录名（可重复）；默认仅当前激活版本",
    )
    p.add_argument("--all", action="store_true", help="处理 versions 下全部已安装版本")
    p.add_argument("--status", action="store_true", help="只检查，不写入")
    p.add_argument("--dry-run", action="store_true", help="显示将做的修改，不写入")
    p.add_argument("--no-backup", action="store_true", help="写入时不创建 .acp-retry.bak")
    p.add_argument(
        "--clear-cache",
        action="store_true",
        help="写入成功后删除 Node compile cache",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    versions_root: Path = args.versions_root.expanduser()

    if not versions_root.is_dir():
        eprint(f"找不到 versions 目录: {versions_root}")
        eprint("请确认已安装 Cursor CLI，或用 --versions-root 指定路径。")
        return 2

    selected: list[Path] = []
    if args.all:
        selected = list_version_dirs(versions_root)
        if not selected:
            eprint(f"versions 目录为空: {versions_root}")
            return 2
    elif args.version:
        for name in args.version:
            path = Path(name).expanduser()
            if not path.is_absolute():
                path = versions_root / name
            selected.append(path)
    else:
        active = resolve_active_version_dir(versions_root, args.bin.expanduser())
        if active is None:
            eprint(
                f"无法从 {args.bin} 解析当前激活版本。"
                "请使用 --version <id> 或 --all。"
            )
            return 2
        selected = [active]
        print(f"当前激活版本: {active.name}")

    return process_versions(
        selected,
        dry_run=args.dry_run,
        status_only=args.status,
        backup=not args.no_backup,
        clear_cache=args.clear_cache,
    )


if __name__ == "__main__":
    sys.exit(main())
