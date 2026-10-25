use anyhow::{bail, Context, Result};
use std::io::Write;
use std::process::{Command, Stdio};

pub fn run_script(host: &str, user: &str, interpreter: &str, script: &str) -> Result<String> {
    if user.is_empty()
        || !user
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
    {
        bail!("SSH user must contain only letters, digits, underscores, or hyphens");
    }
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
            interpreter,
            if interpreter == "sh" { "-s" } else { "-" },
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
        .write_all(script.as_bytes())?;
    let output = child.wait_with_output()?;
    if !output.status.success() {
        bail!(
            "Device SSH command failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}
