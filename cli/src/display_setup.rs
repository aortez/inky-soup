use anyhow::{bail, Context, Result};
use clap::ValueEnum;
use serde_json::Value;
use std::io::Write;
use std::process::{Command, Stdio};

// Send the helper over stdin so setup also works on images built before it was packaged.
const CONFIGURE: &str = include_str!(
    "../../yocto/meta-inky-soup/recipes-inky-soup/inky-soup-display/files/configure-display.py"
);

#[derive(Clone, Copy, ValueEnum)]
pub enum DisplayModel {
    Auto,
    #[value(name = "impression-5.7")]
    Impression57,
    #[value(name = "impression-13.3-2025")]
    Impression133,
}

pub fn run(host: &str, user: &str, model: DisplayModel) -> Result<Value> {
    if user.is_empty()
        || !user
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
    {
        bail!("SSH user must contain only letters, digits, underscores, or hyphens");
    }
    let model = match model {
        DisplayModel::Auto => "auto",
        DisplayModel::Impression57 => "impression-5.7",
        DisplayModel::Impression133 => "impression-13.3-2025",
    };
    let target = format!("{user}@{}", host.trim_matches(['[', ']']));
    let mut child = Command::new("ssh")
        .args([
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=5",
            "-o",
            "ServerAliveInterval=5",
            "-o",
            "ServerAliveCountMax=2",
            "--",
            &target,
            "sudo",
            "-n",
            "python3",
            "-",
            "--model",
            model,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("Could not run ssh; configure key access to the frame")?;
    child
        .stdin
        .take()
        .context("SSH stdin unavailable")?
        .write_all(CONFIGURE.as_bytes())?;
    let output = child.wait_with_output()?;
    let result = serde_json::from_slice::<Value>(&output.stdout);
    if !output.status.success() {
        bail!(
            "Display setup failed: {}",
            result
                .as_ref()
                .ok()
                .and_then(|value| value["error"].as_str())
                .unwrap_or_else(|| std::str::from_utf8(&output.stderr).unwrap_or("SSH failed"))
                .trim()
        );
    }
    let result = result.context("Display setup returned invalid JSON")?;
    if result["ok"] != true {
        bail!("Display setup failed: {result}");
    }
    Ok(result)
}
