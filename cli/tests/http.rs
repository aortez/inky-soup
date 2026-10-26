use serde_json::Value;
use std::{
    io::{Read, Write},
    net::TcpListener,
    process::Command,
    thread,
};

fn serve(replies: Vec<&'static str>) -> (String, thread::JoinHandle<Vec<String>>) {
    serve_responses(replies.into_iter().map(|reply| format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", reply.len(), reply)).collect())
}

fn serve_responses(replies: Vec<String>) -> (String, thread::JoinHandle<Vec<String>>) {
    serve_handler(replies.len(), move |_, index| replies[index].clone())
}

fn serve_handler<F>(count: usize, mut reply: F) -> (String, thread::JoinHandle<Vec<String>>)
where
    F: FnMut(&str, usize) -> String + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let task = thread::spawn(move || {
        let mut requests = Vec::new();
        for index in 0..count {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            let headers = String::from_utf8(request.clone()).unwrap();
            if let Some(length) = headers.lines().find_map(|line| {
                let (key, value) = line.split_once(':')?;
                if key.eq_ignore_ascii_case("content-length") {
                    value.trim().parse::<usize>().ok()
                } else {
                    None
                }
            }) {
                let mut body = vec![0; length];
                stream.read_exact(&mut body).unwrap();
                request.extend(body);
            }
            let request = String::from_utf8_lossy(&request).into_owned();
            let response = reply(&request, index);
            requests.push(request);
            stream.write_all(response.as_bytes()).unwrap();
        }
        requests
    });
    (address, task)
}

#[test]
fn status_is_one_json_document_with_display_and_queue() {
    let (url, server) = serve(vec![
        r#"{"width":1600,"height":1200}"#,
        r#"{"current_job":null,"queue":[]}"#,
    ]);
    let output = Command::new(env!("CARGO_BIN_EXE_inky-cli"))
        .args(["--device", &url, "--json", "status"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["display"]["width"], 1600);
    let requests = server.join().unwrap();
    assert!(requests[0].starts_with("GET /api/display-config "));
    assert!(requests[1].starts_with("GET /api/flash/status "));
}

#[test]
fn orientation_uses_the_current_revision_and_rejects_invalid_degrees() {
    let (url, server) = serve(vec![
        r#"{"rotation_degrees":0,"rotation_revision":12}"#,
        r#"{"success":true,"rotation_degrees":90,"rotation_revision":13}"#,
    ]);
    let output = Command::new(env!("CARGO_BIN_EXE_inky-cli"))
        .args(["--device", &url, "--json", "orientation", "90"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let requests = server.join().unwrap();
    assert!(requests[1].starts_with("POST /api/settings/display-rotation "));
    let body: Value = serde_json::from_str(requests[1].split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(
        body,
        serde_json::json!({"rotation_degrees":90,"expected_revision":12})
    );
    let invalid = Command::new(env!("CARGO_BIN_EXE_inky-cli"))
        .args(["orientation", "45"])
        .output()
        .unwrap();
    assert!(!invalid.status.success());
}

#[test]
fn failed_display_job_returns_nonzero_and_machine_readable_error() {
    let (url, server) = serve(vec![
        r#"{"job_id":7,"filename":"test.png","created_at":12,"status":"Failed","error_message":"Panel timed out"}"#,
    ]);
    let output = Command::new(env!("CARGO_BIN_EXE_inky-cli"))
        .args(["--device", &url, "--json", "job", "7", "--wait"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(result["error"]
        .as_str()
        .unwrap()
        .contains("Panel timed out"));
    assert_eq!(server.join().unwrap().len(), 1);
}

#[test]
fn completed_job_does_not_resubmit_a_flash() {
    let (url, server) = serve(vec![
        r#"{"job_id":7,"filename":"test.png","created_at":12,"status":"Completed"}"#,
    ]);
    let output = Command::new(env!("CARGO_BIN_EXE_inky-cli"))
        .args(["--device", &url, "--json", "job", "7", "--wait"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].starts_with("GET /api/flash/status/7 "));
}

#[test]
fn original_upload_preserves_multipart_file_name_and_content_type() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let task = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let mut headers = Vec::new();
        let mut byte = [0];
        while !headers.ends_with(b"\r\n\r\n") {
            stream.read_exact(&mut byte).unwrap();
            headers.push(byte[0]);
        }
        let headers = String::from_utf8(headers).unwrap();
        let size: usize = headers
            .lines()
            .find_map(|line| {
                line.to_ascii_lowercase()
                    .strip_prefix("content-length: ")
                    .map(str::to_owned)
            })
            .unwrap()
            .parse()
            .unwrap();
        let mut body = vec![0; size];
        stream.read_exact(&mut body).unwrap();
        let body = String::from_utf8_lossy(&body);
        assert!(body
            .to_ascii_lowercase()
            .contains("content-type: image/png"));
        let filename = body
            .split("filename=\"")
            .nth(1)
            .unwrap()
            .split('"')
            .next()
            .unwrap();
        let reply = serde_json::json!({"success":true,"filename":filename}).to_string();
        write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",reply.len(),reply).unwrap();
    });
    let path = std::env::temp_dir().join(format!("inky-cli-{}.png", uuid::Uuid::new_v4()));
    std::fs::write(&path, b"test fixture").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_inky-cli"))
        .args(["--device", &address, "--json", "upload"])
        .arg(&path)
        .output()
        .unwrap();
    std::fs::remove_file(path).unwrap();
    task.join().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
}

#[test]
fn wait_timeout_bounds_a_stalled_status_request() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (_stream, _) = listener.accept().unwrap();
        thread::sleep(std::time::Duration::from_secs(3));
    });
    let start = std::time::Instant::now();
    let output = Command::new(env!("CARGO_BIN_EXE_inky-cli"))
        .args([
            "--device",
            &address,
            "--json",
            "job",
            "7",
            "--wait",
            "--timeout",
            "1",
        ])
        .output()
        .unwrap();
    let elapsed = start.elapsed();
    server.join().unwrap();
    assert!(!output.status.success());
    assert!(
        elapsed < std::time::Duration::from_millis(2500),
        "wait exceeded its deadline: {elapsed:?}"
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(result["error"]
        .as_str()
        .unwrap()
        .contains("Timed out waiting for job 7"));
}

#[test]
fn browser_check_requires_origin_method_and_content_type_permission() {
    for grant_headers in [true, false] {
        let read = "HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: https://allan.pizza\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_string();
        let headers = if grant_headers {
            "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\n"
        } else {
            ""
        };
        let preflight = format!("HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: https://allan.pizza\r\n{headers}Connection: close\r\n\r\n");
        let (address, server) = serve_responses(vec![read, preflight]);
        let output = Command::new(env!("CARGO_BIN_EXE_inky-cli"))
            .args(["--device", &address, "--json", "browser-check"])
            .output()
            .unwrap();
        assert_eq!(output.status.success(), grant_headers);
        let requests = server.join().unwrap();
        assert!(requests[0].starts_with("GET /api/display-config "));
        assert!(requests[1].starts_with("OPTIONS /api/lock-image "));
        assert!(requests[1]
            .to_ascii_lowercase()
            .contains("access-control-request-headers: content-type"));
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        if grant_headers {
            assert_eq!(result["allowed"], true);
        } else {
            assert!(result["error"].as_str().unwrap().contains("not allowed"));
        }
    }
}

#[test]
fn delete_acquires_edit_access_and_releases_it_after_server_refusal() {
    let lock = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 15\r\nConnection: close\r\n\r\n{\"locked\":true}".to_string();
    let refused = r#"{"success":false,"message":"Photo is queued"}"#;
    let rejection = format!("HTTP/1.1 409 Conflict\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", refused.len(), refused);
    let unlock = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 16\r\nConnection: close\r\n\r\n{\"success\":true}".to_string();
    let (address, server) = serve_responses(vec![lock, rejection, unlock]);
    let output = Command::new(env!("CARGO_BIN_EXE_inky-cli"))
        .args(["--device", &address, "--json", "delete", "photo.png"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(result["error"]
        .as_str()
        .unwrap()
        .contains("Photo is queued"));
    let requests = server.join().unwrap();
    assert!(requests[0].starts_with("POST /api/lock-image "));
    assert!(requests[1].starts_with("POST /api/delete-image "));
    assert!(requests[2].starts_with("POST /api/unlock-image "));
}

#[test]
fn preview_start_refuses_to_restart_a_flashing_frame() {
    let (address, server) = serve(vec![
        r#"{"current_job":{"status":"Flashing"},"queue_length":0}"#,
    ]);
    let output = Command::new(env!("CARGO_BIN_EXE_inky-cli"))
        .args(["--device", &address, "--json", "preview", "start"])
        .env("PATH", "/nonexistent")
        .output()
        .unwrap();
    assert!(!output.status.success());
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(result["error"]
        .as_str()
        .unwrap()
        .contains("Wait for queued display jobs"));
    assert_eq!(server.join().unwrap().len(), 1);
}

#[cfg(unix)]
#[test]
fn preview_stop_can_restore_the_service_when_the_preview_api_is_down() {
    use std::{fs, os::unix::fs::PermissionsExt};
    let root = std::env::temp_dir().join(format!("inky-preview-test-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let ssh = root.join("ssh");
    fs::write(&ssh, "#!/bin/sh\ncat >/dev/null\nprintf 'active\\n'\n").unwrap();
    fs::set_permissions(&ssh, fs::Permissions::from_mode(0o755)).unwrap();
    let (address, server) = serve_responses(vec![
        "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
    ]);
    let path = std::env::join_paths(
        std::iter::once(root.clone())
            .chain(std::env::split_paths(&std::env::var_os("PATH").unwrap())),
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_inky-cli"))
        .args(["--device", &address, "--json", "preview", "stop"])
        .env("PATH", path)
        .output()
        .unwrap();
    fs::remove_dir_all(root).unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["ok"], true);
    assert_eq!(server.join().unwrap().len(), 1);
}

#[test]
fn photo_rotation_acquires_ownership_and_uses_saved_revision() {
    let (url, server) = serve(vec![
        r#"{"locked":true}"#,
        r#"[{"filename":"photo.jpg","photo_rotation_degrees":90,"photo_rotation_revision":7}]"#,
        r#"{"success":true,"photo_rotation_degrees":270,"photo_rotation_revision":8,"needs_processing":true}"#,
        r#"{"unlocked":true}"#,
    ]);
    let output = Command::new(env!("CARGO_BIN_EXE_inky-cli"))
        .args(["--device", &url, "--json", "rotate", "photo.jpg", "270"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let requests = server.join().unwrap();
    assert!(requests[0].starts_with("POST /api/lock-image "));
    assert!(requests[2].starts_with("POST /api/settings/photo-rotation "));
    let body: Value = serde_json::from_str(requests[2].split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(body["expected_revision"], 7);
    assert_eq!(body["photo_rotation_degrees"], 270);
    assert!(requests[3].starts_with("POST /api/unlock-image "));
    assert!(!Command::new(env!("CARGO_BIN_EXE_inky-cli"))
        .args(["rotate", "photo.jpg", "45"])
        .output()
        .unwrap()
        .status
        .success());
    assert!(!Command::new(env!("CARGO_BIN_EXE_inky-cli"))
        .args(["upload", "photo.png", "--prepared", "--rotate", "90"])
        .output()
        .unwrap()
        .status
        .success());
}

#[test]
fn orientation_card_queues_once_without_uploading_a_gallery_original() {
    let (url, server) = serve(vec![
        r#"{"model":"impression-5.7","width":448,"height":600,"rotation_degrees":90,"rotation_revision":12,"orientation_test_supported":true}"#,
        r#"{"success":true,"job_id":7}"#,
        r#"{"job_id":7,"filename":"orientation-test-card.png","created_at":12,"status":"Completed"}"#,
    ]);
    let output = Command::new(env!("CARGO_BIN_EXE_inky-cli"))
        .args(["--device", &url, "--json", "orientation-test", "--wait"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 3);
    assert!(requests[1].starts_with("POST /api/flash-test-card "));
    assert!(requests[1].contains("name=\"rotation_revision\"\r\n\r\n12"));
    assert!(requests[1].contains("filename=\"orientation-test-card.png\""));
    assert!(requests[2].starts_with("GET /api/flash/status/7 "));
}

#[test]
fn upload_with_rotation_renews_an_expired_lease_and_respects_takeover() {
    for taken_over in [false, true] {
        let count = if taken_over { 5 } else { 6 };
        let mut renewed = false;
        let (url, server) = serve_handler(count, move |request, index| {
            let mut status = "200 OK";
            let body = match index {
                0 => r#"{"photo_rotation_supported":true}"#.to_string(),
                1 => r#"{"locked":true}"#.to_string(),
                2 => {
                    // Simulate expiration during upload without a wall-clock sleep.
                    renewed = false;
                    let filename = request
                        .split("filename=\"")
                        .nth(1)
                        .unwrap()
                        .split('"')
                        .next()
                        .unwrap();
                    serde_json::json!({"success":true,"filename":filename}).to_string()
                }
                _ if request.starts_with("POST /api/lock-image ") => {
                    renewed = !taken_over;
                    serde_json::json!({"locked":renewed,"reason":"Another editor took over"})
                        .to_string()
                }
                _ if request.starts_with("POST /api/settings/photo-rotation ") => {
                    if renewed {
                        r#"{"success":true,"photo_rotation_degrees":90,"photo_rotation_revision":1,"needs_processing":true}"#.to_string()
                    } else {
                        status = "403 Forbidden";
                        r#"{"success":false,"message":"Edit lease expired"}"#.to_string()
                    }
                }
                _ => r#"{"unlocked":true}"#.to_string(),
            };
            format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body)
        });
        let path = std::env::temp_dir().join(format!(
            "inky-photo-rotation-{}-{taken_over}.jpg",
            std::process::id()
        ));
        std::fs::write(&path, b"unaltered original photo bytes").unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_inky-cli"))
            .args([
                "--device",
                &url,
                "--json",
                "upload",
                path.to_str().unwrap(),
                "--rotate",
                "90",
            ])
            .output()
            .unwrap();
        std::fs::remove_file(path).unwrap();
        assert_eq!(
            output.status.success(),
            !taken_over,
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        let requests = server.join().unwrap();
        assert!(requests[2].contains("unaltered original photo bytes"));
        assert!(requests[3].starts_with("POST /api/lock-image "));
        let owner: Value =
            serde_json::from_str(requests[1].split("\r\n\r\n").nth(1).unwrap()).unwrap();
        let renewal: Value =
            serde_json::from_str(requests[3].split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(renewal, owner);
        if taken_over {
            assert!(!requests
                .iter()
                .any(|r| r.starts_with("POST /api/settings/photo-rotation ")));
            assert!(String::from_utf8_lossy(&output.stdout)
                .contains(owner["filename"].as_str().unwrap()));
        } else {
            assert!(requests[4].starts_with("POST /api/settings/photo-rotation "));
            let body: Value =
                serde_json::from_str(requests[4].split("\r\n\r\n").nth(1).unwrap()).unwrap();
            assert_eq!(body["photo_rotation_degrees"], 90);
            assert_eq!(body["expected_revision"], 0);
            assert_eq!(body["session_id"], owner["session_id"]);
            assert_eq!(body["filename"], owner["filename"]);
        }
        assert!(requests
            .last()
            .unwrap()
            .starts_with("POST /api/unlock-image "));
    }
}

#[test]
fn favorites_use_edit_ownership_and_unlock_after_failure() {
    let (url, server) = serve(vec![
        r#"{"locked":true}"#,
        r#"{"success":false,"message":"Cannot persist metadata"}"#,
        r#"{"success":true}"#,
    ]);
    let output = Command::new(env!("CARGO_BIN_EXE_inky-cli"))
        .args(["--device", &url, "--json", "favorite", "photo.jpg", "on"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    let requests = server.join().unwrap();
    assert!(requests[0].starts_with("POST /api/lock-image "));
    assert!(requests[1].starts_with("POST /api/settings/favorite "));
    assert!(requests[2].starts_with("POST /api/unlock-image "));
    let body: Value = serde_json::from_str(requests[1].split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(body["filename"], "photo.jpg");
    assert_eq!(body["favorite"], true);
    assert!(body["session_id"].as_str().unwrap().len() > 10);
    assert!(requests[0].contains(body["session_id"].as_str().unwrap()));
    assert!(requests[2].contains(body["session_id"].as_str().unwrap()));
}

#[test]
fn slideshow_commands_patch_only_requested_settings_and_enforce_hours() {
    for (args, expected) in [
        (
            vec!["slideshow", "start", "--hours", "6"],
            serde_json::json!({"rotation_enabled":true,"rotation_interval_hours":6}),
        ),
        (
            vec!["slideshow", "start"],
            serde_json::json!({"rotation_enabled":true}),
        ),
        (
            vec!["slideshow", "stop"],
            serde_json::json!({"rotation_enabled":false}),
        ),
        (
            vec!["slideshow", "interval", "168"],
            serde_json::json!({"rotation_interval_hours":168}),
        ),
    ] {
        let (url, server) = serve(vec![r#"{"success":true}"#]);
        let output = Command::new(env!("CARGO_BIN_EXE_inky-cli"))
            .args(["--device", &url, "--json"])
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let requests = server.join().unwrap();
        assert!(requests[0].starts_with("POST /api/settings/slideshow "));
        let body: Value =
            serde_json::from_str(requests[0].split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body, expected);
    }
    for hours in ["0", "169", "1.5", "-1"] {
        let output = Command::new(env!("CARGO_BIN_EXE_inky-cli"))
            .args(["slideshow", "interval", hours])
            .output()
            .unwrap();
        assert!(!output.status.success());
    }
    let (url, server) = serve(vec![r#"{"paused_reason":"editing","next_due_at":123}"#]);
    let output = Command::new(env!("CARGO_BIN_EXE_inky-cli"))
        .args(["--device", &url, "--json", "slideshow"])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap()["paused_reason"],
        "editing"
    );
    assert!(server.join().unwrap()[0].starts_with("GET /api/slideshow "));
}

#[test]
fn favorites_filter_gallery_and_reject_unsupported_servers() {
    for (reply, success) in [
        (
            r#"[{"filename":"a","favorite":false},{"filename":"b","favorite":true}]"#,
            true,
        ),
        (r#"[{"filename":"a"}]"#, false),
    ] {
        let (url, server) = serve(vec![reply]);
        let output = Command::new(env!("CARGO_BIN_EXE_inky-cli"))
            .args(["--device", &url, "--json", "favorites"])
            .output()
            .unwrap();
        assert_eq!(output.status.success(), success);
        if success {
            let result: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(result.as_array().unwrap().len(), 1);
            assert_eq!(result[0]["filename"], "b");
        }
        assert!(server.join().unwrap()[0].starts_with("GET /api/images "));
    }
}
