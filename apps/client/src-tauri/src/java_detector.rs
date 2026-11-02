use std::path::Path;
use std::process::Command;
use std::fs;
use serde::Serialize;

#[derive(Serialize)]
pub struct JavaInfo {
    pub available: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

struct JavaCandidate {
    version: String,
    major: u32,
    path: String,
}

fn run_java_version(java_exe: &Path) -> Option<String> {
    let mut cmd = Command::new(java_exe);
    cmd.arg("-version");
    
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    
    let output = cmd.output().ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}\n{}", stdout, stderr);
    
    parse_java_version_str(&combined)
}

fn parse_java_version_str(output: &str) -> Option<String> {
    for line in output.lines() {
        if line.contains("version") {
            let parts: Vec<&str> = line.split_whitespace().collect();
            for (i, &part) in parts.iter().enumerate() {
                if part == "version" && i + 1 < parts.len() {
                    return Some(parts[i+1].replace("\"", ""));
                }
            }
        }
    }
    None
}

fn parse_major_version(version_str: &str) -> u32 {
    let first_part = version_str.split('.').next().unwrap_or("0");
    let major: u32 = first_part.parse().unwrap_or(0);
    if major == 1 {
        version_str.split('.').nth(1).and_then(|s| s.parse().ok()).unwrap_or(0)
    } else {
        major
    }
}

/// 複数の java.exe を `-version` 付きで起動して調べるため数秒かかることがある。
/// Tauri v1 の同期コマンドはUIスレッドで実行されるため、async + spawn_blocking で実行する。
#[tauri::command]
pub async fn check_java_available() -> Result<JavaInfo, String> {
    tauri::async_runtime::spawn_blocking(check_java_available_blocking)
        .await
        .map_err(|e| format!("Java detection task failed: {}", e))?
}

pub fn check_java_available_blocking() -> Result<JavaInfo, String> {
    let mut candidates: Vec<JavaCandidate> = Vec::new();
    let mut seen_paths: std::collections::HashSet<String> = std::collections::HashSet::new();

    let mut try_add = |java_path: &Path| {
        let key = java_path.to_string_lossy().to_lowercase();
        if seen_paths.contains(&key) { return; }
        if java_path.exists() {
            if let Some(version) = run_java_version(java_path) {
                let major = parse_major_version(&version);
                seen_paths.insert(key);
                candidates.push(JavaCandidate {
                    version,
                    major,
                    path: java_path.to_string_lossy().to_string(),
                });
            }
        }
    };

    if let Ok(java_home) = std::env::var("JAVA_HOME") {
        let path = Path::new(&java_home).join("bin").join("java.exe");
        try_add(&path);
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = Command::new("where");
        cmd.arg("java");
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        if let Ok(output) = cmd.output() {
            if output.status.success() {
                let paths = String::from_utf8_lossy(&output.stdout);
                for line in paths.lines() {
                    let p = Path::new(line.trim());
                    try_add(p);
                }
            }
        }
    }

    let common_paths = vec![
        r"C:\Program Files\Eclipse Adoptium",
        r"C:\Program Files\Java",
        r"C:\Program Files\Microsoft",
    ];

    for base_path in common_paths {
        let path = Path::new(base_path);
        if path.exists() {
            if let Ok(entries) = fs::read_dir(path) {
                for entry in entries.flatten() {
                    let java_path = entry.path().join("bin").join("java.exe");
                    try_add(&java_path);
                }
            }
        }
    }

    if candidates.is_empty() {
        return Ok(JavaInfo {
            available: false,
            version: None,
            path: None,
        });
    }

    candidates.sort_by(|a, b| b.major.cmp(&a.major));

    let best = &candidates[0];
    println!("[Java Detection] Found {} candidate(s). Selected: Java {} (major {}) at {}",
        candidates.len(), best.version, best.major, best.path);

    Ok(JavaInfo {
        available: true,
        version: Some(best.version.clone()),
        path: Some(best.path.clone()),
    })
}
