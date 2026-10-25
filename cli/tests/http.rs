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
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let task = thread::spawn(move || {
        let mut requests = Vec::new();
        for reply in replies {
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
            requests.push(String::from_utf8(request).unwrap());
            stream.write_all(reply.as_bytes()).unwrap();
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
