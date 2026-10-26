use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{net::Ipv4Addr, process::Command, time::Duration};

fn address(line: &str) -> Option<String> {
    let fields: Vec<_> = line.split(';').collect();
    if fields.len() < 9 || fields[0] != "=" || fields[2] != "IPv4" || fields[4] != "_inky-soup._tcp"
    {
        return None;
    }
    let ip: Ipv4Addr = fields[7].parse().ok()?;
    let port: u16 = fields[8].parse().ok()?;
    if !ip.is_private() || port == 0 {
        return None;
    }
    Some(format!("http://{ip}:{port}"))
}

pub fn run() -> Result<Value> {
    let output = Command::new("avahi-browse")
        .args(["--resolve", "--terminate", "--parsable", "_inky-soup._tcp"])
        .output()
        .context("Install avahi-utils and enable avahi-daemon to discover local frames")?;
    if !output.status.success() {
        bail!(
            "Local discovery failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let mut bases: Vec<_> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(address)
        .collect();
    bases.sort();
    bases.dedup();
    let frames: Vec<_> = bases
        .into_iter()
        .map(|base| {
            match crate::Frame::new(&base)
                .and_then(|frame| frame.get_with_timeout("api/device", Duration::from_secs(5)))
            {
                Ok(identity) => json!({"base":base,"identity":identity}),
                Err(error) => json!({"base":base,"error":error.to_string()}),
            }
        })
        .collect();
    Ok(json!({"service":"_inky-soup._tcp", "frames":frames}))
}

#[cfg(test)]
mod tests {
    #[test]
    fn parses_only_resolved_private_ipv4_services() {
        assert_eq!(
            super::address(
                "=;wlan0;IPv4;Inky;_inky-soup._tcp;local;inky.local;192.168.1.2;8000;\"api=1\""
            ),
            Some("http://192.168.1.2:8000".into())
        );
        for line in [
            "+;wlan0;IPv4;Inky;_inky-soup._tcp;local",
            "=;eth0;IPv4;x;_http._tcp;local;x;192.168.1.2;8000",
            "=;eth0;IPv4;x;_inky-soup._tcp;local;x;8.8.8.8;8000",
            "=;eth0;IPv4;x;_inky-soup._tcp;local;x;192.168.1.2;0",
        ] {
            assert!(super::address(line).is_none());
        }
    }
}
