use serde_json::Value;
use std::{
    io::{Read, Write},
    net::TcpListener,
    process::Command,
    thread,
};

fn serve(replies: Vec<&'static str>) -> (String, thread::JoinHandle<Vec<String>>) {
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
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", reply.len(),reply).unwrap();
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
