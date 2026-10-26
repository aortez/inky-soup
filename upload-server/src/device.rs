//! Identity belongs to /data, never to an address or an image-baked machine-id.
use rocket::{get, serde::json::Json, State};
use serde::Serialize;
use std::{
    fs,
    io::{self, Read, Write},
    path::Path,
};

#[derive(Serialize)]
pub struct Device {
    pub id: String,
    pub instance_id: String,
    pub name: String,
    pub api_version: u32,
    pub capabilities: Vec<&'static str>,
}

fn random_id() -> io::Result<String> {
    let mut bytes = [0u8; 16];
    fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn read_id(path: &Path) -> io::Result<String> {
    let id = fs::read_to_string(path)?;
    let id = id.trim_end_matches(['\r', '\n']);
    if id.len() != 32
        || !id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid persisted frame identity",
        ));
    }
    Ok(id.to_owned())
}

fn persisted_id(directory: &Path) -> io::Result<String> {
    fs::create_dir_all(directory)?;
    let path = directory.join("device-id");
    match read_id(&path) {
        Ok(id) => return Ok(id),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let id = random_id()?;
    let temporary = directory.join(format!(".device-id-{id}"));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(id.as_bytes())?;
        file.sync_all()?;
        // Publish a complete file without replacing a concurrent initializer's ID.
        match fs::hard_link(&temporary, &path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        fs::File::open(directory)?.sync_all()?;
        read_id(&path)
    })();
    let _ = fs::remove_file(temporary);
    result
}

impl Device {
    pub fn load(directory: &Path) -> io::Result<Self> {
        let mut capabilities = vec!["device-identity-v1", "display-config"];
        // Advertise installed firmware support, even when its setup window is closed.
        if Path::new("/usr/bin/wifi-provisioner").is_file() {
            capabilities.push("improv-ble");
        }
        Ok(Self {
            id: persisted_id(directory)?,
            // Queue IDs are process-local. A reboot or service restart invalidates them.
            instance_id: random_id()?,
            name: fs::read_to_string("/etc/hostname")
                .unwrap_or_else(|_| "Inky frame".into())
                .trim()
                .to_string(),
            api_version: 1,
            capabilities,
        })
    }
}

#[get("/api/device")]
pub fn identity(device: &State<Device>) -> Json<&Device> {
    Json(device.inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identity_survives_restart_but_queue_instance_does_not() {
        let dir = std::env::temp_dir().join(format!("frame-identity-{}", random_id().unwrap()));
        let first = Device::load(&dir).unwrap();
        let second = Device::load(&dir).unwrap();
        assert_eq!(first.id, second.id);
        assert_ne!(first.instance_id, second.instance_id);
        let other = Device::load(&dir.join("other")).unwrap();
        assert_ne!(first.id, other.id);
        fs::write(dir.join("device-id"), "broken").unwrap();
        assert!(Device::load(&dir).is_err());
        assert_eq!(fs::read_to_string(dir.join("device-id")).unwrap(), "broken");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn restored_identity_accepts_line_endings_without_changing_the_file() {
        let dir = std::env::temp_dir().join(format!("frame-identity-{}", random_id().unwrap()));
        let id = persisted_id(&dir).unwrap();
        let path = dir.join("device-id");
        for suffix in ["", "\n", "\r\n"] {
            let restored = format!("{id}{suffix}");
            fs::write(&path, &restored).unwrap();
            assert_eq!(persisted_id(&dir).unwrap(), id);
            assert_eq!(fs::read_to_string(&path).unwrap(), restored);
        }
        for invalid in [
            format!(" {id}"),
            format!("{id} "),
            format!("{id}\nextra"),
            "\n".into(),
        ] {
            fs::write(&path, &invalid).unwrap();
            assert_eq!(
                persisted_id(&dir).unwrap_err().kind(),
                io::ErrorKind::InvalidData
            );
            assert_eq!(fs::read_to_string(&path).unwrap(), invalid);
        }
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn concurrent_initialization_returns_one_identity() {
        let dir = std::env::temp_dir().join(format!("frame-identity-{}", random_id().unwrap()));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let dir = dir.clone();
                std::thread::spawn(move || persisted_id(&dir).unwrap())
            })
            .collect();
        let ids: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert!(ids.iter().all(|id| id == &ids[0]));
        fs::remove_dir_all(dir).unwrap();
    }
    #[rocket::async_test]
    async fn api_exposes_identity_without_mutating_it() {
        let dir = std::env::temp_dir().join(format!("frame-identity-{}", random_id().unwrap()));
        let device = Device::load(&dir).unwrap();
        let expected = device.id.clone();
        let client = rocket::local::asynchronous::Client::tracked(
            rocket::build()
                .manage(device)
                .mount("/", rocket::routes![identity]),
        )
        .await
        .unwrap();
        let result = client
            .get("/api/device")
            .dispatch()
            .await
            .into_json::<serde_json::Value>()
            .await
            .unwrap();
        assert_eq!(result["id"], expected);
        assert_eq!(result["api_version"], 1);
        fs::remove_dir_all(dir).unwrap();
    }
}
