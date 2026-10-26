#!/usr/bin/env bash
# 启动 TMTN 网关（已在运行就跳过）。日志：/tmp/tmtn-gateway.log
cd "$(dirname "$0")/.."
# 自动拉取最新代码（失败不影响启动）
git pull --ff-only -q 2>/dev/null || true
[ -d node_modules ] || npm ci --omit=dev --no-audit --no-fund
if curl -fsS "http://127.0.0.1:${PORT:-3000}/healthz" >/dev/null 2>&1; then
  echo "TMTN 网关已在运行：端口 ${PORT:-3000}"
  exit 0
fi
mkdir -p "${DATA_DIR:-data}"
setsid nohup node gateway.js >> /tmp/tmtn-gateway.log 2>&1 < /dev/null &
for i in $(seq 1 30); do
  sleep 1
  if curl -fsS "http://127.0.0.1:${PORT:-3000}/healthz" >/dev/null 2>&1; then
    echo "TMTN 网关已启动：打开「端口」面板里的 ${PORT:-3000} 端口即可使用"
    exit 0
  fi
done
echo "启动失败，最后几行日志："; tail -n 30 /tmp/tmtn-gateway.log; exit 1
