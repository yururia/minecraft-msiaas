import { invoke } from "@tauri-apps/api/tauri";

const statusEl = document.getElementById("status");
const btnSync = document.getElementById("btn-sync");
const btnTunnel = document.getElementById("btn-tunnel");

if (btnSync && statusEl) {
  btnSync.addEventListener("click", async () => {
    statusEl.textContent = "同期中...";
    try {
      const result = await invoke("sync_mods", { presetId: "preset-123" });
      statusEl.textContent = result as string;
    } catch (error) {
      statusEl.textContent = "エラーが発生しました";
      console.error(error);
    }
  });
}

if (btnTunnel && statusEl) {
  btnTunnel.addEventListener("click", async () => {
    statusEl.textContent = "Tunnel接続中...";
    try {
      const result = await invoke("start_tunnel", { serverIp: "mc.example.com" });
      statusEl.textContent = result as string;
    } catch (error) {
      statusEl.textContent = "エラーが発生しました";
      console.error(error);
    }
  });
}
