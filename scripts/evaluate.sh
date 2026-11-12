#!/usr/bin/env bash
# 调用 AgenticDataBench 官方 Evaluator，评测 runs/<experiment_id>/output-da-agent。
#
# 用法:
#   scripts/evaluate.sh <experiment_id>
#   npm run evaluate -- <experiment_id>
#
# 路径约定:
#   - testbed 目录从环境变量 AGENTIC_DATA_BENCH_DATA_DIR 读取；未设置时依次尝试
#     项目根目录 .env 中同名键、内置默认路径。
#   - 官方评测 Python（venv，已装官方 requirements）默认用
#     AGENTIC_DATA_BENCH_PYTHON 覆盖，否则用内置默认路径。
set -euo pipefail

EXPERIMENT_ID="${1:-}"
if [[ -z "$EXPERIMENT_ID" ]]; then
  echo "用法: scripts/evaluate.sh <experiment_id>" >&2
  exit 1
fi
if [[ ! "$EXPERIMENT_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "experiment_id 只能包含字母、数字、.、_、-（且以字母或数字开头）: $EXPERIMENT_ID" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 1. testbed 路径：环境变量 > 项目 .env > 默认值
DEFAULT_DATA_DIR="/Users/mac/Documents/学习/找工作/agenticdatabench/testbed"
DATA_DIR="${AGENTIC_DATA_BENCH_DATA_DIR:-}"
if [[ -z "$DATA_DIR" && -f "$PROJECT_ROOT/.env" ]]; then
  DATA_DIR="$(sed -n 's/^[[:space:]]*AGENTIC_DATA_BENCH_DATA_DIR=//p' "$PROJECT_ROOT/.env" | tail -1 | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
fi
DATA_DIR="${DATA_DIR:-$DEFAULT_DATA_DIR}"

# 2. 官方评测 Python：环境变量 > 默认值
DEFAULT_PYTHON="/Users/mac/Documents/学习/找工作/agenticdatabench-venv/bin/python"
PYTHON_BIN="${AGENTIC_DATA_BENCH_PYTHON:-$DEFAULT_PYTHON}"

OUTPUT_DIR="$PROJECT_ROOT/runs/$EXPERIMENT_ID/output-da-agent"
RESULT_DIR="$PROJECT_ROOT/runs/$EXPERIMENT_ID/evaluation"

if [[ ! -d "$OUTPUT_DIR" ]]; then
  echo "输出目录不存在: $OUTPUT_DIR" >&2
  echo "请先运行实验入口，例如: npm run run:baseline -- --experiment-id $EXPERIMENT_ID --all" >&2
  exit 1
fi
if [[ ! -f "$DATA_DIR/evaluate.py" ]]; then
  echo "testbed 目录无效（缺少 evaluate.py）: $DATA_DIR" >&2
  echo "可用环境变量 AGENTIC_DATA_BENCH_DATA_DIR 指向 AgenticDataBench testbed 目录" >&2
  exit 1
fi
if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "未找到官方评测 Python: $PYTHON_BIN" >&2
  echo "可用环境变量 AGENTIC_DATA_BENCH_PYTHON 指向装有官方 requirements 的 venv python" >&2
  exit 1
fi

mkdir -p "$RESULT_DIR"
cd "$DATA_DIR"

# 官方调用形态: python -I evaluate.py --output_dir ... --gold_dir gold --eval_json tasks/dev.jsonl --result_dir ...
# 注意: -I（isolated mode）不会把脚本目录加入 sys.path，evaluate.py 顶部的
# `from da_agent.evaluators.evaluation import Evaluator`（testbed 本地包）会报
# ModuleNotFoundError，因此这里用 -c 包装：保持 -I 隔离（-E/-s），仅显式允许
# 当前目录（即 testbed，我们已 cd 进入）作为模块搜索路径。
exec "$PYTHON_BIN" -I -c '
import os
import runpy
import sys

sys.path.insert(0, os.getcwd())  # testbed 本地包 da_agent（-I 不自动加入脚本目录）
sys.argv = [
    "evaluate.py",
    "--output_dir", sys.argv[1],
    "--gold_dir", "gold",
    "--eval_json", "tasks/dev.jsonl",
    "--result_dir", sys.argv[2],
]
runpy.run_path("evaluate.py", run_name="__main__")
' "$OUTPUT_DIR" "$RESULT_DIR"
