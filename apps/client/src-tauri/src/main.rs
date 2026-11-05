#![cfg_attr(
  all(not(debug_assertions), target_os = "windows"),
  windows_subsystem = "windows"
)]

use tauri::command;
use tauri::Manager;

fn log_to_ui(app_handle: &tauri::AppHandle, message: &str) {
    println!("{}", message);
    let _ = app_handle.emit_all("server-log", message.to_string());
}

fn emit_progress(app_handle: &tauri::AppHandle, progress: u32) {
    let _ = app_handle.emit_all("server-launch-progress", progress);
}

fn analyze_minecraft_crash_logs(logs: &[String], exit_code: i32) -> String {
    let mut details = Vec::new();
    let mut java_version_error = false;
    let mut client_side_error = false;
    let mut fabric_errors = Vec::new();
    let mut forge_errors = Vec::new();

    for line in logs {
        // Java version mismatch
        if line.contains("UnsupportedClassVersionError") || 
           line.contains("has been compiled by a more recent version of the Java Runtime") {
            java_version_error = true;
        }

        // Client-only class reference (loaded on server)
        if line.contains("invalid dist DEDICATED_SERVER") ||
           line.contains("com/mojang/blaze3d") ||
           (line.contains("NoClassDefFoundError") && (line.contains("net/minecraft/client/") || line.contains("net/minecraft/class_310"))) ||
           (line.contains("ClassNotFoundException") && (line.contains("net.minecraft.client.Minecraft") || line.contains("net.minecraft.client.gui"))) {
            client_side_error = true;
        }

        // Fabric/Quilt details
        if line.contains("ModResolutionException") || 
           line.contains("requires version") || 
           line.contains("which is missing") || 
           line.contains("is incompatible with") {
            fabric_errors.push(line.trim().to_string());
        }

        // Forge details
        if line.contains("Missing or unsupported mandatory dependencies") ||
           line.contains("ModResolutionException") ||
           (line.contains("requires") && line.contains("version") && (line.contains("missing") || line.contains("is not present"))) {
            forge_errors.push(line.trim().to_string());
        }
    }

    if java_version_error {
        details.push("【原因】Javaのバージョン不適合です。".to_string());
        details.push("JavaのバージョンがMODまたはサーバーJARの要件を満たしていません。より新しいバージョンのJava（例: Java 17 または 21）をインストールして実行してください。".to_string());
    } else if client_side_error {
        details.push("【原因】クライアント専用MODの混入が検出されました。".to_string());
        details.push("サーバー側でロードできないクライアント専用クラス（Minecraftの描画やUI系）を読み込もうとしてクラッシュしました。".to_string());
        details.push("ミニマップ、軽量化MOD（OptiFineやSodiumなど）、UI調整系MODなどのクライアント専用MODがサーバーの mods/ フォルダに含まれていないか確認し、除外してください。".to_string());
    } else if !fabric_errors.is_empty() {
        details.push("【原因】Fabric/Quilt MODの依存関係エラーを検出しました。".to_string());
        details.push("不足している前提MODを追加するか、バージョンを一致させてください：".to_string());
        for err in fabric_errors.iter().take(5) {
            details.push(format!(" - {}", err));
        }
    } else if !forge_errors.is_empty() {
        details.push("【原因】Forge/NeoForge MODの依存関係エラーを検出しました。".to_string());
        details.push("必要な依存MODが不足しているか、バージョンが適合していません：".to_string());
        for err in forge_errors.iter().take(5) {
            details.push(format!(" - {}", err));
        }
    } else {
        // Fallback checks for other common crash logs
        let mut generic_error_lines = Vec::new();
        for line in logs.iter().rev() {
            if line.contains("Exception") || line.contains("Error") || line.contains("FATAL") || line.contains("CRITICAL") {
                generic_error_lines.push(line.trim().to_string());
                if generic_error_lines.len() >= 3 {
                    break;
                }
            }
        }
        
        details.push(format!("【原因】サーバープロセスが異常終了しました（終了コード: {}）。", exit_code));
        if !generic_error_lines.is_empty() {
            details.push("ログから検出された直近のエラー情報：".to_string());
            for err in generic_error_lines.iter().rev() {
                details.push(format!(" - {}", err));
            }
        }
    }

    details.join("\n")
}
use std::collections::HashMap;
use std::sync::Mutex;
use once_cell::sync::Lazy;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::{SystemTime, Duration};
use std::path::{Path, PathBuf};
use std::fs::{self, File};
use std::io::{Read, Write, BufReader, BufRead};
use serde::{Serialize, Deserialize};
use zip::write::FileOptions;
use std::thread;
use sysinfo::{System, SystemExt};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// -----------------------------------------------------------------------------
// Global state and Types
// -----------------------------------------------------------------------------

struct ServerProcess {
    java_child: Child,
    java_stdin: ChildStdin,
    tunnel_child: Option<Child>,
    started_at: SystemTime,
}

// Map from session_id to active processes
static ACTIVE_SERVERS: Lazy<Mutex<HashMap<String, ServerProcess>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

// Set of session_ids that have been requested to stop
static STOPPED_SESSIONS: Lazy<Mutex<std::collections::HashSet<String>>> =
    Lazy::new(|| Mutex::new(std::collections::HashSet::new()));

// Child process for the local API server (wrangler dev on port 8787) launched automatically by the .exe
static API_SERVER_CHILD: Lazy<Mutex<Option<Child>>> =
    Lazy::new(|| Mutex::new(None));

#[derive(Serialize)]
struct ServerStartResult {
    session_id: String,
    tunnel_address: String,
    pid: u32,
    zip_path: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
struct MinecraftProperties {
    pvp: bool,
    difficulty: String,
    gamemode: String,
    #[serde(rename = "maxPlayers")]
    max_players: u32,
    #[serde(rename = "allowFlight")]
    allow_flight: bool,
    #[serde(rename = "whiteList")]
    white_list: bool,
    #[serde(rename = "viewDistance")]
    view_distance: u32,
    motd: String,
}

#[derive(Serialize)]
struct ServerStatus {
    is_running: bool,
    uptime_seconds: u64,
}

#[derive(Deserialize)]
struct VersionManifest {
    versions: Vec<VersionEntry>,
}

#[derive(Deserialize)]
struct VersionEntry {
    id: String,
    url: String,
}

#[derive(Deserialize)]
struct VersionDetail {
    downloads: Downloads,
}

#[derive(Deserialize)]
struct Downloads {
    server: Option<DownloadInfo>,
}

#[derive(Deserialize)]
struct DownloadInfo {
    url: String,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
struct ModInfo {
    #[serde(default)]
    id: Option<String>,
    name: String,
    #[serde(default)]
    provider_id: Option<String>,
    #[serde(default)]
    download_url: String,
    is_server_side: Option<i32>,
    is_client_side: Option<i32>,
}

#[derive(Serialize, Clone, Debug)]
struct ClientRequiredModStatus {
    name: String,
    provider_id: String,
    side: String,
    has_download_url: bool,
    installed_in_local_client: bool,
    installed_in_server_dir: bool,
    can_auto_supply: bool,
}

#[derive(Serialize, Clone, Debug)]
struct MissingPrerequisiteMod {
    mod_id: String,
    required_by: String,
    scope: String,
    #[serde(default)]
    available_locally: bool,
    #[serde(default)]
    local_jar_name: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
struct SandboxCompatibilityReport {
    server_ready: bool,
    client_join_ready: bool,
    local_mods_dir: String,
    local_installed_count: usize,
    required_client_mods: Vec<ClientRequiredModStatus>,
    missing_prerequisites: Vec<MissingPrerequisiteMod>,
    unresolved_mods: Vec<String>,
    summary_message: String,
    zip_insufficient: bool,
    confirmation_prompt: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
struct SyncClientModsResult {
    synced_count: usize,
    already_present_count: usize,
    failed_mods: Vec<String>,
    target_dir: String,
}

#[derive(Serialize, Clone, Debug)]
struct ClientHandshakeTestResult {
    reachable: bool,
    latency_ms: u64,
    version_name: String,
    protocol: i64,
    online_players: i64,
    max_players: i64,
    message: String,
}

#[derive(Deserialize)]
struct ModListResponse {
    mods: Vec<ModInfo>,
}

mod java_detector;
mod zombie_detector;
pub mod crash_analyzer;

pub use java_detector::check_java_available;
pub use zombie_detector::check_zombie_processes;
pub use zombie_detector::kill_zombie_process;

#[command]
async fn get_system_memory() -> Result<u64, String> {
    // System::new_all() は全プロセス・ディスク情報まで列挙して重いため、メモリ情報のみ取得する
    tauri::async_runtime::spawn_blocking(|| {
        let mut sys = System::new();
        sys.refresh_memory();
        let total_memory_kb = sys.total_memory();
        // sysinfo v0.29 では KB 単位で取得できるため、GB 単位に変換
        let total_gb = total_memory_kb / 1024 / 1024;
        total_gb
    })
    .await
    .map_err(|e| format!("Failed to read system memory: {}", e))
}

#[command]
fn send_server_command(session_id: String, command: String) -> Result<(), String> {
    let clean_cmd = crash_analyzer::sanitize_server_command(&command)?;
    let mut servers = ACTIVE_SERVERS.lock().unwrap();
    if let Some(proc) = servers.get_mut(&session_id) {
        let mut stdin = &proc.java_stdin;
        writeln!(stdin, "{}", clean_cmd)
            .map_err(|e| format!("Failed to send command to server: {}", e))?;
        Ok(())
    } else {
        Err("No active server session found for command transmission".to_string())
    }
}

// -----------------------------------------------------------------------------
// Mojang & Fabric Meta API Server JAR Download Logic (Hybrid Mode)
// -----------------------------------------------------------------------------

fn resolve_fabric_server_jar_url(mc_version: &str) -> Option<String> {
    let loader_url = format!("https://meta.fabricmc.net/v2/versions/loader/{}", mc_version);
    let loader_res = reqwest::blocking::get(&loader_url).ok()?;
    if !loader_res.status().is_success() {
        return None;
    }
    let loader_json: serde_json::Value = loader_res.json().ok()?;
    let loader_ver = loader_json
        .as_array()?
        .first()?
        .get("loader")?
        .get("version")?
        .as_str()?;

    let installer_url = "https://meta.fabricmc.net/v2/versions/installer";
    let installer_res = reqwest::blocking::get(installer_url).ok()?;
    if !installer_res.status().is_success() {
        return None;
    }
    let installer_json: serde_json::Value = installer_res.json().ok()?;
    let installer_ver = installer_json
        .as_array()?
        .iter()
        .find(|i| i.get("stable").and_then(|s| s.as_bool()).unwrap_or(false))
        .or_else(|| installer_json.as_array()?.first())?
        .get("version")?
        .as_str()?;

    Some(format!(
        "https://meta.fabricmc.net/v2/versions/loader/{}/{}/{}/server/jar",
        mc_version, loader_ver, installer_ver
    ))
}

fn download_server_jar(app_handle: &tauri::AppHandle, session_id: &str, mc_version: &str, loader: &str, target_path: &Path) -> Result<(), String> {
    let mut resolved_download_url: Option<String> = None;

    if loader.eq_ignore_ascii_case("fabric") {
        log_to_ui(app_handle, &format!("Resolving Fabric Server Launcher JAR for Minecraft {}...", mc_version));
        if let Some(fabric_url) = resolve_fabric_server_jar_url(mc_version) {
            log_to_ui(app_handle, &format!("Found Fabric Server JAR: {}", fabric_url));
            resolved_download_url = Some(fabric_url);
        } else {
            log_to_ui(app_handle, "Warning: Could not resolve Fabric Server JAR from meta.fabricmc.net, falling back to vanilla Mojang server.jar");
        }
    }

    let download_url = if let Some(url) = resolved_download_url {
        url
    } else {
        log_to_ui(app_handle, &format!("Downloading Mojang server.jar manifest for {}", mc_version));
        let manifest_url = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json";
        
        let response = reqwest::blocking::get(manifest_url)
            .map_err(|e| format!("Failed to fetch version manifest: {}", e))?;
        let manifest: VersionManifest = response.json()
            .map_err(|e| format!("Failed to parse version manifest: {}", e))?;

        let version_entry = manifest.versions.iter()
            .find(|v| v.id == mc_version)
            .ok_or_else(|| format!("Minecraft version {} not found in manifest", mc_version))?;

        let detail_response = reqwest::blocking::get(&version_entry.url)
            .map_err(|e| format!("Failed to fetch version detail: {}", e))?;
        let detail: VersionDetail = detail_response.json()
            .map_err(|e| format!("Failed to parse version detail: {}", e))?;

        let server_dl = detail.downloads.server
            .ok_or_else(|| format!("No server download found for version {}", mc_version))?;

        server_dl.url
    };

    log_to_ui(app_handle, &format!("Downloading server.jar from {}", download_url));

    // Check cancellation before creating file
    {
        let stopped = STOPPED_SESSIONS.lock().unwrap();
        if stopped.contains(session_id) {
            return Err("LaunchCancelled".to_string());
        }
    }

    let mut file = File::create(target_path)
        .map_err(|e| format!("Failed to create local server.jar file: {}", e))?;
    
    let mut jar_response = reqwest::blocking::get(&download_url)
        .map_err(|e| format!("Failed to download server.jar: {}", e))?;
    
    // Chunk-based download with cancellation polling
    let mut buffer = [0; 65536]; // 64KB chunks
    loop {
        {
            let stopped = STOPPED_SESSIONS.lock().unwrap();
            if stopped.contains(session_id) {
                drop(file);
                let _ = fs::remove_file(target_path);
                return Err("LaunchCancelled".to_string());
            }
        }

        let bytes_read = jar_response.read(&mut buffer)
            .map_err(|e| format!("Failed to read server.jar download stream: {}", e))?;
        
        if bytes_read == 0 {
            break;
        }

        file.write_all(&buffer[..bytes_read])
            .map_err(|e| format!("Failed to write to server.jar: {}", e))?;
    }

    log_to_ui(app_handle, "Download of server.jar completed!");
    Ok(())
}

fn find_existing_forge_args_file(mc_version: &str, server_dir: &Path) -> Option<(PathBuf, PathBuf)> {
    #[cfg(target_os = "windows")]
    let args_filename = "win_args.txt";
    #[cfg(not(target_os = "windows"))]
    let args_filename = "unix_args.txt";

    let mut candidate_lib_roots: Vec<PathBuf> = Vec::new();
    candidate_lib_roots.push(server_dir.join("libraries"));

    if let Some(mc_root) = get_local_minecraft_mods_dir().parent() {
        candidate_lib_roots.push(mc_root.join("libraries"));
    }

    if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        candidate_lib_roots.push(
            PathBuf::from(home)
                .join("curseforge")
                .join("minecraft")
                .join("Install")
                .join("libraries"),
        );
    }

    let prefix = format!("{}-", mc_version);
    for lib_root in candidate_lib_roots {
        let forge_base = lib_root.join("net").join("minecraftforge").join("forge");
        if !forge_base.is_dir() {
            continue;
        }
        let mut matched_dirs: Vec<PathBuf> = Vec::new();
        if let Ok(entries) = fs::read_dir(&forge_base) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    if let Some(dir_name) = p.file_name().and_then(|s| s.to_str()) {
                        if dir_name.starts_with(&prefix) && p.join(args_filename).is_file() {
                            matched_dirs.push(p);
                        }
                    }
                }
            }
        }
        matched_dirs.sort();
        if let Some(best_dir) = matched_dirs.pop() {
            let args_file = best_dir.join(args_filename);
            return Some((lib_root, args_file));
        }
    }
    None
}

fn resolve_forge_installer_url(mc_version: &str) -> Option<(String, String)> {
    let promo_url = "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";
    let res = reqwest::blocking::get(promo_url).ok()?;
    if !res.status().is_success() {
        return None;
    }
    let json: serde_json::Value = res.json().ok()?;
    let promos = json.get("promos")?.as_object()?;
    let rec_key = format!("{}-recommended", mc_version);
    let lat_key = format!("{}-latest", mc_version);
    let forge_ver = promos
        .get(&rec_key)
        .and_then(|v| v.as_str())
        .or_else(|| promos.get(&lat_key).and_then(|v| v.as_str()))?;
    let full_ver = format!("{}-{}", mc_version, forge_ver);
    let url = format!(
        "https://maven.minecraftforge.net/net/minecraftforge/forge/{0}/forge-{0}-installer.jar",
        full_ver
    );
    Some((full_ver, url))
}

