#!/bin/sh
# /opt/lab/llm-engine.sh — (re)create the LLM engine container from /etc/lab/engine.json (edit it in the panel: LLM tab).
exec python3 -I /opt/lab/panel/engine.py "${1:-apply}"
