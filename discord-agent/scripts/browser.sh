#!/bin/bash
# Codexが操作する専用Chromeを開く。初回だけSTUDIOに手動ログインし、その後は開いたままにする
URL="${STUDIO_URL:-https://app.studio.design/projects}"
open -na "Google Chrome" --args --user-data-dir="$HOME/studio-chrome-profile" --remote-debugging-port=9222 "$URL"
echo "専用Chromeを開きました。STUDIOにログインして、このChromeは開いたままにしてください。"