fn copy_dir_recursive_if_missing(src: &Path, dst: &Path) {
    if !src.is_dir() {
        return;
    }
    let _ = fs::create_dir_all(dst);
    if let Ok(entries) = fs::read_dir(src) {
        for entry in entries.flatten() {
            let sp = entry.path();
            if let Some(name) = sp.file_name() {
                let dp = dst.join(name);
                if sp.is_dir() {
                    copy_dir_recursive_if_missing(&sp, &dp);
                } else if sp.is_file() && !dp.exists() {
                    let _ = fs::copy(&sp, &dp);
                }
            }
        }
    }
}

fn prepare_forge_server_environment(
    app_handle: &tauri::AppHandle,
    session_id: &str,
    mc_version: &str,
    server_dir: &Path,
    java_exe: &str,
) -> Result<String, String> {
    // 1. Locate existing Forge server libraries & win_args.txt/unix_args.txt (or install via Forge installer)
    let (lib_root, args_path) = if let Some(found) = find_existing_forge_args_file(mc_version, server_dir) {
        found
    } else {
        log_to_ui(
            app_handle,
            &format!("🔧 Forge {} サーバーライブラリを取得・構築しています...", mc_version),
        );
        let (full_ver, installer_url) = resolve_forge_installer_url(mc_version).ok_or_else(|| {
            format!("Failed to resolve Forge installer version for Minecraft {}", mc_version)
        })?;
        let installer_path = server_dir.join(format!("forge-{}-installer.jar", full_ver));
        let mut resp = reqwest::blocking::get(&installer_url)
            .map_err(|e| format!("Failed to download Forge installer: {}", e))?;
        let mut out = File::create(&installer_path)
            .map_err(|e| format!("Failed to create Forge installer file: {}", e))?;
        std::io::copy(&mut resp, &mut out)
            .map_err(|e| format!("Failed to write Forge installer file: {}", e))?;
        drop(out);

        {
            let stopped = STOPPED_SESSIONS.lock().unwrap();
            if stopped.contains(session_id) {
                let _ = fs::remove_file(&installer_path);
                return Err("LaunchCancelled".to_string());
            }
        }

        let mut install_cmd = Command::new(java_exe);
        install_cmd.current_dir(server_dir);
        install_cmd.args(["-jar", &installer_path.to_string_lossy(), "--installServer"]);
        #[cfg(target_os = "windows")]
        install_cmd.creation_flags(0x08000000);
        let status = install_cmd
            .status()
            .map_err(|e| format!("Failed to execute Forge --installServer: {}", e))?;
        let _ = fs::remove_file(&installer_path);
        if !status.success() {
            return Err("Forge server installation (--installServer) failed".to_string());
        }

        find_existing_forge_args_file(mc_version, server_dir).ok_or_else(|| {
            "Forge server libraries were installed, but win_args.txt/unix_args.txt was not found".to_string()
        })?
    };

    let raw_args = fs::read_to_string(&args_path)
        .map_err(|e| format!("Failed to read Forge args file {:?}: {}", args_path, e))?;
    let lib_root_slash = lib_root.to_string_lossy().replace('\\', "/");
    let rewritten_args = raw_args
        .replace("-DlibraryDirectory=libraries", &format!("-DlibraryDirectory={}", lib_root_slash))
        .replace("-DlibraryDirectory=\"libraries\"", &format!("-DlibraryDirectory=\"{}\"", lib_root_slash))
        .replace("libraries/", &format!("{}/", lib_root_slash))
        .replace("libraries\\", &format!("{}/", lib_root_slash));

    let custom_args_filename = "forge_server_args.txt";
    let custom_args_path = server_dir.join(custom_args_filename);
    fs::write(&custom_args_path, rewritten_args.as_bytes())
        .map_err(|e| format!("Failed to write {}: {}", custom_args_filename, e))?;

    // Forge CommonServerLaunchHandler expects server-extra.jar under libraries/net/minecraft/server/
    // Copy net/minecraft/server from lib_root into server_dir/libraries if not already present
    let src_mc_server = lib_root.join("net").join("minecraft").join("server");
    let dst_mc_server = server_dir.join("libraries").join("net").join("minecraft").join("server");
    if src_mc_server.is_dir() {
        copy_dir_recursive_if_missing(&src_mc_server, &dst_mc_server);
    }

    log_to_ui(
        app_handle,
        &format!(
            "✔️ Forge Dedicated Server 起動引数を構成しました (ライブラリ参照元: {:?})",
            lib_root
        ),
    );

    // 2. Sync config/ and defaultconfigs/ from .minecraft into server_dir so server mods have required configs
    if let Some(mc_root) = get_local_minecraft_mods_dir().parent() {
        let src_config = mc_root.join("config");
        let src_defaultconfigs = mc_root.join("defaultconfigs");
        if src_config.is_dir() {
            copy_dir_recursive_if_missing(&src_config, &server_dir.join("config"));
        }
        if src_defaultconfigs.is_dir() {
            copy_dir_recursive_if_missing(&src_defaultconfigs, &server_dir.join("defaultconfigs"));
        }
    }

    // 3. Reset old Vanilla world/ once if transitioning from Vanilla to Forge so Forge registries (e.g. epicskills:tree) initialize cleanly
    let forge_world_marker = server_dir.join(".forge_world_initialized");
    if !forge_world_marker.exists() {
        let existing_world = server_dir.join("world");
        if existing_world.is_dir() {
            log_to_ui(
                app_handle,
                "🔄 旧バニラサーバーで生成された world フォルダをリセットし、Forge MODレジストリ対応ワールドを再生成します...",
            );
            let _ = fs::remove_dir_all(&existing_world);
        }
        let _ = fs::write(&forge_world_marker, b"forge_initialized=1\n");
    }

    Ok(format!("@{}", custom_args_filename))
}

// -----------------------------------------------------------------------------
// Client Mod Pack Generation (Solution B - batch/sh scripting)
// -----------------------------------------------------------------------------

fn generate_guest_zip(
    app_handle: &tauri::AppHandle,
    session_id: &str,
    preset_name: &str,
    mods: Vec<ModInfo>,
    desktop_dir: &Path,
    server_mods_dir: Option<&Path>,
) -> Result<PathBuf, String> {
    let zip_filename = format!("msiaas_mods_{}.zip", preset_name.replace(" ", "_"));
    let zip_path = desktop_dir.join(&zip_filename);
    
    log_to_ui(app_handle, &format!("Generating guest ZIP pack at {:?}", zip_path));
    let file = File::create(&zip_path)
        .map_err(|e| format!("Failed to create zip file: {}", e))?;
    let mut zip = zip::ZipWriter::new(file);
    let text_options = FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o755);
    // .jar files are already Deflate-compressed ZIP archives; Stored avoids redundant CPU-heavy re-compression of 200+ mods
    let jar_options = FileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .unix_permissions(0o755);

    // 1. Add Windows Batch Script (UTF-8 without BOM + CRLF + chcp 65001 for Windows cmd.exe)
    let bat_lines = [
        "@echo off",
        "chcp 65001 >nul",
        "title MSIaaS Client Mods Installer",
        "echo ====================================================",
        "echo   MSIaaS クライアント用 MOD 自動導入スクリプト",
        "echo ====================================================",
        "set \"MODS_DIR=%APPDATA%\\.minecraft\\mods\"",
        "if not exist \"%MODS_DIR%\" (",
        "    mkdir \"%MODS_DIR%\"",
        ")",
        "if exist \"%~dp0mods\\*.jar\" (",
        "    echo.",
        "    echo [クリーンアップ中] .minecraft\\mods 内の既存ファイルを削除しています...",
        "    del /F /Q \"%MODS_DIR%\\*\" >nul 2>&1",
        "    echo [自動コピー中] mods フォルダ内の .jar ファイルを .minecraft\\mods へコピーしています...",
        "    xcopy /Y /Q \"%~dp0mods\\*.jar\" \"%MODS_DIR%\\\" >nul",
        "    echo [完了] 既存ファイルの削除とMODファイルの自動コピーが完了しました！",
        ") else (",
        "    echo.",
        "    echo [注意] ZIPを展開（解凍）してから実行すると自動でMODがコピーされます。",
        ")",
        "explorer \"%MODS_DIR%\"",
        "echo.",
        "echo ====================================================",
        "echo   開いた .minecraft\\mods フォルダにMODが入っていることを確認し、",
        "echo   マインクラフトを起動してください。",
        "echo ====================================================",
        "pause",
        "",
    ];
    let bat_content = bat_lines.join("\r\n");

    zip.start_file("⚠️ここにMODをコピー(Windows用).bat", text_options)
        .map_err(|e| format!("Failed to add batch script to zip: {}", e))?;
    zip.write_all(bat_content.as_bytes())
        .map_err(|e| format!("Failed to write batch script: {}", e))?;

    // 2. Add macOS Shell Script
    let sh_content = r#"#!/bin/bash
