#!/usr/bin/env bash
# 在 VPS 上首次安装。假设已经有 Node 22+ 和 git。
# 用法：sudo bash deploy/install.sh
set -euo pipefail

APP_DIR=/opt/zjh
DATA_DIR=/var/lib/zjh

id -u zjh >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin zjh
install -d -o zjh -g zjh "$APP_DIR" "$DATA_DIR"

# 从当前目录部署构建产物；构建请在有 devDependencies 的机器上先跑 npm run build
rsync -a --delete dist/ "$APP_DIR/dist/"
install -o zjh -g zjh package.json "$APP_DIR/package.json"
chown -R zjh:zjh "$APP_DIR"

install -m 644 deploy/zjh.service /etc/systemd/system/zjh.service
systemctl daemon-reload
systemctl enable --now zjh
systemctl --no-pager status zjh | head -20

echo
echo "服务已在 127.0.0.1:8787 启动。接下来配置反向代理："
echo "  Caddy: sudo cp deploy/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy"
echo "  nginx: 参考 deploy/nginx.conf"
