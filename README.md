# 手機車牌辨識網頁

這個資料夾可作為 GitHub Pages 的發布來源。

手機網頁會：

- 開啟手機後鏡頭。
- 擷取手機畫面成 JPEG。
- 傳到電腦主機後端 `/api/mobile-recognize`。
- 在手機網頁上畫紅框/綠框並顯示中文辨識結果。

不同網路時，請在電腦主機執行：

```powershell
scripts\start-mobile-tunnel.ps1 -Provider cloudflared
```

或：

```powershell
scripts\start-mobile-tunnel.ps1 -Provider ngrok
```

腳本會把 tunnel 產生的 HTTPS 後端網址寫入 `backend-config.json`。如果這個資料夾已經發布到 GitHub Pages，請把更新後的 `backend-config.json` 推送到 GitHub，手機頁就會讀到最新網址。
