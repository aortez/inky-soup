#![cfg(unix)]

use serde_json::Value;
use std::{fs, os::unix::fs::PermissionsExt, process::Command};

#[test]
fn setup_configures_an_older_image_without_http_or_an_installed_helper() {
    let root = std::env::temp_dir().join(format!("inky-display-test-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let ssh = root.join("ssh");
    fs::write(
        &ssh,
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$INKY_TEST_ARGS\"\nwhile [ \"$1\" != python3 ]; do shift; done\nshift\nexec python3 \"$@\" --output \"$INKY_TEST_CONFIG\"\n",
    )
    .unwrap();
    fs::set_permissions(&ssh, fs::Permissions::from_mode(0o755)).unwrap();
    let path = std::env::join_paths(
        std::iter::once(root.clone())
            .chain(std::env::split_paths(&std::env::var_os("PATH").unwrap())),
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_inky-cli"))
        .args([
            "--device",
            "http://smaller-frame.local:8000",
            "--json",
            "display-setup",
            "impression-5.7",
        ])
        .env("PATH", &path)
        .env("INKY_TEST_CONFIG", root.join("display.conf"))
        .env("INKY_TEST_ARGS", root.join("args"))
        .output()
        .unwrap();
    assert!(output.status.success(), "{:?}", output);
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["display"]["model"], "impression-5.7");
    assert_eq!(result["display"]["width"], 600);
    assert_eq!(result["display"]["height"], 448);
    assert!(fs::read_to_string(root.join("display.conf"))
        .unwrap()
        .contains("DISPLAY_MODEL=impression-5.7"));
    assert!(fs::read_to_string(root.join("args"))
        .unwrap()
        .contains("inky@smaller-frame.local\nsudo\n-n\npython3\n-\n--model\nimpression-5.7"));

    // A rejected SSH request must return a machine-readable error, not success.
    fs::write(
        &ssh,
        "#!/bin/sh\ncat >/dev/null\necho 'Permission denied' >&2\nexit 1\n",
    )
    .unwrap();
    let failed = Command::new(env!("CARGO_BIN_EXE_inky-cli"))
        .args(["--json", "display-setup", "impression-5.7"])
        .env("PATH", path)
        .output()
        .unwrap();
    assert!(!failed.status.success());
    let result: Value = serde_json::from_slice(&failed.stdout).unwrap();
    assert!(result["error"]
        .as_str()
        .unwrap()
        .contains("Permission denied"));
    fs::remove_dir_all(root).unwrap();
}
