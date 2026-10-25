use anyhow::{bail, Context, Result};
use serde_json::Value;

pub fn run(host: &str, user: &str, bundle: &str) -> Result<Value> {
    if !bundle.starts_with('/')
        || !bundle
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"/._-".contains(&c))
    {
        bail!("Use an absolute remote bundle path with letters, digits, slashes, dots, underscores, or hyphens");
    }
    let script = format!(
        "{}\nprint(json.dumps(deploy('{bundle}')))\n",
        include_str!("deploy.py")
    );
    let output = crate::ssh::run_script(host, user, "python3", &script)?;
    serde_json::from_str(&output).context("Deployment returned invalid JSON")
}

#[cfg(test)]
mod tests {
    #[test]
    fn deployment_recovery_and_preservation() {
        let output = std::process::Command::new("python3")
            .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/test_deploy.py"))
            .output()
            .expect("Python 3 is required for deployment tests");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn remote_bundle_paths_reject_code_injection() {
        for path in ["relative", "/tmp/a'b", "/tmp/$(id)", "/tmp/a\nb"] {
            assert!(super::run("unused", "inky", path).is_err());
        }
    }
}
