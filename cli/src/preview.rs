use anyhow::{bail, Context, Result};
use reqwest::Url;
use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};

use crate::SetupAction;

const DROP_IN: &str = "/run/systemd/system/inky-soup-server.service.d/90-inky-cli-preview.conf";

fn start_script(origin: &str, binary: &str) -> Result<String> {
    let url = Url::parse(origin).context("Use a complete HTTP(S) preview origin")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("Use a preview origin without credentials, path, query, or fragment");
    }
    let origin = url.origin().ascii_serialization();
    // These values enter both shell and systemd syntax. Limit them to literal
    // origin/path characters; systemd specifiers and shell expansion are excluded.
    if !origin
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || b":/.[]-_".contains(&c))
        || !binary.starts_with('/')
        || !binary
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"/._-".contains(&c))
    {
        bail!("Preview origin or absolute server path contains unsupported characters");
    }
    Ok(format!(
        r#"set -eu
test -x '{binary}'
mkdir -p /run/inky-soup-preview /run/systemd/system/inky-soup-server.service.d
cp '{binary}' /run/inky-soup-preview/server.next
chmod 755 /run/inky-soup-preview/server.next
mv /run/inky-soup-preview/server.next /run/inky-soup-preview/server
cat > '{DROP_IN}.next' <<'PREVIEW_CONFIG'
[Service]
ExecStart=
ExecStart=/run/inky-soup-preview/server
Environment="INKY_SOUP_CLIENT_ORIGINS=https://allan.pizza,{origin}"
PREVIEW_CONFIG
mv '{DROP_IN}.next' '{DROP_IN}'
systemctl daemon-reload
if ! systemctl restart inky-soup-server.service; then
    rm -f '{DROP_IN}'
    systemctl daemon-reload
    systemctl restart inky-soup-server.service
    exit 1
fi
systemctl is-active inky-soup-server.service
"#
    ))
}

pub fn run(
    host: &str,
    user: &str,
    action: SetupAction,
    origin: &str,
    binary: &str,
) -> Result<Value> {
    if user.is_empty()
        || !user
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
    {
        bail!("SSH user must contain only letters, digits, underscores, or hyphens");
    }
    let script = match action {
        SetupAction::Start => start_script(origin, binary)?,
        SetupAction::Stop => format!(
            "set -eu\nrm -f '{DROP_IN}'\nsystemctl daemon-reload\nsystemctl restart inky-soup-server.service\nsystemctl is-active inky-soup-server.service\n"
        ),
        SetupAction::Status => format!(
            "if test -f '{DROP_IN}'; then cat '{DROP_IN}'; else echo 'Preview disabled'; fi\nsystemctl is-active inky-soup-server.service\n"
        ),
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
            "sh",
            "-s",
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
            "Preview command failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(json!({"ok":true,"detail":String::from_utf8_lossy(&output.stdout).trim()}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_config_rejects_shell_and_systemd_expansion() {
        for binary in [
            "relative/server",
            "/tmp/server\nExecStart=/evil",
            "/tmp/$(id)",
            "/tmp/%u",
            "/tmp/a'b",
        ] {
            assert!(start_script("http://localhost:4175", binary).is_err());
        }
        for origin in [
            "https://user:password@localhost",
            "https://localhost/path",
            "https://localhost/?x=1",
            "http://%25u",
            "file:///tmp/site",
        ] {
            assert!(start_script(origin, "/tmp/server").is_err());
        }
        let script = start_script("http://localhost:4175", "/tmp/server").unwrap();
        assert!(
            script.contains("INKY_SOUP_CLIENT_ORIGINS=https://allan.pizza,http://localhost:4175")
        );
        assert!(script
            .contains("/run/systemd/system/inky-soup-server.service.d/90-inky-cli-preview.conf"));
    }
}
