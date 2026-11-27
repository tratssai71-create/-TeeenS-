#!/bin/bash
# Codexにブラウザ操作(Playwright)を登録する。1回だけ実行すればよい
codex mcp remove playwright >/dev/null 2>&1 || true
codex mcp add playwright -- npx @playwright/mcp@latest --cdp-endpoint http://localhost:9222
echo "登録しました。次は: npm run browser"
