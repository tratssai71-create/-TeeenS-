#!/bin/bash
# Codexが操作する専用Chromeを開く。初回だけSTUDIOに手動ログインし、その後は開いたままにする
# 隠れた/最小化したウィンドウでも、描画や操作が止まらないようにするフラグ付き
URL="${STUDIO_URL:-https://app.studio.design/projects}"
open -na "Google Chrome" --args \
  --user-data-dir="$HOME/studio-chrome-profile" \
  --remote-debugging-port=9222 \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --disable-background-timer-throttling \
  --window-size=1440,900 \
  "$URL"
echo "専用Chromeを開きました。STUDIOにログインして、このChromeは開いたままにしてください(できれば画面の見える位置に)。"
