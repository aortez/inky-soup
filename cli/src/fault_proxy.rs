use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{path::Path, process::Command};

pub fn run(
    device: &str,
    bind: &str,
    port: u16,
    fault_file: &Path,
    audit_file: &Path,
) -> Result<Value> {
    let status = Command::new("python3")
        .arg("-u")
        .arg("-c")
        .arg(include_str!("../../app/tools/frame-fault-proxy.py"))
        .args([
            "--upstream",
            device,
            "--bind",
            bind,
            "--port",
            &port.to_string(),
        ])
        .arg("--fault-file")
        .arg(fault_file)
        .arg("--audit-file")
        .arg(audit_file)
        .status()
        .context("Could not start the diagnostic proxy; Python 3 is required on this host")?;
    if !status.success() {
        bail!("Diagnostic proxy exited with {status}");
    }
    Ok(json!({"stopped": true}))
}