cd "$(dirname "$0")"
echo "===================================================="
echo "  MSIaaS Client Mods Installer (macOS)"
echo "===================================================="
MODS_DIR="$HOME/Library/Application Support/minecraft/mods"
mkdir -p "$MODS_DIR"
if compgen -G "./mods/*.jar" > /dev/null; then
  echo "[Cleaning] Removing existing files in $MODS_DIR..."
  rm -f "$MODS_DIR"/*
  echo "[Copying] Copying mods/*.jar into $MODS_DIR..."
  cp -f ./mods/*.jar "$MODS_DIR"/
  echo "[Done] All client mods have been installed!"
fi
open "$MODS_DIR"
echo "===================================================="
"#;
    zip.start_file("⚠️ここにMODをコピー(Mac用).command", text_options)
        .map_err(|e| format!("Failed to add Mac command to zip: {}", e))?;
    zip.write_all(sh_content.as_bytes())
        .map_err(|e| format!("Failed to write Mac command: {}", e))?;

    // 3. Add Client Mods to "mods/" directory inside zip (reusing local cache before parallel download)
    zip.add_directory("mods/", text_options)
        .map_err(|e| format!("Failed to create mods directory in zip: {}", e))?;

    let local_index = build_local_jar_index(server_mods_dir);
    let mut mods_to_download: Vec<(ModInfo, String)> = Vec::new();
    let mut written_zip_entries = std::collections::HashSet::<String>::new();

    for m in mods {
        {
            let stopped = STOPPED_SESSIONS.lock().unwrap();
            if stopped.contains(session_id) {
                drop(zip);
                let _ = fs::remove_file(&zip_path);
                return Err("LaunchCancelled".to_string());
            }
        }

        let sanitized_name = sanitize_jar_filename(&m.name);

        // Fast path: reuse already-downloaded server mod or local .minecraft/CurseForge jar (preserving exact original filename)
        if let Some(local_jar) = find_jar_in_index(&m, &local_index) {
            let local_fname = local_jar
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| sanitized_name.clone());
            let actual_zip_path = format!("mods/{}", local_fname);
            if !written_zip_entries.insert(actual_zip_path.to_ascii_lowercase()) {
                continue;
            }
            if let Ok(mut local_file) = File::open(&local_jar) {
                if zip.start_file(&actual_zip_path, jar_options).is_ok() {
                    let _ = std::io::copy(&mut local_file, &mut zip);
                    continue;
                }
            }
        }

        if m.download_url.trim().is_empty() {
            log_to_ui(app_handle, &format!("Warning: download URL is empty for client mod: {}. Skipping.", m.name));
            continue;
        }

        mods_to_download.push((m, sanitized_name));
    }

    // Parallel download any remaining uncached client mods into a temporary staging dir
    if !mods_to_download.is_empty() {
        let temp_zip_dl_dir = std::env::temp_dir().join(format!("msiaas_zip_dl_{}", session_id));
        let _ = fs::create_dir_all(&temp_zip_dl_dir);

        let dl_tasks: Vec<(ModInfo, PathBuf)> = mods_to_download
            .iter()
            .map(|(m, sname)| (m.clone(), temp_zip_dl_dir.join(sname)))
            .collect();

        download_mods_parallel(app_handle, session_id, dl_tasks, None)?;

        for (_m, sname) in &mods_to_download {
            let dl_path = temp_zip_dl_dir.join(sname);
            if dl_path.is_file() {
                let actual_zip_path = format!("mods/{}", sname);
                if !written_zip_entries.insert(actual_zip_path.to_ascii_lowercase()) {
                    continue;
                }
                if let Ok(mut f) = File::open(&dl_path) {
                    if zip.start_file(&actual_zip_path, jar_options).is_ok() {
                        let _ = std::io::copy(&mut f, &mut zip);
                    }
                }
            }
        }
        let _ = fs::remove_dir_all(&temp_zip_dl_dir);
    }

    zip.finish().map_err(|e| format!("Failed to finalize zip file: {}", e))?;
    Ok(zip_path)
}

fn sanitize_filename(name: &str) -> String {
    let sanitized: String = name.chars().map(|c| {
        match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            | '[' | ']' | '!' | '+' | '#' | '%' | '&' | '{' | '}' | '$' | '@' => '_',
            c if c.is_ascii_control() => '_',
            _ => c,
        }
    }).collect();
    // Collapse multiple consecutive underscores and trim
    let mut result = String::new();
    let mut prev_underscore = false;
    for c in sanitized.trim().chars() {
        if c == '_' {
            if !prev_underscore {
                result.push('_');
            }
            prev_underscore = true;
        } else {
            result.push(c);
            prev_underscore = false;
        }
    }
    if result.is_empty() {
        "unnamed_mod".to_string()
    } else {
        result
    }
}

fn sanitize_jar_filename(name: &str) -> String {
    let base = sanitize_filename(name).replace(' ', "_");
    if base.to_ascii_lowercase().ends_with(".jar") {
        base
    } else {
        format!("{}.jar", base)
    }
}

fn should_include_mod_on_server(m: &ModInfo, approved_server_mod_names: &Option<Vec<String>>) -> bool {
    let sanitized = sanitize_jar_filename(&m.name);
    if is_known_client_only_mod(&m.name, &sanitized) {
        return false;
    }
    if let Some(ref approved) = approved_server_mod_names {
        return approved.iter().any(|name| name == &m.name);
    }
    m.is_server_side != Some(0)
}

fn is_safe_input(s: &str) -> bool {
    if s.is_empty() || s == "." || s == ".." || s.contains("..") {
        return false;
    }
    s.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
}

fn get_playit_tunnel_address() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        let playit_path = "C:\\Program Files\\playit_gg\\bin\\playit.exe";
        if !std::path::Path::new(playit_path).exists() {
            return None;
        }

        let mut cmd = Command::new(playit_path);
        cmd.arg("tunnels").arg("list");
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        
        let output = cmd.output().ok()?;

        if !output.status.success() {
            return None;
        }

        let stdout_str = String::from_utf8_lossy(&output.stdout);
        let json: serde_json::Value = serde_json::from_str(&stdout_str).ok()?;
        
        let tunnels = json.get("tunnels")?.as_array()?;
        for tunnel in tunnels {
            let active = tunnel.get("active")?.as_bool().unwrap_or(false);
            let port_type = tunnel.get("port_type")?.as_str().unwrap_or("");
            
            if active && port_type == "tcp" {
                let alloc_data = tunnel.get("alloc")?.get("data")?;
                
                // Try assigned_srv first
                if let Some(srv) = alloc_data.get("assigned_srv").and_then(|v| v.as_str()) {
                    if let Some(port) = alloc_data.get("port_start").and_then(|v| v.as_u64()) {
                        return Some(format!("{}:{}", srv, port));
                    }
                    return Some(srv.to_string());
                }
                
                // Fallback to static_ip4
                if let Some(ip) = alloc_data.get("static_ip4").and_then(|v| v.as_str()) {
                    if let Some(port) = alloc_data.get("port_start").and_then(|v| v.as_u64()) {
                        return Some(format!("{}:{}", ip, port));
                    }
                }
            }
        }
    }

    None
}

fn update_session_reason(session_id: &str, status: &str, reason: &str, final_address: &str, java_pid: u32) {
    let session_id = session_id.to_string();
    let status = status.to_string();
    let reason = reason.to_string();
    let final_address = final_address.to_string();

    // Run HTTP call on a dedicated OS thread to prevent Tokio runtime shutdown panics
    // when called from an asynchronous context (e.g. async fn start_server)
    let _ = std::thread::spawn(move || {
        let url = "http://localhost:8787/api/servers/session";
        let body = serde_json::json!({
            "sessionId": session_id,
            "status": status,
            "ipAddress": final_address,
            "instanceId": java_pid.to_string(),
            "javaPid": java_pid,
            "cloudProvider": "local",
            "reason": reason
        });
        if let Ok(client) = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
        {
            if let Err(e) = client.put(url).json(&body).send() {
                eprintln!("[update_session_reason] Failed to update session status: {}", e);
            }
        }
    }).join();
}

// -----------------------------------------------------------------------------
// Core Tauri Commands
// -----------------------------------------------------------------------------

#[command]
async fn start_server(
    app_handle: tauri::AppHandle,
    session_id: String,
    preset_id: String,
    preset_name: String,
    mc_version: String,
    loader: String,
    allocated_memory_gb: u32,
    properties: MinecraftProperties,
    approved_server_mod_names: Option<Vec<String>>,
    custom_java_path: Option<String>,
    use_playit_gg: Option<bool>,
) -> Result<ServerStartResult, String> {
    if !is_safe_input(&mc_version) {
        return Err("Security Error: Invalid or unsafe mc_version string detected!".to_string());
    }
    if !is_safe_input(&loader) {
        return Err("Security Error: Invalid or unsafe loader string detected!".to_string());
    }

    let session_id_clone = session_id.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();

    std::thread::spawn(move || {
        let result = start_server_blocking(
            app_handle,
            session_id,
            preset_id,
            preset_name,
            mc_version,
            loader,
            allocated_memory_gb,
            properties,
            approved_server_mod_names,
            custom_java_path,
            use_playit_gg,
        );
        let _ = tx.send(result);
    });

    let res = rx.await
        .map_err(|e| format!("Thread communication error: {}", e))?;

    // もしエラーが発生した場合、データベースのステータスを failed または stopped に更新する
    if let Err(ref err) = res {
        let is_cancel = err == "LaunchCancelled";
        let status = if is_cancel { "stopped" } else { "failed" };
        let reason = if is_cancel {
            "[停止完了] ユーザーによってサーバー構築がキャンセルされました。"
        } else {
            &format!("[起動失敗] エラーが発生しました: {}", err)
        };
        update_session_reason(&session_id_clone, status, reason, "", 0);
        
        // 念のため、STOPPED_SESSIONS から削除してクリーンアップ
        let mut stopped = STOPPED_SESSIONS.lock().unwrap();
        stopped.remove(&session_id_clone);
    } else {
        // 成功した場合も、STOPPED_SESSIONS から削除してクリーンアップ
        let mut stopped = STOPPED_SESSIONS.lock().unwrap();
        stopped.remove(&session_id_clone);
    }

    res
}

fn write_server_properties(server_dir: &Path, props: &MinecraftProperties) -> Result<(), String> {
    let properties_path = server_dir.join("server.properties");
    let mut properties_file = File::create(&properties_path)
        .map_err(|e| format!("Failed to create server.properties: {}", e))?;
    
    let properties_content = format!(
        "online-mode=true\n\
         server-port=25565\n\
         pvp={}\n\
         max-players={}\n\
         motd={}\n\
         difficulty={}\n\
         gamemode={}\n\
         allow-flight={}\n\
         white-list={}\n\
         view-distance={}\n\
         spawn-protection=0\n\
         max-tick-time=-1\n",
        props.pvp,
        props.max_players,
        props.motd,
        props.difficulty,
        props.gamemode,
        props.allow_flight,
        props.white_list,
        props.view_distance
    );
    properties_file.write_all(properties_content.as_bytes())
        .map_err(|e| format!("Failed to write server.properties: {}", e))?;
    Ok(())
}

fn build_java_args(allocated_memory_gb: u32, forge_arg_file: Option<&str>) -> Vec<String> {
    let xms_arg = format!("-Xms{}G", allocated_memory_gb);
    let xmx_arg = format!("-Xmx{}G", allocated_memory_gb);
    
    let mut args = vec![
        xms_arg,
        xmx_arg,
        "-XX:+UseG1GC".to_string(),
        "-XX:+ParallelRefProcEnabled".to_string(),
        "-XX:MaxGCPauseMillis=200".to_string(),
        "-XX:+UnlockExperimentalVMOptions".to_string(),
        "-XX:+DisableExplicitGC".to_string(),
        "-XX:G1NewSizePercent=30".to_string(),
        "-XX:G1MaxNewSizePercent=40".to_string(),
        "-XX:G1HeapRegionSize=8M".to_string(),
        "-XX:G1ReservePercent=20".to_string(),
        "-XX:G1MixedGCCountTarget=4".to_string(),
        "-XX:InitiatingHeapOccupancyPercent=15".to_string(),
        "-XX:G1MixedGCLiveThresholdPercent=90".to_string(),
        "-XX:G1RSetUpdatingPauseTimePercent=5".to_string(),
        "-XX:SurvivorRatio=32".to_string(),
        "-XX:+PerfDisableSharedMem".to_string(),
        "-XX:MaxTenuringThreshold=1".to_string(),
        "-Dfml.readTimeout=180".to_string(),
    ];

    if let Some(arg_file) = forge_arg_file {
        args.push(arg_file.to_string());
        args.push("--nogui".to_string());
    } else {
        args.push("-jar".to_string());
        args.push("minecraft_server.jar".to_string());
        args.push("--nogui".to_string());
    }

    args
}

fn start_server_blocking(
    app_handle: tauri::AppHandle,
    session_id: String,
    _preset_id: String,
    preset_name: String,
    mc_version: String,
    loader: String,
    allocated_memory_gb: u32,
    properties: MinecraftProperties,
    approved_server_mod_names: Option<Vec<String>>,
    custom_java_path: Option<String>,
    use_playit_gg: Option<bool>,
) -> Result<ServerStartResult, String> {
    log_to_ui(&app_handle, &format!("Starting server setup for session: {}", session_id));

    // Track spawned processes for cleanup on cancellation
    let mut spawned_java: Option<Child> = None;
    let mut spawned_tunnel: Option<Child> = None;

    // Helper closure to check cancellation and clean up
    let check_cancelled = |java_proc: &mut Option<Child>, tunnel_proc: &mut Option<Child>| -> Result<(), String> {
        let stopped = STOPPED_SESSIONS.lock().unwrap();
        if stopped.contains(&session_id) {
            log_to_ui(&app_handle, "⚠️ Server launch was cancelled by the user. Terminating processes...");
            if let Some(ref mut child) = *java_proc {
                let _ = child.kill();
            }
            if let Some(ref mut child) = *tunnel_proc {
                let _ = child.kill();
            }
            return Err("LaunchCancelled".to_string());
        }
        Ok(())
    };

    check_cancelled(&mut spawned_java, &mut spawned_tunnel)?;

    emit_progress(&app_handle, 15);

    // Locate Java EXE early so Forge installer/provisioning can use it if needed
    let java_exe = if let Some(ref custom_path) = custom_java_path {
        let trimmed = custom_path.trim();
        if !trimmed.is_empty() && Path::new(trimmed).exists() {
            log_to_ui(&app_handle, &format!("Using custom Java path from settings: {}", trimmed));
            trimmed.to_string()
        } else {
            let java_info = java_detector::check_java_available_blocking()?;
            java_info.path.ok_or_else(|| "Java executable path is missing".to_string())?
        }
    } else {
        let java_info = java_detector::check_java_available_blocking()?;
        java_info.path.ok_or_else(|| "Java executable path is missing".to_string())?
    };

    // Clean up any duplicate `_`-sanitized JARs in local .minecraft/mods before indexing
    clean_duplicate_sanitized_jars_in_dir(&get_local_minecraft_mods_dir());

    // 1. Resolve storage directories
    let app_data = app_handle.path_resolver().app_data_dir()
        .ok_or_else(|| "Failed to resolve app data directory".to_string())?;
    
    let server_dir = app_data.join("servers").join(&mc_version).join(&loader);
    fs::create_dir_all(&server_dir)
        .map_err(|e| format!("Failed to create server directory: {}", e))?;

    emit_progress(&app_handle, 20);

    // 2. Resolve server launcher (Forge @forge_server_args.txt vs Fabric/Vanilla minecraft_server.jar)
    let forge_arg_file: Option<String> = if loader.eq_ignore_ascii_case("forge") {
        update_session_reason(&session_id, "provisioning", "[パッケージ展開中] Forge Dedicated Server 環境・ライブラリ・設定ファイルを構築中...", "", 0);
        let arg = prepare_forge_server_environment(&app_handle, &session_id, &mc_version, &server_dir, &java_exe)?;
        Some(arg)
    } else {
        let jar_path = server_dir.join("minecraft_server.jar");
        if !jar_path.exists() {
            update_session_reason(&session_id, "provisioning", "[パッケージ展開中] サーバーJARの整合性チェック ＆ ダウンロード中...", "", 0);
            // First check bundled resources
            let resource_path = app_handle.path_resolver()
                .resolve_resource(format!("resources/servers/{}/{}/minecraft_server.jar", mc_version, loader));
            
            if let Some(ref path) = resource_path {
                if path.exists() {
                    log_to_ui(&app_handle, &format!("Bundled server.jar found at {:?}, copying...", path));
                    fs::copy(path, &jar_path)
                        .map_err(|e| format!("Failed to copy bundled server.jar: {}", e))?;
                } else {
                    download_server_jar(&app_handle, &session_id, &mc_version, &loader, &jar_path)?;
                }
            } else {
                download_server_jar(&app_handle, &session_id, &mc_version, &loader, &jar_path)?;
            }
        }
        None
    };

    emit_progress(&app_handle, 30);

    check_cancelled(&mut spawned_java, &mut spawned_tunnel)?;

    // 3. Write eula.txt (EULA is agreed in UI first)
    let eula_path = server_dir.join("eula.txt");
    let mut eula_file = File::create(&eula_path)
        .map_err(|e| format!("Failed to create eula.txt: {}", e))?;
    eula_file.write_all(b"eula=true\n")
        .map_err(|e| format!("Failed to write eula.txt: {}", e))?;

    check_cancelled(&mut spawned_java, &mut spawned_tunnel)?;

    // 4. Generate server.properties
    update_session_reason(&session_id, "provisioning", "[パッケージ展開中] サーバープロパティ・MOD構成ファイルを配置中...", "", 0);
    write_server_properties(&server_dir, &properties)?;

    // 5. Download mods (Wrangler API server active mods)
    let mods_dir = server_dir.join("mods");
    fs::create_dir_all(&mods_dir)
        .map_err(|e| format!("Failed to create mods directory: {}", e))?;

    // Fetch active mods from local development Wrangler API (port 8787)
    let client_mods_url = "http://localhost:8787/api/servers/active/mods";
    let client = reqwest::blocking::Client::new();
    
    // We try to get mods list (handling empty or fail gracefully)
    let mut active_mods: Vec<ModInfo> = Vec::new();
    if let Ok(res) = client.get(client_mods_url).send() {
        if let Ok(parsed) = res.json::<ModListResponse>() {
            active_mods = parsed.mods;
        }
    }

    // Filter out client_only mods & apply user-approved server mod list
    let mut server_mods: Vec<ModInfo> = Vec::new();
    for m in &active_mods {
        if should_include_mod_on_server(m, &approved_server_mod_names) {
            server_mods.push(m.clone());
        } else {
            log_to_ui(&app_handle, &format!("🛡️ [MOD Side Filter] クライアント専用または除外対象のMODをサーバー配置からスキップしました: {}", m.name));
        }
    }

    // Delete all existing files in server mods_dir before copying/downloading (staging any needed local jars first)
    let server_staging_dir = server_dir.join(".mods_staging");
    if server_staging_dir.exists() {
        let _ = fs::remove_dir_all(&server_staging_dir);
    }
    fs::create_dir_all(&server_staging_dir)
        .map_err(|e| format!("Failed to create server mods staging directory: {}", e))?;

    // Build local jar index ONCE (O(N) instead of O(N^2) across 200+ mods)
    let local_jar_index = build_local_jar_index_with_progress(Some(&mods_dir), Some(&app_handle));
    let mut mods_to_download: Vec<(ModInfo, PathBuf)> = Vec::new();
    let mut staged_filenames = std::collections::HashSet::<String>::new();

    for m in &server_mods {
        if let Some(found_meta) = find_jar_meta_in_index(m, &local_jar_index) {
            if is_known_client_only_mod(&found_meta.mod_id, &found_meta.filename)
                || is_known_client_only_mod(&m.name, &found_meta.filename)
                || found_meta.client_side_only
            {
                log_to_ui(
                    &app_handle,
                    &format!(
                        "🛡️ [Dedicated Server Filter] クライアント専用MOD ({}) をサーバー mods フォルダから自動除外しました。",
                        found_meta.filename
                    ),
                );
                continue;
            }
            let orig_fname = found_meta.filename.clone();
            let staged_path = server_staging_dir.join(&orig_fname);
            if staged_filenames.insert(orig_fname.to_ascii_lowercase()) {
                let _ = fs::copy(&found_meta.path, &staged_path);
            }
            continue;
        }

        let sanitized_name = sanitize_jar_filename(&m.name);
        if is_known_client_only_mod(&m.name, &sanitized_name) {
            log_to_ui(
                &app_handle,
                &format!(
                    "🛡️ [Dedicated Server Filter] クライアント専用MOD ({}) をサーバー mods フォルダから自動除外しました。",
                    m.name
                ),
            );
            continue;
        }

        let existing_exact = mods_dir.join(&sanitized_name);
        if existing_exact.is_file() {
            let staged_path = server_staging_dir.join(&sanitized_name);
            if staged_filenames.insert(sanitized_name.to_ascii_lowercase()) {
                let _ = fs::copy(&existing_exact, &staged_path);
            }
            continue;
        }

        if m.download_url.trim().is_empty() {
            log_to_ui(&app_handle, &format!("Warning: download URL is empty for mod: {}. Skipping.", m.name));
            continue;
        }

        let staged_path = server_staging_dir.join(&sanitized_name);
        if staged_filenames.insert(sanitized_name.to_ascii_lowercase()) {
            mods_to_download.push((m.clone(), staged_path));
        }
    }

    // Download any uncached server mods in parallel (8 concurrent connections)
    if !mods_to_download.is_empty() {
        log_to_ui(
            &app_handle,
            &format!("⚡ 未キャッシュのサーバーMOD ({}件) を8並列で高速ダウンロードしています...", mods_to_download.len()),
        );
        if let Err(e) = download_mods_parallel(&app_handle, &session_id, mods_to_download, Some((30, 38))) {
            let _ = fs::remove_dir_all(&server_staging_dir);
            return Err(e);
        }
    }

    check_cancelled(&mut spawned_java, &mut spawned_tunnel)?;

    // Wipe existing files in mods_dir completely
    if let Ok(entries) = fs::read_dir(&mods_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() {
                let _ = fs::remove_file(&p);
            } else if p.is_dir() {
                let _ = fs::remove_dir_all(&p);
            }
        }
        log_to_ui(&app_handle, "🧹 サーバー mods フォルダ内の既存ファイルをすべてクリーンアップしました。");
    }

    // Move staged server mods into clean mods_dir
    if let Ok(staged_entries) = fs::read_dir(&server_staging_dir) {
        for entry in staged_entries.flatten() {
            let src = entry.path();
            if src.is_file() {
                if let Some(fname) = src.file_name() {
                    let dst = mods_dir.join(fname);
                    if fs::rename(&src, &dst).is_err() {
                        let _ = fs::copy(&src, &dst);
                    }
                }
            }
        }
    }
    let _ = fs::remove_dir_all(&server_staging_dir);

    emit_progress(&app_handle, 40);

    // 6. Start Guest ZIP Pack (Raku-Raku pack) generation in a background thread so Java server boots immediately in parallel!
    let client_mods: Vec<ModInfo> = active_mods
        .into_iter()
        .filter(|m| m.is_client_side != Some(0))
        .collect();
    
    let d_dir = tauri::api::path::desktop_dir();
    let app_handle_for_zip = app_handle.clone();
    let session_id_for_zip = session_id.clone();
    let preset_name_for_zip = preset_name.clone();
    let mods_dir_for_zip = mods_dir.clone();

    let zip_join_handle = thread::spawn(move || -> Result<Option<String>, String> {
        if let Some(ref path) = d_dir {
            match generate_guest_zip(
                &app_handle_for_zip,
                &session_id_for_zip,
                &preset_name_for_zip,
                client_mods,
                path,
                Some(&mods_dir_for_zip),
            ) {
                Ok(zp) => Ok(Some(zp.to_string_lossy().to_string())),
                Err(e) => {
                    if e == "LaunchCancelled" {
                        return Err("LaunchCancelled".to_string());
                    }
                    log_to_ui(&app_handle_for_zip, &format!("Warning: Guest ZIP Pack generation failed: {}", e));
                    Ok(None)
                }
            }
        } else {
            Ok(None)
        }
    });

    // 7. Aikar's Flags & memory setup
    let java_args = build_java_args(allocated_memory_gb, forge_arg_file.as_deref());

    check_cancelled(&mut spawned_java, &mut spawned_tunnel)?;

    // 9. Spawn Java Direct execution process
    update_session_reason(&session_id, "provisioning", "[サーバープロセス起動中] Javaサーバープロセスを立ち上げています...", "", 0);
    log_to_ui(&app_handle, &format!("Launching Minecraft Server with Aikar's Flags (Memory: {}G)", allocated_memory_gb));
    let mut java_cmd = Command::new(&java_exe);
    java_cmd.current_dir(&server_dir);
    java_cmd.args(&java_args);
    java_cmd.stdin(Stdio::piped());
    java_cmd.stdout(Stdio::piped());
    java_cmd.stderr(Stdio::piped());
    
    #[cfg(target_os = "windows")]
    java_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut java_child_proc = java_cmd.spawn()
        .map_err(|e| format!("Failed to spawn Java process: {}", e))?;
    let java_stdin = java_child_proc.stdin.take()
        .ok_or_else(|| "Failed to capture Java stdin".to_string())?;
    spawned_java = Some(java_child_proc);
    check_cancelled(&mut spawned_java, &mut spawned_tunnel)?;
    let mut java_child = spawned_java.take().unwrap();

    emit_progress(&app_handle, 45);

    // Monitor stdout and stderr in background threads
    let java_stdout = java_child.stdout.take()
        .ok_or_else(|| "Failed to capture Java stdout".to_string())?;
    let java_stderr = java_child.stderr.take()
        .ok_or_else(|| "Failed to capture Java stderr".to_string())?;
    
    let log_history = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let log_history_stdout = log_history.clone();
    let log_history_stderr = log_history.clone();

    let is_done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let is_done_clone = is_done.clone();

    // Forge + 200MOD 規模では起動時に数千行のログが出るため、1行ごとにUIへイベントを送ると
    // WebViewが処理落ちする。stdout/stderr の行をチャネルに集め、専用スレッドが
    // 最大80行 or 250ms ごとにまとめて "server-log-batch" イベントとして送信する。
    let (log_tx, log_rx) = std::sync::mpsc::channel::<String>();
    let app_handle_flusher = app_handle.clone();
    thread::spawn(move || {
        let mut pending: Vec<String> = Vec::new();
        loop {
            match log_rx.recv_timeout(Duration::from_millis(250)) {
                Ok(line) => {
                    pending.push(line);
                    // 溜まっている分をまとめて取り出す
                    while pending.len() < 80 {
                        match log_rx.try_recv() {
                            Ok(l) => pending.push(l),
                            Err(_) => break,
                        }
                    }
                    if pending.len() >= 80 {
                        let _ = app_handle_flusher.emit_all("server-log-batch", std::mem::take(&mut pending));
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if !pending.is_empty() {
                        let _ = app_handle_flusher.emit_all("server-log-batch", std::mem::take(&mut pending));
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    if !pending.is_empty() {
                        let _ = app_handle_flusher.emit_all("server-log-batch", std::mem::take(&mut pending));
                    }
                    break;
                }
            }
        }
    });

    // Start a thread to read stdout and print to log/monitor for "Done" and real-time progress
    let app_handle_clone = app_handle.clone();
    let log_tx_stdout = log_tx.clone();
    thread::spawn(move || {
        let reader = BufReader::new(java_stdout);
        for line in reader.lines().flatten() {
            let formatted = format!("[Minecraft Server] {}", line);
            println!("{}", formatted);
            let _ = log_tx_stdout.send(formatted);
            
            {
                let mut history = log_history_stdout.lock().unwrap();
                history.push(line.clone());
                if history.len() > 500 {
                    history.remove(0);
                }
            }
            
            // ワールド生成進捗をパースして通知 (Preparing spawn area: XX%)
            if line.contains("Preparing") && line.contains("%") {
                if let Some(idx) = line.find('%') {
                    let prefix = &line[..idx];
                    let num_str: String = prefix.chars().rev().take_while(|c| c.is_ascii_digit()).collect();
                    let num_str: String = num_str.chars().rev().collect();
                    if let Ok(pct) = num_str.parse::<u32>() {
                        // 0%〜100% を 45%〜80% にマッピングして滑らかに更新
                        let mapped = 45 + (pct * 35 / 100);
                        let _ = app_handle_clone.emit_all("server-launch-progress", mapped);
                    }
                }
            }

            if line.contains("Done") || line.contains("For help, type") {
                is_done_clone.store(true, std::sync::atomic::Ordering::SeqCst);
                let _ = app_handle_clone.emit_all("server-launch-progress", 80);
            }
        }
    });

    // Start a thread to read stderr
    let log_tx_stderr = log_tx;
    thread::spawn(move || {
        let reader = BufReader::new(java_stderr);
        for line in reader.lines().flatten() {
            let formatted = format!("[Minecraft Server ERR] {}", line);
            println!("{}", formatted);
            let _ = log_tx_stderr.send(formatted);
            
            {
                let mut history = log_history_stderr.lock().unwrap();
                history.push(line.clone());
                if history.len() > 500 {
                    history.remove(0);
                }
            }
        }
    });

    // Wait for "Done" output with a 5-minute timeout
    let java_pid = java_child.id();
    update_session_reason(&session_id, "provisioning", "[サーバー起動待機中] Minecraftサーバーがワールドを読み込んでいます...", "", java_pid);
    log_to_ui(&app_handle, "Waiting for server 'Done' log...");
    let timeout = Duration::from_secs(300);
    let start_wait = SystemTime::now();
    loop {
        spawned_java = Some(java_child);
        check_cancelled(&mut spawned_java, &mut spawned_tunnel)?;
        java_child = spawned_java.take().unwrap();

        if is_done.load(std::sync::atomic::Ordering::SeqCst) {
            log_to_ui(&app_handle, "✔️ Minecraft Server successfully booted!");
            let handshake = perform_client_handshake_ping("127.0.0.1", 25565);
            if handshake.reachable {
                log_to_ui(
                    &app_handle,
                    &format!(
                        "🟢 [クライアント入室テスト合格] 構築したサーバー(127.0.0.1:25565)への模擬クライアント接続(Handshake Ping)に成功しました！ (応答: {}ms / バージョン: {})",
                        handshake.latency_ms, handshake.version_name
                    ),
                );
            } else {
                log_to_ui(
                    &app_handle,
                    &format!("⚠️ [クライアント入室テスト] ローカルポート確認: {}", handshake.message),
                );
            }
            break;
        }
        
        if let Ok(elapsed) = start_wait.elapsed() {
            if elapsed >= timeout {
                // Kill process on timeout
                let _ = java_child.kill();
                return Err("Minecraft Server boot timed out (5 minutes elapsed)".to_string());
            }
        }

        // Check if child crashed immediately
        if let Ok(Some(status)) = java_child.try_wait() {
            let logs = log_history.lock().unwrap().clone();
            let exit_code = status.code().unwrap_or(-1);
            let detailed_error = analyze_minecraft_crash_logs(&logs, exit_code);
            return Err(detailed_error);
        }

        thread::sleep(Duration::from_millis(150));
    }

    spawned_java = Some(java_child);
    check_cancelled(&mut spawned_java, &mut spawned_tunnel)?;
    java_child = spawned_java.take().unwrap();

    // 10. Tunnel selection & setup
    update_session_reason(&session_id, "provisioning", "[外部接続開通中] 外部接続トンネル (playit.gg / serveo.net) を確立しています...", "", java_pid);
    let mut tunnel_child: Option<Child> = None;
    let mut final_address = "localhost:25565".to_string();

    #[cfg(target_os = "windows")]
    let playit_address = if use_playit_gg.unwrap_or(true) {
        get_playit_tunnel_address()
    } else {
        None
    };
    #[cfg(not(target_os = "windows"))]
    let playit_address: Option<String> = None;

    emit_progress(&app_handle, 85);

    if let Some(addr) = playit_address {
        log_to_ui(&app_handle, "✔️ playit.gg detected! Launching playit tunnel...");
        let playit_path = "C:\\Program Files\\playit_gg\\bin\\playit.exe";
        let mut playit_cmd = Command::new(playit_path);
        playit_cmd.arg("-s").arg("start");
        playit_cmd.stdout(Stdio::piped());
        playit_cmd.stderr(Stdio::piped());
        
        #[cfg(target_os = "windows")]
        playit_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        
        match playit_cmd.spawn() {
            Ok(child) => {
                spawned_java = Some(java_child);
                spawned_tunnel = Some(child);
                check_cancelled(&mut spawned_java, &mut spawned_tunnel)?;
                java_child = spawned_java.take().unwrap();
                tunnel_child = spawned_tunnel.take();

                final_address = addr.clone();
                log_to_ui(&app_handle, &format!("🚀 playit.gg tunnel running at: {}", final_address));
            }
            Err(e) => {
                log_to_ui(&app_handle, &format!("Warning: Failed to launch playit.exe: {}. Falling back to serveo.net...", e));
            }
        }
    }

    if tunnel_child.is_none() {
        // Fallback to SSH serveo.net tunnel
        log_to_ui(&app_handle, "Establishing SSH Tunnel to serveo.net...");
        let mut ssh_cmd = Command::new("ssh");
        ssh_cmd.args(&[
            "-o", "StrictHostKeyChecking=no",
            "-o", "ServerAliveInterval=60",
            "-o", "ServerAliveCountMax=3",
            "-R", "0:localhost:25565",
            "serveo.net"
        ]);
        ssh_cmd.stdout(Stdio::piped());
        ssh_cmd.stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        ssh_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

        match ssh_cmd.spawn() {
            Ok(mut ssh_child_proc) => {
                spawned_java = Some(java_child);
                spawned_tunnel = Some(ssh_child_proc);
                check_cancelled(&mut spawned_java, &mut spawned_tunnel)?;
                java_child = spawned_java.take().unwrap();
                ssh_child_proc = spawned_tunnel.take().unwrap();

                let ssh_stdout = ssh_child_proc.stdout.take()
                    .ok_or_else(|| "Failed to capture SSH stdout".to_string())?;

                let tunnel_address = std::sync::Arc::new(Mutex::new(String::new()));
                let tunnel_address_clone = tunnel_address.clone();
                let tunnel_detected = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
                let tunnel_detected_clone = tunnel_detected.clone();

                // Spawn a thread to capture SSH output and parse serveo.net address
                let app_handle_clone2 = app_handle.clone();
                thread::spawn(move || {
                    let reader = BufReader::new(ssh_stdout);
                    for line in reader.lines().flatten() {
                        log_to_ui(&app_handle_clone2, &format!("[SSH Tunnel] {}", line));
                        if line.contains("serveo.net") {
                            if let Some(idx) = line.find("serveo.net:") {
                                let suffix = &line[idx..];
                                let addr: String = suffix.chars().take_while(|c| c.is_alphanumeric() || *c == ':' || *c == '.').collect();
                                let mut lock = tunnel_address_clone.lock().unwrap();
                                *lock = addr;
                                tunnel_detected_clone.store(true, std::sync::atomic::Ordering::SeqCst);
                            }
                        }
                    }
                });

                // Wait for SSH tunnel address detection with 8-second timeout
                log_to_ui(&app_handle, "Waiting for serveo.net address assignment...");
                let tunnel_timeout = Duration::from_secs(8);
                let start_tunnel_wait = SystemTime::now();

                loop {
                    spawned_java = Some(java_child);
                    spawned_tunnel = Some(ssh_child_proc);
                    check_cancelled(&mut spawned_java, &mut spawned_tunnel)?;
                    java_child = spawned_java.take().unwrap();
                    ssh_child_proc = spawned_tunnel.take().unwrap();

                    if tunnel_detected.load(std::sync::atomic::Ordering::SeqCst) {
                        let lock = tunnel_address.lock().unwrap();
                        final_address = lock.clone();
                        log_to_ui(&app_handle, &format!("✔️ SSH Tunnel established at: {}", final_address));
                        break;
                    }

                    if let Ok(elapsed) = start_tunnel_wait.elapsed() {
                        if elapsed >= tunnel_timeout {
                            log_to_ui(&app_handle, "Warning: SSH Tunnel address detection timed out. Proceeding with fallback localhost. For 100% stability, please install and configure playit.gg!");
                            break;
                        }
                    }

                    if let Ok(Some(status)) = ssh_child_proc.try_wait() {
                        log_to_ui(&app_handle, &format!("Warning: SSH process exited prematurely with status {}. Falling back to localhost. For 100% stability, please install and configure playit.gg!", status));
                        break;
                    }

                    thread::sleep(Duration::from_millis(100));
                }
                
                spawned_java = Some(java_child);
                spawned_tunnel = Some(ssh_child_proc);
                check_cancelled(&mut spawned_java, &mut spawned_tunnel)?;
                java_child = spawned_java.take().unwrap();
                let ssh_child_proc_final = spawned_tunnel.take().unwrap();
                
                tunnel_child = Some(ssh_child_proc_final);
            }
            Err(e) => {
                log_to_ui(&app_handle, &format!("Warning: Failed to spawn SSH process: {}. Falling back to localhost. For 100% stability, please install and configure playit.gg!", e));
            }
        }
    }

    spawned_java = Some(java_child);
    spawned_tunnel = tunnel_child;
    check_cancelled(&mut spawned_java, &mut spawned_tunnel)?;
    java_child = spawned_java.take().unwrap();
    tunnel_child = spawned_tunnel.take();

    // Register active processes globally for monitoring/termination
    {
        let mut servers = ACTIVE_SERVERS.lock().unwrap();
        servers.insert(
            session_id.clone(),
            ServerProcess {
                java_child,
                java_stdin,
                tunnel_child,
                started_at: SystemTime::now(),
            },
        );
    }

    let zip_path_str = match zip_join_handle.join() {
        Ok(Ok(zp)) => zp,
        Ok(Err(e)) if e == "LaunchCancelled" => return Err("LaunchCancelled".to_string()),
        Ok(Err(_)) | Err(_) => None,
    };

    emit_progress(&app_handle, 100);

    Ok(ServerStartResult {
        session_id,
        tunnel_address: final_address,
        pid: java_pid,
        zip_path: zip_path_str,
    })
}

#[command]
async fn stop_server(session_id: String) -> Result<(), String> {
    println!("Stopping server for session: {}", session_id);
    
    // Register this session as stopped/cancelled
    {
        let mut stopped = STOPPED_SESSIONS.lock().unwrap();
        stopped.insert(session_id.clone());
    }

    let mut servers = ACTIVE_SERVERS.lock().unwrap();
    if let Some(mut proc) = servers.remove(&session_id) {
        println!("Sending 'stop' command to Java stdin...");
        let mut stdin = proc.java_stdin;
        if let Err(e) = writeln!(stdin, "stop") {
            println!("Failed to write 'stop' command: {}. Forcibly killing Java process.", e);
            let _ = proc.java_child.kill();
        } else {
            let _ = stdin.flush();
            println!("Waiting for Java process to exit gracefully...");
            let timeout = Duration::from_secs(30);
            let start = SystemTime::now();
            let mut exited = false;
            
            while start.elapsed().unwrap_or(Duration::from_secs(0)) < timeout {
                match proc.java_child.try_wait() {
                    Ok(Some(_status)) => {
                        println!("Java process exited gracefully.");
                        exited = true;
                        break;
                    }
                    Ok(None) => {
                        std::thread::sleep(Duration::from_millis(500));
                    }
                    Err(e) => {
                        println!("Error while waiting for Java process: {}. Killing.", e);
                        break;
                    }
                }
            }
            
            if !exited {
                println!("Graceful stop timed out. Forcibly terminating Java process...");
                let _ = proc.java_child.kill();
            }
        }
        
        // Kill SSH tunnel process
        if let Some(mut tunnel) = proc.tunnel_child {
            println!("Terminating SSH Tunnel...");
            let _ = tunnel.kill();
        }
    }
    
    Ok(())
}

#[command]
async fn reset_all_server_data(app_handle: tauri::AppHandle) -> Result<bool, String> {
    println!("Resetting all server data...");
    let app_data = app_handle.path_resolver().app_data_dir()
        .ok_or_else(|| "Failed to resolve app data directory".to_string())?;
    let server_dir = app_data.join("servers");
    // 数GBのサーバーフォルダ削除はUIスレッドを塞ぐため、バックグラウンドで実行する
    tauri::async_runtime::spawn_blocking(move || {
        if server_dir.exists() {
            fs::remove_dir_all(&server_dir)
                .map_err(|e| format!("Failed to delete servers directory: {}", e))?;
        }
        if let Ok(mut cache) = JAR_META_CACHE.lock() {
            cache.clear();
        }
        Ok(true)
    })
    .await
    .map_err(|e| format!("Reset task failed: {}", e))?
}

#[command]
async fn get_server_status(session_id: String) -> Result<ServerStatus, String> {
    let mut servers = ACTIVE_SERVERS.lock().unwrap();
    if let Some(ref mut proc) = servers.get_mut(&session_id) {
        // Check if Java process is still running
        match proc.java_child.try_wait() {
            Ok(None) => {
                let elapsed = proc.started_at.elapsed()
                    .unwrap_or(Duration::from_secs(0))
                    .as_secs();
                
                Ok(ServerStatus {
                    is_running: true,
                    uptime_seconds: elapsed,
                })
            }
            _ => {
                // Java process exited, clean up
                servers.remove(&session_id);
                Ok(ServerStatus {
                    is_running: false,
                    uptime_seconds: 0,
                })
            }
        }
    } else {
        Ok(ServerStatus {
            is_running: false,
            uptime_seconds: 0,
        })
    }
}

#[command]
fn log_to_terminal(message: String) {
    println!("[UI Log] {}", message);
}

// -----------------------------------------------------------------------------
// Sandbox Compatibility Verification, Local .minecraft/mods Sync & TCP Handshake
// -----------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct LocalJarMetadata {
    path: PathBuf,
    filename: String,
    mod_id: String,
    name: String,
    dependencies: Vec<String>,
    provides: Vec<String>,
    client_side_only: bool,
    /// 照合用に事前計算した正規化キー（毎回の文字列正規化コストを削減）
    keys: JarMatchKeys,
}

/// JAR側の照合キー（inspect時に一度だけ計算する）
#[derive(Clone, Debug, Default)]
struct JarMatchKeys {
    filename_lower: String,
    id_key: String,
    name_key: String,
    file_key: String,
    provides_keys: Vec<String>,
}

impl LocalJarMetadata {
    /// 照合用キーを計算して格納する
    fn finalize(mut self) -> Self {
        self.keys = JarMatchKeys {
            filename_lower: self.filename.to_ascii_lowercase(),
            id_key: normalize_mod_key(&self.mod_id),
            name_key: normalize_mod_key(&self.name),
            file_key: normalize_mod_key(&self.filename),
            provides_keys: self.provides.iter().map(|p| normalize_mod_key(p)).collect(),
        };
        self
    }
}

/// プリセットMOD側の照合キー（ループ外で一度だけ計算する）
struct ModMatchKeys {
    expected_fname_lower: String,
    name_key: String,
    provider_key: String,
    url_stem_key: String,
}

fn extract_stem_from_download_url(url: &str) -> Option<String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return None;
    }
    let without_query = trimmed.split('?').next().unwrap_or(trimmed);
    let fname = without_query.rsplit('/').next()?;
    let decoded = fname.replace("%20", " ").replace("%2B", "+");
    let lower = decoded.to_ascii_lowercase();
    if !lower.ends_with(".jar") {
        return None;
    }
    let stem = decoded[..decoded.len() - 4].to_string();
    let base = extract_base_stem_without_version(&stem);
    if base.is_empty() {
        None
    } else {
        Some(base)
    }
}

fn expand_known_mod_alias_keys(norm_key: &str) -> &'static [&'static str] {
    match norm_key {
        "brassamberbattletowers" | "babt" => &["ba_bt", "babt", "brassamberbattletowers"],
        "apothicattributes" | "attributeslib" => &["attributeslib", "apothicattributes"],
        "ironsspells3dcastpreview" | "issponder" => &["ponder", "iss_ponder", "issponder"],
        "curiosapi" | "curios" => &["curios", "curiosapi"],
        "architecturyapi" | "architectury" => &["architectury", "architecturyapi"],
        "clothconfigapi" | "clothconfig" => &["cloth_config", "clothconfig", "clothconfigapi"],
        "p1nerosepicxcataclysm" | "p1neroec" => &["p1nero_ec", "p1neroec"],
        "epicfightdodgeparryreward" | "dodgeparryreward" => &["dodge_parry_reward", "dodgeparryreward"],
        "epicfightswordsoaring" | "swordsoaring" => &["sword_soaring", "swordsoaring"],
        "epicfightavalon" => &["epic_fight_avalon", "epicfightavalon"],
        "epicfightnightfall" | "efn" => &["efn", "epicfightnightfall"],
        _ => &[],
    }
}

impl ModMatchKeys {
    fn from_mod(m: &ModInfo) -> Self {
        let url_stem_key = extract_stem_from_download_url(&m.download_url)
            .map(|s| normalize_mod_key(&s))
            .unwrap_or_default();
        ModMatchKeys {
            expected_fname_lower: sanitize_jar_filename(&m.name).to_ascii_lowercase(),
            name_key: normalize_mod_key(&m.name),
            provider_key: m
                .provider_id
                .as_deref()
                .map(normalize_mod_key)
                .unwrap_or_default(),
            url_stem_key,
        }
    }
}

/// JARメタデータのキャッシュ（パス → (ファイルサイズ, 更新日時, メタデータ)）
/// 2回目以降の診断・同期・起動では、変更のないJARを再展開せずに済む
static JAR_META_CACHE: Lazy<Mutex<HashMap<PathBuf, (u64, Option<SystemTime>, LocalJarMetadata)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// MOD解析の進捗をUIへ通知する（フロントエンドの「解析中」表示用）
fn emit_scan_progress(app_handle: Option<&tauri::AppHandle>, message: &str) {
    if let Some(h) = app_handle {
        let _ = h.emit_all("mod-scan-progress", message.to_string());
    }
}

fn is_known_client_only_mod(mod_id: &str, filename: &str) -> bool {
    let id_norm = normalize_mod_key(mod_id);
    let fname_lower = filename.to_ascii_lowercase();
    let mod_id_lower = mod_id.to_ascii_lowercase();

    // Fast-path substring check for known problematic client-side-only mods
    if mod_id_lower.contains("oculus")
        || mod_id_lower.contains("flywheel compat")
        || mod_id_lower.contains("chatplus")
        || mod_id_lower.contains("createbetterfps")
        || mod_id_lower.contains("embeddium")
        || mod_id_lower.contains("xaero")
        || mod_id_lower.contains("mandala")
        || mod_id_lower.contains("krypton")
        || mod_id_lower.contains("tcrmeshes")
        || fname_lower.contains("oculus")
        || fname_lower.contains("chatplus")
        || fname_lower.contains("createbetterfps")
        || fname_lower.contains("embeddium")
        || fname_lower.contains("xaero")
        || fname_lower.contains("mandala")
        || fname_lower.contains("krypton")
        || fname_lower.contains("tcrmeshes")
    {
        return true;
    }

    let stem = fname_lower
        .trim_end_matches(".jar")
        .split(|c: char| c == '-' || c == '_')
        .next()
        .unwrap_or("");

    let exact_client_ids = [
        "oculus",
        "oculusflywheelcompat",
        "embeddium",
        "rubidium",
        "sodium",
        "sodiumdynamiclights",
        "iris",
        "acceleratedrendering",
        "entityculling",
        "euphoriapatcher",
        "fancytoasts",
        "gnetum",
        "shelmarowhud",
        "chatplus",
        "clearwater",
        "shouldersurfing",
        "shutupglerror",
        "legendarytooltips",
        "jecharacters",
        "smartkeyprompts",
        "itemborders",
        "betterlockon",
        "gputape",
        "highlighter",
        "mousetweaks",
        "nckey",
        "nonconflictkeys",
        "rebindnarrator",
        "travelerstitles",
        "extrasounds",
        "extrasoundsnext",
        "ambientsounds",
        "damageindicator",
        "bettertridentmodel",
        "globalshaderpackproperties",
        "preloadingtricks",
        "tcrmodfilter",
        "cbbg",
        "colorbandingbegone",
        "createbetterfps",
        "xaerominimap",
        "xaeroworldmap",
        "xaerolib",
        "xaero",
        "mandalasgui",
        "mandala",
        "kryptonreno",
        "krypton",
        "tcrmeshes",
        "apexhostingpartnerlink",
        "ashofsincustomantiseatentity",
        "ashofsinnomoreinvalidstatistic",
    ];

    if exact_client_ids.iter().any(|&cid| id_norm == cid || stem == cid) {
        return true;
    }

    let client_filename_prefixes = [
        "oculus-",
        "oculus_",
        "embeddium-",
        "rubidium-",
        "sodiumdynamiclights-",
        "fusion-",
        "acceleratedrendering-",
        "entityculling-",
        "euphoriapatcher-",
        "fancytoasts-",
        "gnetum-",
        "shelmarow_hud-",
        "chatplus-",
        "clear-water-",
        "shouldersurfing-",
        "shut_up_gl_error-",
        "legendarytooltips-",
        "jecharacters-",
        "smartkeyprompts-",
        "itemborders-",
        "betterlockon-",
        "gputape-",
        "highlighter-",
        "mousetweaks-",
        "nonconflictkeys-",
        "rebind_narrator-",
        "travelerstitles-",
        "extrasoundsnext-",
        "ambientsounds_",
        "damageindicator-",
        "better_trident_model-",
        "globalshaderpackproperties-",
        "preloading-tricks-",
        "preloading_tricks-",
        "tcrmodfilter-",
        "cbbg-",
        "cbbg_",
        "colorbandingbegone-",
        "createbetterfps-",
    ];

    client_filename_prefixes
        .iter()
        .any(|prefix| fname_lower.starts_with(prefix))
}

fn clean_duplicate_sanitized_jars_in_dir(dir: &Path) {
    let entries: Vec<PathBuf> = match fs::read_dir(dir) {
        Ok(rd) => rd.flatten().map(|e| e.path()).filter(|p| p.is_file()).collect(),
        Err(_) => return,
    };

    let existing_names: std::collections::HashSet<String> = entries
        .iter()
        .filter_map(|p| p.file_name().map(|s| s.to_string_lossy().to_string()))
        .collect();

    for path in &entries {
        if let Some(orig_name) = path.file_name().map(|s| s.to_string_lossy().to_string()) {
            if !orig_name.to_ascii_lowercase().ends_with(".jar") {
                continue;
            }
            let sanitized = sanitize_jar_filename(&orig_name);
            if sanitized != orig_name && existing_names.contains(&sanitized) {
                let dup_path = dir.join(&sanitized);
                let _ = fs::remove_file(&dup_path);
            }
        }
    }
}

fn get_local_minecraft_mods_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata).join(".minecraft").join("mods");
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("minecraft")
                .join("mods");
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(".minecraft").join("mods");
        }
    }
    PathBuf::from(".minecraft/mods")
}

fn is_builtin_mod_id(mod_id: &str) -> bool {
    let lower = mod_id.to_ascii_lowercase();
    let norm = normalize_mod_key(&lower);
    matches!(
        norm.as_str(),
        "minecraft"
            | "java"
            | "fabricloader"
            | "fabric_loader"
            | "fabric"
            | "quiltloader"
            | "quilt_loader"
            | "forge"
            | "neoforge"
            | "fml"
            | "mixinextras"
            | "asmfabricloader"
            | "spongemixin"
            | "sponge_mixin"
            | "optifine"
    )
}

fn normalize_mod_key(raw: &str) -> String {
    raw.trim()
        .to_ascii_lowercase()
        .trim_start_matches("local-")
        .trim_start_matches("local:")
        .trim_end_matches(".jar")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect()
}

fn extract_base_stem_without_version(stem: &str) -> String {
    let mut parts = Vec::new();
    for seg in stem.split(|c: char| c == '-' || c == '_' || c == '+') {
        if seg.is_empty() {
            continue;
        }
        let first_char = seg.chars().next().unwrap_or(' ');
        if first_char.is_ascii_digit()
            || (seg.starts_with('v') && seg.len() > 1 && seg.chars().nth(1).unwrap_or(' ').is_ascii_digit())
            || (seg.starts_with("mc") && seg.len() > 2 && seg.chars().nth(2).unwrap_or(' ').is_ascii_digit())
        {
            break;
        }
        let lower = seg.to_ascii_lowercase();
        if matches!(lower.as_str(), "forge" | "neoforge" | "fabric" | "quilt" | "all" | "universal") && !parts.is_empty() {
            continue;
        }
        parts.push(lower);
    }
    if parts.is_empty() {
        stem.to_ascii_lowercase()
    } else {
        parts.join("_")
    }
}

fn inspect_jar_metadata(jar_path: &Path) -> Option<LocalJarMetadata> {
    let filename = jar_path.file_name()?.to_string_lossy().to_string();
    if !filename.to_ascii_lowercase().ends_with(".jar") {
        return None;
    }

    let fallback_stem = filename.trim_end_matches(".jar").to_string();
    let derived_stem = extract_base_stem_without_version(&fallback_stem);
    let mut mod_id = derived_stem.clone();
    let mut has_primary_mod_id = false;
    let mut name = fallback_stem.clone();
    let mut dependencies = Vec::new();
    let mut provides = vec![derived_stem, fallback_stem.to_ascii_lowercase()];
    let mut client_side_only = false;

    if let Ok(file) = File::open(jar_path) {
        if let Ok(mut archive) = zip::ZipArchive::new(file) {
            // 1. Check META-INF/mods.toml or META-INF/neoforge.mods.toml
            let mut toml_str = String::new();
            if let Ok(mut entry) = archive.by_name("META-INF/mods.toml") {
                let _ = entry.read_to_string(&mut toml_str);
            }
            if toml_str.is_empty() {
                if let Ok(mut entry) = archive.by_name("META-INF/neoforge.mods.toml") {
                    let _ = entry.read_to_string(&mut toml_str);
                }
            }

            if !toml_str.is_empty() {
                let mut in_mods_block = false;
                let mut in_dep_block = false;
                let mut in_multiline_str = false;
                let mut current_dep_id = String::new();
                let mut current_dep_mandatory = false;
                let mut _current_dep_side = String::from("BOTH");

                for raw_line in toml_str.lines() {
                    let trimmed_raw = raw_line.trim();
                    if trimmed_raw.contains("'''") || trimmed_raw.contains("\"\"\"") {
                        let count_single = trimmed_raw.matches("'''").count();
                        let count_double = trimmed_raw.matches("\"\"\"").count();
                        if (count_single + count_double) % 2 == 1 {
                            in_multiline_str = !in_multiline_str;
                        }
                        continue;
                    }
                    if in_multiline_str {
                        continue;
                    }

                    let line = raw_line.split('#').next().unwrap_or("").trim();
                    if line.is_empty() {
                        continue;
                    }
                    if line.starts_with("[[mods]]") {
                        in_mods_block = true;
                        in_dep_block = false;
                        continue;
                    }
                    if line.starts_with("[[dependencies.") || line.starts_with("[dependencies.") {
                        if in_dep_block && !current_dep_id.is_empty() {
                            if current_dep_mandatory && !is_builtin_mod_id(&current_dep_id) {
                                dependencies.push(current_dep_id.clone());
                            }
                        }
                        in_mods_block = false;
                        in_dep_block = true;
                        current_dep_id.clear();
                        current_dep_mandatory = false;
                        _current_dep_side = String::from("BOTH");
                        continue;
                    }
                    if line.starts_with('[') {
                        in_mods_block = false;
                        in_dep_block = false;
                    }

                    if let Some((k, v)) = line.split_once('=') {
                        let key = k.trim();
                        let val = v.trim().trim_matches('"').trim_matches('\'').trim();
                        if key == "clientSideOnly" && val.eq_ignore_ascii_case("true") {
                            client_side_only = true;
                        }

                        if in_mods_block {
                            if key == "modId" && !val.is_empty() {
                                let id_low = val.to_ascii_lowercase();
                                provides.push(id_low.clone());
                                if !has_primary_mod_id {
                                    mod_id = id_low;
                                    has_primary_mod_id = true;
                                }
                            } else if key == "displayName" && !val.is_empty() && name == fallback_stem {
                                name = val.to_string();
                            }
                        } else if in_dep_block {
                            if key == "modId" {
                                current_dep_id = val.to_ascii_lowercase();
                            } else if key == "side" {
                                _current_dep_side = val.to_ascii_uppercase();
                            } else if key == "mandatory" || key == "type" {
                                let v_low = val.to_ascii_lowercase();
                                if v_low == "true" || v_low == "required" {
                                    current_dep_mandatory = true;
                                } else if v_low == "false"
                                    || v_low == "optional"
                                    || v_low == "discouraged"
                                    || v_low == "incompatible"
                                {
                                    current_dep_mandatory = false;
                                }
                            }
                        }
                    }
                }

                if in_dep_block && !current_dep_id.is_empty() {
                    if current_dep_mandatory && !is_builtin_mod_id(&current_dep_id) {
                        dependencies.push(current_dep_id);
                    }
                }
            }

            // 2. Also check fabric.mod.json (both for pure Fabric mods and dual Forge+Fabric JARs)
            let mut fabric_str = String::new();
            if let Ok(mut entry) = archive.by_name("fabric.mod.json") {
                let _ = entry.read_to_string(&mut fabric_str);
            }
            if !fabric_str.is_empty() {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&fabric_str) {
                    if let Some(id_val) = json.get("id").and_then(|v| v.as_str()) {
                        let id_low = id_val.to_ascii_lowercase();
                        provides.push(id_low.clone());
                        if !has_primary_mod_id {
                            mod_id = id_low;
                            has_primary_mod_id = true;
                        }
                    }
                    if toml_str.is_empty() {
                        if let Some(name_val) = json.get("name").and_then(|v| v.as_str()) {
                            name = name_val.to_string();
                        }
                        if let Some(env_val) = json.get("environment").and_then(|v| v.as_str()) {
                            if env_val.eq_ignore_ascii_case("client") {
                                client_side_only = true;
                            }
                        }
                        if let Some(deps_obj) = json.get("depends").and_then(|v| v.as_object()) {
                            for dep_key in deps_obj.keys() {
                                let dep_lower = dep_key.to_ascii_lowercase();
                                if !is_builtin_mod_id(&dep_lower) {
                                    dependencies.push(dep_lower);
                                }
                            }
                        }
                    }
                    if let Some(prov_arr) = json.get("provides").and_then(|v| v.as_array()) {
                        for p in prov_arr {
                            if let Some(ps) = p.as_str() {
                                provides.push(ps.to_ascii_lowercase());
                            }
                        }
                    }
                    if let Some(jars_arr) = json.get("jars").and_then(|v| v.as_array()) {
                        for j in jars_arr {
                            if let Some(file_str) = j.get("file").and_then(|f| f.as_str()) {
                                let f_low = file_str.to_ascii_lowercase();
                                if let Some(fname) = f_low.split('/').last() {
                                    let stem = fname.trim_end_matches(".jar");
                                    let base = extract_base_stem_without_version(stem);
                                    provides.push(base.clone());
                                    provides.push(base.replace('-', "_"));
                                    provides.push(normalize_mod_key(&base));
                                }
                            }
                        }
                    }
                }
            }

            // 2b. Check META-INF/MANIFEST.MF for Automatic-Module-Name & Specification-Title
            let mut manifest_str = String::new();
            if let Ok(mut entry) = archive.by_name("META-INF/MANIFEST.MF") {
                let _ = entry.read_to_string(&mut manifest_str);
            }
            for mline in manifest_str.lines() {
                if let Some(rest) = mline.strip_prefix("Automatic-Module-Name:") {
                    if let Some(last_seg) = rest.trim().split('.').last() {
                        let clean_seg = last_seg.trim().to_ascii_lowercase();
                        if !clean_seg.is_empty() {
                            provides.push(clean_seg.clone());
                            if !has_primary_mod_id {
                                mod_id = clean_seg;
                                has_primary_mod_id = true;
                            }
                        }
                    }
                } else if let Some(rest) = mline.strip_prefix("Specification-Title:") {
                    let clean_title = rest.trim().to_ascii_lowercase();
                    if !clean_title.is_empty() {
                        provides.push(clean_title);
                    }
                }
            }

            // 3. Check META-INF/jarjar/metadata.json for embedded Jar-in-Jar libraries
            let mut jarjar_str = String::new();
            if let Ok(mut entry) = archive.by_name("META-INF/jarjar/metadata.json") {
                let _ = entry.read_to_string(&mut jarjar_str);
            }
            if !jarjar_str.is_empty() {
                if let Ok(jj) = serde_json::from_str::<serde_json::Value>(&jarjar_str) {
                    if let Some(jars) = jj.get("jars").and_then(|v| v.as_array()) {
                        for j in jars {
                            if let Some(artifact) = j
                                .get("identifier")
                                .and_then(|id| id.get("artifact"))
                                .and_then(|a| a.as_str())
                            {
                                let art_low = artifact.to_ascii_lowercase();
                                provides.push(art_low.clone());
                                provides.push(art_low.replace('-', "_"));
                                // Extract base name (e.g. "Ponder-Forge-1.20.1" -> "ponder")
                                if let Some(base) = art_low.split('-').next() {
                                    if base.len() >= 3 {
                                        provides.push(base.to_string());
                                    }
                                }
                            }
                            if let Some(group) = j
                                .get("identifier")
                                .and_then(|id| id.get("group"))
                                .and_then(|g| g.as_str())
                            {
                                if let Some(last_part) = group.split('.').last() {
                                    if last_part.len() >= 3 {
                                        provides.push(last_part.to_ascii_lowercase());
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if is_known_client_only_mod(&mod_id, &filename) {
        client_side_only = true;
    }

    Some(LocalJarMetadata {
        path: jar_path.to_path_buf(),
        filename,
        mod_id,
        name,
        dependencies,
        provides,
        client_side_only,
        keys: JarMatchKeys::default(),
    }.finalize())
}

/// キャッシュを利用してJARメタデータを取得する（サイズ・更新日時が変わっていなければ再展開しない）
fn inspect_jar_metadata_cached(jar_path: &Path) -> Option<LocalJarMetadata> {
    let fs_meta = fs::metadata(jar_path).ok()?;
    let size = fs_meta.len();
    let mtime = fs_meta.modified().ok();

    if let Ok(cache) = JAR_META_CACHE.lock() {
        if let Some((c_size, c_mtime, c_meta)) = cache.get(jar_path) {
            if *c_size == size && *c_mtime == mtime {
                return Some(c_meta.clone());
            }
        }
    }

    let meta = inspect_jar_metadata(jar_path)?;
    if let Ok(mut cache) = JAR_META_CACHE.lock() {
        cache.insert(jar_path.to_path_buf(), (size, mtime, meta.clone()));
    }
    Some(meta)
}

/// ディレクトリ内のJARを分割（チャンク）して並列に解析する。
/// 200個超のMODでも数スレッドで分けて読み込むため、1スレッドで順番に展開するより大幅に速い。
fn scan_jars_in_dir_with_progress(
    dir: &Path,
    app_handle: Option<&tauri::AppHandle>,
    label: &str,
) -> Vec<LocalJarMetadata> {
    let mut jar_paths: Vec<PathBuf> = match fs::read_dir(dir) {
        Ok(entries) => entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.is_file()
                    && p.extension()
                        .map(|ext| ext.to_string_lossy().eq_ignore_ascii_case("jar"))
                        .unwrap_or(false)
            })
            .collect(),
        Err(_) => return Vec::new(),
    };
    jar_paths.sort();
    if jar_paths.is_empty() {
        return Vec::new();
    }

    let total = jar_paths.len();
    if !label.is_empty() {
        emit_scan_progress(app_handle, &format!("📂 {} を解析中... (0/{}件)", label, total));
    }

    let worker_count = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(2, 8)
        .min(total);
    let chunk_size = (total + worker_count - 1) / worker_count;
    let done_counter = std::sync::atomic::AtomicUsize::new(0);

    let mut results: Vec<LocalJarMetadata> = Vec::with_capacity(total);
    std::thread::scope(|scope| {
        let handles: Vec<_> = jar_paths
            .chunks(chunk_size)
            .map(|chunk| {
                let done_counter = &done_counter;
                scope.spawn(move || {
                    let mut local = Vec::with_capacity(chunk.len());
                    for p in chunk {
                        if let Some(meta) = inspect_jar_metadata_cached(p) {
                            local.push(meta);
                        }
                        let done = done_counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                        // 進捗通知は25件ごとに間引き、UIへのイベント洪水を防ぐ
                        if !label.is_empty() && (done % 25 == 0 || done == total) {
                            emit_scan_progress(
                                app_handle,
                                &format!("📂 {} を解析中... ({}/{}件)", label, done, total),
                            );
                        }
                    }
                    local
                })
            })
            .collect();
        for h in handles {
            if let Ok(mut part) = h.join() {
                results.append(&mut part);
            }
        }
    });
    results
}

#[allow(dead_code)]
fn matches_mod_with_jar(m: &ModInfo, jar: &LocalJarMetadata) -> bool {
    matches_keys_with_jar(&ModMatchKeys::from_mod(m), jar)
}

/// 事前計算済みキーで照合する（ループ内で文字列を再生成しない高速版）
fn matches_keys_with_jar(mk: &ModMatchKeys, jar: &LocalJarMetadata) -> bool {
    let jk = &jar.keys;
    if jk.filename_lower == mk.expected_fname_lower {
        return true;
    }

    if !mk.name_key.is_empty()
        && (mk.name_key == jk.id_key
            || mk.name_key == jk.name_key
            || jk.file_key.starts_with(&mk.name_key))
    {
        return true;
    }

    if !mk.provider_key.is_empty()
        && (mk.provider_key == jk.id_key
            || mk.provider_key == jk.name_key
            || jk.file_key.starts_with(&mk.provider_key)
            || jk.provides_keys.iter().any(|p| *p == mk.provider_key))
    {
        return true;
    }

    if !mk.url_stem_key.is_empty()
        && (mk.url_stem_key == jk.id_key
            || mk.url_stem_key == jk.name_key
            || jk.file_key.starts_with(&mk.url_stem_key)
            || jk.provides_keys.iter().any(|p| *p == mk.url_stem_key))
    {
        return true;
    }

    false
}

fn get_curseforge_instance_mods_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let user_home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok();
    if let Some(home) = user_home {
        let instances_root = PathBuf::from(home)
            .join("curseforge")
            .join("minecraft")
            .join("Instances");
        if let Ok(entries) = fs::read_dir(instances_root) {
            for entry in entries.flatten() {
                let mods_dir = entry.path().join("mods");
                if mods_dir.is_dir() {
                    dirs.push(mods_dir);
                }
            }
        }
    }
    dirs
}

fn build_local_jar_index(extra_dir: Option<&Path>) -> Vec<LocalJarMetadata> {
    build_local_jar_index_with_progress(extra_dir, None)
}

fn build_local_jar_index_with_progress(
    extra_dir: Option<&Path>,
    app_handle: Option<&tauri::AppHandle>,
) -> Vec<LocalJarMetadata> {
    build_local_jar_index_selective(extra_dir, true, app_handle)
}

fn build_local_jar_index_selective(
    extra_dir: Option<&Path>,
    include_curseforge: bool,
    app_handle: Option<&tauri::AppHandle>,
) -> Vec<LocalJarMetadata> {
    let mut index = Vec::new();
    let mut seen_paths = std::collections::HashSet::<PathBuf>::new();

    if let Some(dir) = extra_dir {
        for jar in scan_jars_in_dir_with_progress(dir, app_handle, "サーバー mods") {
            if seen_paths.insert(jar.path.clone()) {
                index.push(jar);
            }
        }
    }

    let local_mods_dir = get_local_minecraft_mods_dir();
    for jar in scan_jars_in_dir_with_progress(&local_mods_dir, app_handle, ".minecraft/mods") {
        if seen_paths.insert(jar.path.clone()) {
            index.push(jar);
        }
    }

    if include_curseforge {
        append_curseforge_jars_to_index(&mut index, app_handle);
    }

    index
}

fn append_curseforge_jars_to_index(
    index: &mut Vec<LocalJarMetadata>,
    app_handle: Option<&tauri::AppHandle>,
) {
    let mut seen_paths: std::collections::HashSet<PathBuf> = index.iter().map(|j| j.path.clone()).collect();
    let cf_dirs = get_curseforge_instance_mods_dirs();
    let cf_total = cf_dirs.len();
    for (i, cf_dir) in cf_dirs.iter().enumerate() {
        let label = format!("CurseForgeインスタンス ({}/{})", i + 1, cf_total);
        for jar in scan_jars_in_dir_with_progress(cf_dir, app_handle, &label) {
            if seen_paths.insert(jar.path.clone()) {
                index.push(jar);
            }
        }
    }
}

fn find_jar_meta_in_index<'a>(m: &ModInfo, index: &'a [LocalJarMetadata]) -> Option<&'a LocalJarMetadata> {
    find_jar_meta_by_keys(&ModMatchKeys::from_mod(m), index)
}

fn find_jar_meta_by_keys<'a>(mk: &ModMatchKeys, index: &'a [LocalJarMetadata]) -> Option<&'a LocalJarMetadata> {
    index.iter().find(|jar| matches_keys_with_jar(mk, jar))
}

fn find_jar_in_index(m: &ModInfo, index: &[LocalJarMetadata]) -> Option<PathBuf> {
    find_jar_meta_in_index(m, index).map(|j| j.path.clone())
}

fn download_mods_parallel(
    app_handle: &tauri::AppHandle,
    session_id: &str,
    tasks: Vec<(ModInfo, PathBuf)>,
    progress_range: Option<(u32, u32)>,
) -> Result<(), String> {
    if tasks.is_empty() {
        return Ok(());
    }

    let total = tasks.len();
    let completed = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let queue = std::sync::Arc::new(std::sync::Mutex::new(std::collections::VecDeque::from(tasks)));
    let http_client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .unwrap_or_else(|_| reqwest::blocking::Client::new());

    let worker_count = total.min(8);
    let mut handles = Vec::with_capacity(worker_count);

    for _ in 0..worker_count {
        let q = queue.clone();
        let comp = completed.clone();
        let canc = cancelled.clone();
        let app = app_handle.clone();
        let sid = session_id.to_string();
        let client = http_client.clone();

        handles.push(thread::spawn(move || {
            loop {
                {
                    let stopped = STOPPED_SESSIONS.lock().unwrap();
                    if stopped.contains(&sid) {
                        canc.store(true, std::sync::atomic::Ordering::SeqCst);
                        break;
                    }
                }
                if canc.load(std::sync::atomic::Ordering::SeqCst) {
                    break;
                }

                let next_task = {
                    let mut guard = q.lock().unwrap();
                    guard.pop_front()
                };
                let (m, target_path) = match next_task {
                    Some(t) => t,
                    None => break,
                };

                log_to_ui(&app, &format!("⚡ [Parallel DL] Downloading mod: {}", m.name));
                match client.get(&m.download_url).send() {
                    Ok(mut res) if res.status().is_success() => {
                        if let Ok(mut file) = File::create(&target_path) {
                            let mut buffer = [0u8; 65536];
                            let mut aborted = false;
                            loop {
                                {
                                    let stopped = STOPPED_SESSIONS.lock().unwrap();
                                    if stopped.contains(&sid) {
                                        aborted = true;
                                        canc.store(true, std::sync::atomic::Ordering::SeqCst);
                                        break;
                                    }
                                }
                                match res.read(&mut buffer) {
                                    Ok(0) => break,
                                    Ok(n) => {
                                        if file.write_all(&buffer[..n]).is_err() {
                                            aborted = true;
                                            break;
                                        }
                                    }
                                    Err(_) => {
                                        aborted = true;
                                        break;
                                    }
                                }
                            }
                            drop(file);
                            if aborted {
                                let _ = fs::remove_file(&target_path);
                                if canc.load(std::sync::atomic::Ordering::SeqCst) {
                                    break;
                                }
                            }
                        }
                    }
                    Err(e) => {
                        log_to_ui(&app, &format!("Warning: failed to download mod {}: {}. Skipping.", m.name, e));
                    }
                    _ => {
                        log_to_ui(&app, &format!("Warning: non-200 status for mod {}. Skipping.", m.name));
                    }
                }

                let done = comp.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                if let Some((start_p, end_p)) = progress_range {
                    let span = end_p.saturating_sub(start_p);
                    let p = start_p + ((done * span as usize) / total.max(1)) as u32;
                    emit_progress(&app, p);
                }
            }
        }));
    }

    for h in handles {
        let _ = h.join();
    }

    if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("LaunchCancelled".to_string());
    }

    Ok(())
}

fn write_varint(buf: &mut Vec<u8>, mut value: i32) {
    loop {
        if (value & !0x7F) == 0 {
            buf.push(value as u8);
            return;
        }
        buf.push(((value & 0x7F) | 0x80) as u8);
        value = ((value as u32) >> 7) as i32;
    }
}

fn read_varint<R: Read>(reader: &mut R) -> Result<i32, String> {
    let mut num_read = 0;
    let mut result = 0i32;
    loop {
        let mut byte = [0u8; 1];
        reader
            .read_exact(&mut byte)
            .map_err(|e| format!("Failed to read VarInt byte: {}", e))?;
        let read = byte[0];
        let value = (read & 0x7F) as i32;
        result |= value << (7 * num_read);
        num_read += 1;
        if num_read > 5 {
            return Err("VarInt is too big".to_string());
        }
        if (read & 0x80) == 0 {
            break;
        }
    }
    Ok(result)
}

fn perform_client_handshake_ping(host: &str, port: u16) -> ClientHandshakeTestResult {
    let start = SystemTime::now();
    let addr_str = format!("{}:{}", host, port);
    let sock_addr: std::net::SocketAddr = match addr_str.parse() {
        Ok(a) => a,
        Err(e) => {
            return ClientHandshakeTestResult {
                reachable: false,
                latency_ms: 0,
                version_name: String::new(),
                protocol: 0,
                online_players: 0,
                max_players: 0,
                message: format!("Invalid socket address {}: {}", addr_str, e),
            };
        }
    };

    let mut stream = match std::net::TcpStream::connect_timeout(&sock_addr, Duration::from_millis(2000)) {
        Ok(s) => s,
        Err(e) => {
            return ClientHandshakeTestResult {
                reachable: false,
                latency_ms: 0,
                version_name: String::new(),
                protocol: 0,
                online_players: 0,
                max_players: 0,
                message: format!("サーバーポート({})へ未接続: {}", addr_str, e),
            };
        }
    };

    let _ = stream.set_read_timeout(Some(Duration::from_millis(2000)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(2000)));

    // Build Minecraft Handshake packet (Packet ID 0x00, NextState = 1 Status)
    let mut handshake_payload = Vec::new();
    write_varint(&mut handshake_payload, 0x00); // Packet ID: Handshake
    write_varint(&mut handshake_payload, 763); // Protocol version (1.20.1 default for status ping)
    let host_bytes = host.as_bytes();
    write_varint(&mut handshake_payload, host_bytes.len() as i32);
    handshake_payload.extend_from_slice(host_bytes);
    handshake_payload.extend_from_slice(&port.to_be_bytes());
    write_varint(&mut handshake_payload, 1); // Next State: 1 (Status)

    let mut packet = Vec::new();
    write_varint(&mut packet, handshake_payload.len() as i32);
    packet.extend_from_slice(&handshake_payload);

    // Append Status Request packet (Length 1, Packet ID 0x00)
    packet.push(0x01);
    packet.push(0x00);

    if stream.write_all(&packet).is_err() {
        let latency = start.elapsed().unwrap_or_default().as_millis() as u64;
        return ClientHandshakeTestResult {
            reachable: true,
            latency_ms: latency,
            version_name: "TCP Connected".to_string(),
            protocol: 0,
            online_players: 0,
            max_players: 0,
            message: "TCPポート開通済み（Statusパケット送信待機中）".to_string(),
        };
    }

    // Read Status Response packet
    if let Ok(_packet_len) = read_varint(&mut stream) {
        if let Ok(packet_id) = read_varint(&mut stream) {
            if packet_id == 0x00 {
                if let Ok(json_len) = read_varint(&mut stream) {
                    if json_len > 0 && json_len < 1_048_576 {
                        let mut json_buf = vec![0u8; json_len as usize];
                        if stream.read_exact(&mut json_buf).is_ok() {
                            let latency = start.elapsed().unwrap_or_default().as_millis() as u64;
                            if let Ok(status_json) = serde_json::from_slice::<serde_json::Value>(&json_buf) {
                                let version_name = status_json
                                    .get("version")
                                    .and_then(|v| v.get("name"))
                                    .and_then(|n| n.as_str())
                                    .unwrap_or("Unknown")
                                    .to_string();
                                let protocol = status_json
                                    .get("version")
                                    .and_then(|v| v.get("protocol"))
                                    .and_then(|p| p.as_i64())
                                    .unwrap_or(0);
                                let online_players = status_json
                                    .get("players")
                                    .and_then(|p| p.get("online"))
                                    .and_then(|o| o.as_i64())
                                    .unwrap_or(0);
                                let max_players = status_json
                                    .get("players")
                                    .and_then(|p| p.get("max"))
                                    .and_then(|m| m.as_i64())
                                    .unwrap_or(0);

                                return ClientHandshakeTestResult {
                                    reachable: true,
                                    latency_ms: latency,
                                    version_name: version_name.clone(),
                                    protocol,
                                    online_players,
                                    max_players,
                                    message: format!(
                                        "クライアント入室疎通テスト合格（応答 {}ms / Server: {} / Players: {}/{}）",
                                        latency, version_name, online_players, max_players
                                    ),
                                };
                            }
                        }
                    }
                }
            }
        }
    }

    let latency = start.elapsed().unwrap_or_default().as_millis() as u64;
    ClientHandshakeTestResult {
        reachable: true,
        latency_ms: latency,
        version_name: "Minecraft Server".to_string(),
        protocol: 0,
        online_players: 0,
        max_players: 0,
        message: format!("TCPポート疎通成功（応答 {}ms）", latency),
    }
}

#[command]
async fn test_minecraft_client_handshake(host: Option<String>, port: Option<u16>) -> Result<ClientHandshakeTestResult, String> {
    let h = host.unwrap_or_else(|| "127.0.0.1".to_string());
    let p = port.unwrap_or(25565);
    tauri::async_runtime::spawn_blocking(move || perform_client_handshake_ping(&h, p))
        .await
        .map_err(|e| format!("Handshake task failed: {}", e))
}

/// Tauri v1 では async でないコマンドはメインスレッド（UIスレッド）で実行されるため、
/// 重いJAR解析を同期コマンドで行うとウィンドウが「応答なし」になる。
/// そのため async コマンド + spawn_blocking でバックグラウンドスレッドに逃がす。
#[command]
async fn verify_client_and_server_sandbox(
    app_handle: tauri::AppHandle,
    mc_version: String,
    loader: String,
    preset_mods: Vec<ModInfo>,
) -> Result<SandboxCompatibilityReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        verify_client_and_server_sandbox_blocking(app_handle, mc_version, loader, preset_mods)
    })
    .await
    .map_err(|e| format!("Sandbox verification task failed: {}", e))?
}

fn verify_client_and_server_sandbox_blocking(
    app_handle: tauri::AppHandle,
    mc_version: String,
    loader: String,
    preset_mods: Vec<ModInfo>,
) -> Result<SandboxCompatibilityReport, String> {
    let scan_started = SystemTime::now();
    emit_scan_progress(Some(&app_handle), &format!("🔍 MOD構成を解析しています... ({}件)", preset_mods.len()));

    let local_mods_dir = get_local_minecraft_mods_dir();
    clean_duplicate_sanitized_jars_in_dir(&local_mods_dir);

    let server_mods_dir = app_handle
        .path_resolver()
        .app_data_dir()
        .map(|d| d.join("servers").join(&mc_version).join(&loader).join("mods"))
        .unwrap_or_else(|| PathBuf::from("servers/mods"));
    clean_duplicate_sanitized_jars_in_dir(&server_mods_dir);

    // 各ディレクトリは1回だけ（並列・キャッシュ付きで）解析し、.minecraft/mods とサーバー mods の一覧はインデックスから切り出す
    // 高速化：モーダル表示時はローカル（サーバーmods & .minecraft/mods）のみを高速解析（CurseForge全インスタンスの重いスキャンを省きUIフリーズを完全防止）
    let all_local_index = build_local_jar_index_selective(Some(&server_mods_dir), false, Some(&app_handle));
    let local_jars: Vec<&LocalJarMetadata> = all_local_index
        .iter()
        .filter(|j| j.path.parent() == Some(local_mods_dir.as_path()))
        .collect();
    let server_jars: Vec<&LocalJarMetadata> = all_local_index
        .iter()
        .filter(|j| j.path.parent() == Some(server_mods_dir.as_path()))
        .collect();

    emit_scan_progress(Some(&app_handle), "🧪 前提MODの依存関係を照合しています...");

    // プリセットMODごとの照合キーを一度だけ計算
    let mod_keys: Vec<ModMatchKeys> = preset_mods.iter().map(ModMatchKeys::from_mod).collect();

    // Track provided mod IDs separately for Server side and Client side to detect side-specific shortages in the ZIP
    let mut server_provided_ids = std::collections::HashSet::<String>::new();
    let mut client_provided_ids = std::collections::HashSet::<String>::new();
    for b in [
        "minecraft",
        "java",
        "fabricloader",
        "fabric_loader",
        "fabric-loader",
        "asmfabricloader",
        "asm_fabric_loader",
        "quilt_loader",
        "quilt-loader",
        "forge",
        "neoforge",
        "fml",
        "mixinextras",
        "spongemixin",
        "optifine",
    ] {
        server_provided_ids.insert(b.to_string());
        client_provided_ids.insert(b.to_string());
    }

    for m in &preset_mods {
        let is_srv = m.is_server_side != Some(0);
        let is_cli = m.is_client_side != Some(0);
        let norm_name = normalize_mod_key(&m.name);
        let mut keys = vec![norm_name.clone()];
        for alias in expand_known_mod_alias_keys(&norm_name) {
            keys.push((*alias).to_string());
        }
        if let Some(stem) = extract_stem_from_download_url(&m.download_url) {
            let norm_stem = normalize_mod_key(&stem);
            keys.push(stem);
            keys.push(norm_stem.clone());
            for alias in expand_known_mod_alias_keys(&norm_stem) {
                keys.push((*alias).to_string());
            }
        }
        if let Some(ref pid) = m.provider_id {
            let clean = pid
                .trim()
                .to_ascii_lowercase()
                .trim_start_matches("local-")
                .trim_start_matches("local:")
                .to_string();
            let norm_clean = normalize_mod_key(&clean);
            keys.push(clean.clone());
            keys.push(norm_clean.clone());
            for alias in expand_known_mod_alias_keys(&norm_clean) {
                keys.push((*alias).to_string());
            }
            if clean == "fabric-api" || m.name.to_ascii_lowercase().contains("fabric api") {
                keys.push("fabric-api".to_string());
                keys.push("fabric".to_string());
                keys.push("fabricapi".to_string());
            }
        }
        for k in keys {
            if is_srv {
                server_provided_ids.insert(k.clone());
            }
            if is_cli {
                client_provided_ids.insert(k);
            }
        }
    }

    for jar in &all_local_index {
        for (pm, pk) in preset_mods.iter().zip(mod_keys.iter()) {
            if matches_keys_with_jar(pk, jar) {
                let is_srv = pm.is_server_side != Some(0) && !jar.client_side_only;
                let is_cli = pm.is_client_side != Some(0);
                let mut jar_keys = vec![
                    jar.mod_id.to_ascii_lowercase(),
                    normalize_mod_key(&jar.mod_id),
                ];
                for p in &jar.provides {
                    jar_keys.push(p.to_ascii_lowercase());
                    jar_keys.push(normalize_mod_key(p));
                }
                for jk in jar_keys {
                    if is_srv {
                        server_provided_ids.insert(jk.clone());
                    }
                    if is_cli {
                        client_provided_ids.insert(jk);
                    }
                }
            }
        }
    }

    let mut required_client_mods = Vec::new();
    let mut unresolved_mods = Vec::new();
    let mut has_unresolved_server_mods = false;
    let mut missing_prerequisites = Vec::new();
    let mut seen_missing = std::collections::HashSet::<String>::new();

    for (m, mk) in preset_mods.iter().zip(mod_keys.iter()) {
        let matched_jar = find_jar_meta_by_keys(mk, &all_local_index);
        let jar_is_client_only = matched_jar.map(|j| j.client_side_only).unwrap_or(false)
            || is_known_client_only_mod(&m.name, &sanitize_jar_filename(&m.name));

        let is_server = m.is_server_side != Some(0) && !jar_is_client_only;
        let is_client = m.is_client_side != Some(0);
        let side = if is_server && is_client {
            "both".to_string()
        } else if is_client {
            "client".to_string()
        } else {
            "server".to_string()
        };

        let has_download_url = !m.download_url.trim().is_empty();
        let installed_in_local_client = local_jars.iter().any(|j| matches_keys_with_jar(mk, j));
        let installed_in_server_dir = server_jars.iter().any(|j| matches_keys_with_jar(mk, j));
        let installed_in_any_local = matched_jar.is_some();
        let can_auto_supply = has_download_url || installed_in_any_local;

        if !can_auto_supply {
            unresolved_mods.push(m.name.clone());
            if is_server {
                has_unresolved_server_mods = true;
            }
        }

        if is_client {
            required_client_mods.push(ClientRequiredModStatus {
                name: m.name.clone(),
                provider_id: m.provider_id.clone().unwrap_or_default(),
                side,
                has_download_url,
                installed_in_local_client,
                installed_in_server_dir,
                can_auto_supply,
            });
        }

        if let Some(jar) = matched_jar {
            for dep in &jar.dependencies {
                let dep_norm = normalize_mod_key(dep);
                let dep_is_client_only = is_known_client_only_mod(dep, dep);

                let missing_on_server = is_server
                    && !dep_is_client_only
                    && !server_provided_ids.contains(dep)
                    && !server_provided_ids.contains(&dep_norm);
                let missing_on_client = is_client
                    && !client_provided_ids.contains(dep)
                    && !client_provided_ids.contains(&dep_norm);

                if missing_on_server || missing_on_client {
                    let scope = if missing_on_server && missing_on_client {
                        "both"
                    } else if missing_on_server {
                        "server"
                    } else {
                        "client"
                    };
                    let key = format!("{}:{}", dep_norm, scope);
                    if seen_missing.insert(key) {
                        let local_dep_jar = all_local_index.iter().find(|j| {
                            j.keys.id_key == dep_norm
                                || j.keys.provides_keys.iter().any(|p| *p == dep_norm)
                        });
                        missing_prerequisites.push(MissingPrerequisiteMod {
                            mod_id: dep.clone(),
                            required_by: m.name.clone(),
                            scope: scope.to_string(),
                            available_locally: local_dep_jar.is_some(),
                            local_jar_name: local_dep_jar.map(|j| j.filename.clone()),
                        });
                    }
                }
            }
        }
    }

    // Fabric preset heuristic: if loader is fabric and there are mods, check if fabric-api is present
    if loader.eq_ignore_ascii_case("fabric")
        && !preset_mods.is_empty()
        && !server_provided_ids.contains("fabric-api")
        && !server_provided_ids.contains("fabricapi")
    {
        missing_prerequisites.push(MissingPrerequisiteMod {
            mod_id: "fabric-api".to_string(),
            required_by: "Fabric MOD群 (共通前提API)".to_string(),
            scope: "both".to_string(),
            available_locally: false,
            local_jar_name: None,
        });
    }

    let zip_insufficient = !missing_prerequisites.is_empty() || !unresolved_mods.is_empty();
    let server_ready = !has_unresolved_server_mods
        && !missing_prerequisites.iter().any(|mp| mp.scope == "server" || mp.scope == "both");
    let client_join_ready = required_client_mods.iter().all(|cm| cm.installed_in_local_client)
        && !missing_prerequisites.iter().any(|mp| mp.scope == "client" || mp.scope == "both");

    let confirmation_prompt = if zip_insufficient {
        let mut lines = Vec::new();
        lines.push("⚠️ 【注意】ZIPファイル内のMOD構成だけでは、サーバー側またはクライアント側で必要な以下のMODが不足しています：".to_string());
        for mp in &missing_prerequisites {
            let side_label = match mp.scope.as_str() {
                "server" => "サーバー側で必須",
                "client" => "クライアント側で必須",
                _ => "サーバー・クライアント双方で必須",
            };
            let source_hint = if let Some(ref fname) = mp.local_jar_name {
                format!("ローカル検出済: {}", fname)
            } else {
                "Modrinth/CurseForgeから自動取得".to_string()
            };
            lines.push(format!(
                "  ・{} （要求元MOD: {} ／ {} ／ {}）",
                mp.mod_id, mp.required_by, side_label, source_hint
            ));
        }
        for u in &unresolved_mods {
            let is_cli_only = is_known_client_only_mod(u, u);
            if is_cli_only {
                lines.push(format!("  ・{} （クライアント専用・本体JAR未解決）", u));
            } else {
                lines.push(format!("  ・{} （本体JAR・DLリンク未解決）", u));
            }
        }
        lines.push("\nこのMODが足りないため、プリセット構成に入れてもかまいませんか？".to_string());
        Some(lines.join("\n"))
    } else {
        None
    };

    let summary_message = if server_ready && client_join_ready {
        "✅ サーバー起動準備・クライアント入室互換テストともに合格です！そのままサーバーを起動して入室できます。".to_string()
    } else if zip_insufficient {
        format!(
            "⚠️ このZIPファイルのMOD構成だけでは、前提MOD（{}件）または実体未解決MOD（{}件）が不足しています。下の注意文をご確認のうえ、構成への追加・補完を実行してください。",
            missing_prerequisites.len(),
            unresolved_mods.len()
        )
    } else {
        "💡 サーバー起動準備は完了しています。このPCのマイクラでサーバーに入るには「このPCの .minecraft/mods に必要MODを一括同期」を実行してください。".to_string()
    };

    let elapsed_ms = scan_started.elapsed().map(|d| d.as_millis()).unwrap_or(0);
    emit_scan_progress(
        Some(&app_handle),
        &format!("✅ MOD解析完了 ({}件のJARを照合 / {}ms)", all_local_index.len(), elapsed_ms),
    );

    Ok(SandboxCompatibilityReport {
        server_ready,
        client_join_ready,
        local_mods_dir: local_mods_dir.to_string_lossy().to_string(),
        local_installed_count: required_client_mods
            .iter()
            .filter(|m| m.installed_in_local_client)
            .count(),
        required_client_mods,
        missing_prerequisites,
        unresolved_mods,
        summary_message,
        zip_insufficient,
        confirmation_prompt,
    })
}

#[command]
async fn sync_client_mods_to_local_minecraft(
    app_handle: tauri::AppHandle,
    mc_version: String,
    loader: String,
    client_mods: Vec<ModInfo>,
) -> Result<SyncClientModsResult, String> {
    // JARのコピー・ダウンロードはUIスレッドを塞がないようバックグラウンドで実行する
    tauri::async_runtime::spawn_blocking(move || {
        sync_client_mods_to_local_minecraft_blocking(app_handle, mc_version, loader, client_mods)
    })
    .await
    .map_err(|e| format!("Local mod sync task failed: {}", e))?
}

fn sync_client_mods_to_local_minecraft_blocking(
    app_handle: tauri::AppHandle,
    mc_version: String,
    loader: String,
    client_mods: Vec<ModInfo>,
) -> Result<SyncClientModsResult, String> {
    let local_mods_dir = get_local_minecraft_mods_dir();
    fs::create_dir_all(&local_mods_dir)
        .map_err(|e| format!("Failed to create local .minecraft/mods directory: {}", e))?;

    // First repair any extensionless valid ZIP/JAR files in local_mods_dir so they can be matched before staging
    if let Ok(entries) = fs::read_dir(&local_mods_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() {
                let len = entry.metadata().map(|m| m.len()).unwrap_or(0);
                if len == 0 {
                    let _ = fs::remove_file(&p);
                    continue;
                }
                let fname = p.file_name().unwrap_or_default().to_string_lossy().to_string();
                if !fname.to_ascii_lowercase().ends_with(".jar") && !fname.to_ascii_lowercase().ends_with(".disabled") {
                    let with_jar = local_mods_dir.join(format!("{}.jar", fname));
                    if !with_jar.exists() {
                        if let Ok(f) = File::open(&p) {
                            if zip::ZipArchive::new(f).is_ok() {
                                let _ = fs::rename(&p, &with_jar);
                            }
                        }
                    }
                }
            }
        }
    }

    let server_mods_dir = app_handle
        .path_resolver()
        .app_data_dir()
        .map(|d| d.join("servers").join(&mc_version).join(&loader).join("mods"));

    // Stage all target client mods into a temporary folder first, then wipe .minecraft/mods completely and move staged files in
    let staging_dir = local_mods_dir
        .parent()
        .unwrap_or(&local_mods_dir)
        .join(".msiaas_client_mods_staging");
    if staging_dir.exists() {
        let _ = fs::remove_dir_all(&staging_dir);
    }
    fs::create_dir_all(&staging_dir)
        .map_err(|e| format!("Failed to create staging directory: {}", e))?;

    let combined_index = build_local_jar_index_with_progress(server_mods_dir.as_deref(), Some(&app_handle));
    let existing_local_jars: Vec<&LocalJarMetadata> = combined_index
        .iter()
        .filter(|j| j.path.parent() == Some(local_mods_dir.as_path()))
        .collect();
    let mut synced_count = 0usize;
    let mut already_present_count = 0usize;
    let mut failed_mods = Vec::new();
    let mut mods_to_download: Vec<(ModInfo, PathBuf)> = Vec::new();

    for m in client_mods {
        if m.is_client_side == Some(0) {
            continue;
        }
        let mk = ModMatchKeys::from_mod(&m);

        let target_fname = sanitize_jar_filename(&m.name);
        let staged_target = staging_dir.join(&target_fname);
        if staged_target.exists() {
            continue;
        }

        // 1. Check if already present in local .minecraft/mods (copy to staging preserving original filename so CoreMods keep their exact name)
        if let Some(local_match) = existing_local_jars.iter().find(|j| matches_keys_with_jar(&mk, j)) {
            let orig_staged = staging_dir.join(&local_match.filename);
            if orig_staged.exists() || fs::copy(&local_match.path, &orig_staged).is_ok() {
                already_present_count += 1;
                continue;
            }
        }

        // 2. Check server_mods_dir or CurseForge instances via pre-built O(1) index (preserving original filename)
        if let Some(found_jar) = find_jar_meta_by_keys(&mk, &combined_index).map(|j| j.path.clone()) {
            let orig_fname = found_jar
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| target_fname.clone());
            let orig_staged = staging_dir.join(&orig_fname);
            if orig_staged.exists() || fs::copy(&found_jar, &orig_staged).is_ok() {
                synced_count += 1;
                continue;
            }
        }

        // 3. Queue for parallel download from download_url
        if m.download_url.trim().is_empty() {
            failed_mods.push(m.name.clone());
            continue;
        }

        mods_to_download.push((m, staged_target));
    }

    if !mods_to_download.is_empty() {
        let dl_snapshot = mods_to_download.clone();
        let _ = download_mods_parallel(&app_handle, "local-sync", mods_to_download, None);
        for (m, target_path) in dl_snapshot {
            if target_path.is_file() {
                synced_count += 1;
            } else {
                failed_mods.push(m.name);
            }
        }
    }

    // Delete ALL existing files in .minecraft/mods before copying the staged mods in
    if let Ok(entries) = fs::read_dir(&local_mods_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() {
                let _ = fs::remove_file(&p);
            } else if p.is_dir() {
                let _ = fs::remove_dir_all(&p);
            }
        }
    }

    // Move/copy all staged .jar files into the clean .minecraft/mods directory
    if let Ok(staged_entries) = fs::read_dir(&staging_dir) {
        for entry in staged_entries.flatten() {
            let src = entry.path();
            if src.is_file() {
                if let Some(fname) = src.file_name() {
                    let dst = local_mods_dir.join(fname);
                    if fs::rename(&src, &dst).is_err() {
                        let _ = fs::copy(&src, &dst);
                    }
                }
            }
        }
    }
    let _ = fs::remove_dir_all(&staging_dir);

    Ok(SyncClientModsResult {
        synced_count,
        already_present_count,
        failed_mods,
        target_dir: local_mods_dir.to_string_lossy().to_string(),
    })
}

// -----------------------------------------------------------------------------
// Application Entrypoint & Automatic Local API Server Management
// -----------------------------------------------------------------------------

fn resolve_api_directory() -> Option<PathBuf> {
    let mut candidate_roots: Vec<PathBuf> = Vec::new();

    if let Ok(exe_path) = std::env::current_exe() {
        let mut cur = exe_path.parent().map(|p| p.to_path_buf());
        while let Some(dir) = cur {
            candidate_roots.push(dir.clone());
            cur = dir.parent().map(|p| p.to_path_buf());
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        let mut cur = Some(cwd);
        while let Some(dir) = cur {
            candidate_roots.push(dir.clone());
            cur = dir.parent().map(|p| p.to_path_buf());
        }
    }

    // Fallback to compile-time workspace path so installed/moved .exe on the same machine also works
    let compile_time_api = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../api");
    if compile_time_api.join("wrangler.toml").exists() {
        candidate_roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."));
    }

    for root in candidate_roots {
        let api_dir = root.join("apps").join("api");
        if api_dir.join("wrangler.toml").exists() {
            return Some(api_dir);
        }
        if root.join("wrangler.toml").exists() && root.ends_with("api") {
            return Some(root);
        }
    }

    None
}

fn ensure_local_api_server_running() {
    if let Ok(addr) = "127.0.0.1:8787".parse() {
        if std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok() {
            println!("[AutoAPI] Local API server is already running on 127.0.0.1:8787.");
            return;
        }
    }

    let api_dir = match resolve_api_directory() {
        Some(dir) => dir,
        None => {
            println!("[AutoAPI] Could not locate apps/api directory; skipping auto-launch.");
            return;
        }
    };

    println!("[AutoAPI] Starting local API server from {:?}...", api_dir);

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("cmd.exe");
        c.args(["/C", "npx wrangler dev --port 8787 --show-interactive-dev-session false"]);
        c.creation_flags(0x08000000); // CREATE_NO_WINDOW
        c
    };

    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = Command::new("sh");
        c.args(["-c", "npx wrangler dev --port 8787 --show-interactive-dev-session false"]);
        c
    };

    cmd.current_dir(&api_dir)
        .env("CI", "true")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    match cmd.spawn() {
        Ok(child) => {
            println!("[AutoAPI] Spawned background API server (PID: {}).", child.id());
            let mut guard = API_SERVER_CHILD.lock().unwrap();
            *guard = Some(child);
        }
        Err(e) => {
            println!("[AutoAPI] Failed to spawn background API server: {}", e);
        }
    }
}

fn stop_local_api_server() {
    let mut guard = API_SERVER_CHILD.lock().unwrap();
    if let Some(mut child) = guard.take() {
        let pid = child.id();
        println!("[AutoAPI] Stopping background API server (PID: {})...", pid);
        #[cfg(target_os = "windows")]
        {
            let mut kill_cmd = Command::new("taskkill");
            kill_cmd.args(["/F", "/T", "/PID", &pid.to_string()]);
            kill_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            let _ = kill_cmd.status();
        }
        let _ = child.kill();
    }
}

#[cfg(test)]
fn main() {}

#[cfg(not(test))]
fn main() {
  tauri::Builder::default()
      .setup(|_app| {
          ensure_local_api_server_running();
          Ok(())
      })
      .invoke_handler(tauri::generate_handler![
          check_java_available,
          start_server,
          stop_server,
          get_server_status,
          log_to_terminal,
          get_system_memory,
          check_zombie_processes,
          kill_zombie_process,
          send_server_command,
          reset_all_server_data,
          verify_client_and_server_sandbox,
          sync_client_mods_to_local_minecraft,
          test_minecraft_client_handshake
      ])
      .on_window_event(|event| {
          // Cleanup all processes on application exit to prevent zombie processes
          if let tauri::WindowEvent::Destroyed = event.event() {
              println!("Tauri window destroyed, cleaning up active servers and background API...");
              stop_local_api_server();
              let mut servers = ACTIVE_SERVERS.lock().unwrap();
              for (session_id, mut proc) in servers.drain() {
                  println!("Sending 'stop' to java process on exit for session: {}...", session_id);
                  let mut stdin = proc.java_stdin;
                  let mut exited = false;
                  if writeln!(stdin, "stop").is_ok() {
                      let _ = stdin.flush();
                      let timeout = Duration::from_secs(5);
                      let start = SystemTime::now();
                      while start.elapsed().unwrap_or(Duration::from_secs(0)) < timeout {
                          if let Ok(Some(_)) = proc.java_child.try_wait() {
                              println!("Java process exited gracefully on application exit.");
                              exited = true;
                              break;
                          }
                          std::thread::sleep(Duration::from_millis(200));
                      }
                  }
                  if !exited {
                      println!("Graceful stop timed out or failed on exit. Killing Java process forcibly.");
                      let _ = proc.java_child.kill();
                  }
                  
                  if let Some(mut t_child) = proc.tunnel_child {
                      let _ = t_child.kill();
                  }
              }
          }
      })
      .run(tauri::generate_context!())
      .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_analyze_minecraft_crash_logs_java_version() {
        let logs = vec![
            "Error: A JNI error has occurred, please check your installation and try again".to_string(),
            "Exception in thread \"main\" java.lang.UnsupportedClassVersionError: net/minecraft/bundler/Main has been compiled by a more recent version of the Java Runtime (class file version 61.0), this version of the Java Runtime only recognizes class file versions up to 52.0".to_string()
        ];
        let err = analyze_minecraft_crash_logs(&logs, 1);
        assert!(err.contains("Javaのバージョン不適合です"));
    }

    #[test]
    fn test_analyze_minecraft_crash_logs_client_only() {
        let logs = vec![
            "Exception in thread \"main\" java.lang.NoClassDefFoundError: net/minecraft/client/Minecraft".to_string()
        ];
        let err = analyze_minecraft_crash_logs(&logs, 1);
        assert!(err.contains("クライアント専用MODの混入"));
    }

    #[test]
    fn test_analyze_minecraft_crash_logs_fabric_dependency() {
        let logs = vec![
            "net.fabricmc.loader.impl.discovery.ModResolutionException: Some of your mods are incompatible with the game version or other mods!".to_string(),
            " - Mod 'sodium' (0.5.0) requires version 1.20.1 of mod 'minecraft', which is missing!".to_string()
        ];
        let err = analyze_minecraft_crash_logs(&logs, 1);
        assert!(err.contains("Fabric/Quilt MODの依存関係エラー"));
        assert!(err.contains("sodium"));
    }

    #[test]
    fn test_sanitize_jar_filename() {
        assert_eq!(sanitize_jar_filename("Fabric API"), "Fabric_API.jar");
        assert_eq!(sanitize_jar_filename("sodium-fabric-0.5.8.jar"), "sodium-fabric-0.5.8.jar");
    }

    #[test]
    fn test_should_include_mod_on_server() {
        let server_mod = ModInfo {
            id: None,
            name: "Lithium".to_string(),
            provider_id: Some("lithium".to_string()),
            download_url: "https://example.com/lithium.jar".to_string(),
            is_server_side: Some(1),
            is_client_side: Some(1),
        };
        let client_only_mod = ModInfo {
            id: None,
            name: "Sodium".to_string(),
            provider_id: Some("sodium".to_string()),
            download_url: "https://example.com/sodium.jar".to_string(),
            is_server_side: Some(0),
            is_client_side: Some(1),
        };

        assert!(should_include_mod_on_server(&server_mod, &None));
        assert!(!should_include_mod_on_server(&client_only_mod, &None));

        let approved = Some(vec!["Lithium".to_string()]);
        assert!(should_include_mod_on_server(&server_mod, &approved));
        assert!(!should_include_mod_on_server(&client_only_mod, &approved));
    }

    #[test]
    fn test_normalize_mod_key_and_matching() {
        let m = ModInfo {
            id: None,
            name: "Fabric API".to_string(),
            provider_id: Some("local-fabric-api".to_string()),
            download_url: String::new(),
            is_server_side: Some(1),
            is_client_side: Some(1),
        };
        let jar = LocalJarMetadata {
            path: PathBuf::from("fabric-api-0.92.2+1.20.1.jar"),
            filename: "fabric-api-0.92.2+1.20.1.jar".to_string(),
            mod_id: "fabric-api".to_string(),
            name: "Fabric API".to_string(),
            dependencies: vec![],
            provides: vec!["fabric".to_string()],
            client_side_only: false,
            keys: JarMatchKeys::default(),
        }.finalize();
        assert!(matches_mod_with_jar(&m, &jar));
        assert!(is_known_client_only_mod("oculus", "oculus-mc1.20.1-1.8.0.jar"));
        assert!(is_known_client_only_mod("chatplus", "chatplus-forge-2.7.0.jar"));
        assert!(is_known_client_only_mod("createbetterfps", "createbetterfps-1.20.1-1.1.1.jar"));
        assert!(!is_known_client_only_mod("supplementaries", "supplementaries-1.20-3.1.41.jar"));
        assert!(is_known_client_only_mod("preloading_tricks", "preloading-tricks-3.3.1.jar"));
        assert!(!is_known_client_only_mod("epicskills", "epicskills-1.20.1.jar"));
    }
}
