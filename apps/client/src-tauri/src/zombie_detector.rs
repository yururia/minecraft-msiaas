use std::process::Command;
use serde::Serialize;

#[derive(Serialize)]
pub struct ZombieInfo {
    pub port_in_use: bool,
    pub pid: Option<u32>,
}

#[tauri::command]
pub async fn check_zombie_processes() -> Result<ZombieInfo, String> {
    // netstat 実行はUIスレッドを塞ぐため、バックグラウンドで実行する
    tauri::async_runtime::spawn_blocking(check_zombie_processes_blocking)
        .await
        .map_err(|e| format!("Zombie check task failed: {}", e))?
}

fn check_zombie_processes_blocking() -> Result<ZombieInfo, String> {
    // ポート 25565 がすでに使用されているか判定
    let port_in_use = std::net::TcpListener::bind("127.0.0.1:25565").is_err();
    
    if !port_in_use {
        return Ok(ZombieInfo {
            port_in_use: false,
            pid: None,
        });
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = Command::new("cmd");
        cmd.args(&["/C", "netstat -ano | findstr :25565"]);
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        
        if let Ok(output) = cmd.output() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 5 {
                    if parts[1].ends_with(":25565") {
                        if let Ok(pid) = parts[parts.len() - 1].parse::<u32>() {
                            if pid != std::process::id() {
                                return Ok(ZombieInfo {
                                    port_in_use: true,
                                    pid: Some(pid),
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(ZombieInfo {
        port_in_use: true,
        pid: None,
    })
}

#[tauri::command]
pub async fn kill_zombie_process(pid: u32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || kill_zombie_process_blocking(pid))
        .await
        .map_err(|e| format!("Kill task failed: {}", e))?
}

fn kill_zombie_process_blocking(pid: u32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        println!("Forcibly terminating zombie process with PID: {}", pid);
        use std::os::windows::process::CommandExt;
        let mut cmd = Command::new("taskkill");
        cmd.args(&["/F", "/PID", &pid.to_string()]);
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        
        let status = cmd.status()
            .map_err(|e| format!("Failed to run taskkill: {}", e))?;
        
        if status.success() {
            Ok(())
        } else {
            Err("Failed to terminate zombie process via taskkill".to_string())
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Zombie process termination is only supported on Windows".to_string())
    }
}
