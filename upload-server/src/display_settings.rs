//! Runtime display settings (rotation override) and display dimension helpers.

use crate::config;
use log::{error, warn};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

pub const DEFAULT_ROTATION_DEGREES: u16 = 0;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeDisplaySettings {
    #[serde(default = "default_rotation_degrees")]
    pub rotation_degrees: u16,
}

fn default_rotation_degrees() -> u16 {
    DEFAULT_ROTATION_DEGREES
}

impl Default for RuntimeDisplaySettings {
    fn default() -> Self {
        Self {
            rotation_degrees: DEFAULT_ROTATION_DEGREES,
        }
    }
}

/// Returns true when rotation is one of the supported right angles.
pub fn is_valid_rotation_degrees(rotation_degrees: u16) -> bool {
    matches!(rotation_degrees, 0 | 90 | 180 | 270)
}

/// Converts an i32 rotation request value into a validated u16.
pub fn parse_rotation_degrees(rotation_degrees: i32) -> Option<u16> {
    let value = u16::try_from(rotation_degrees).ok()?;
    if is_valid_rotation_degrees(value) {
        Some(value)
    } else {
        None
    }
}

/// Computes logical dimensions from physical dimensions and rotation.
/// 90/270 swap width and height. 0/180 keep dimensions unchanged.
pub fn compute_logical_dimensions(
    physical_width: u32,
    physical_height: u32,
    rotation_degrees: u16,
) -> (u32, u32) {
    match rotation_degrees {
        90 | 270 => (physical_height, physical_width),
        _ => (physical_width, physical_height),
    }
}

/// Computes the clockwise rotation to apply during flashing to compensate for the
/// physical mounting orientation.
///
/// The configured `rotation_degrees` represents how the physical panel is mounted.
/// To keep UI preview and the flashed output consistent (i.e. upright in the UI),
/// the flash script should counter-rotate the image buffer.
pub fn compute_flash_rotation_degrees(mount_rotation_degrees: u16) -> u16 {
    match mount_rotation_degrees {
        0 => 0,
        90 => 270,
        180 => 180,
        270 => 90,
        _ => 0,
    }
}

fn load_runtime_settings_from_path(path: &Path) -> RuntimeDisplaySettings {
    if !path.exists() {
        return RuntimeDisplaySettings::default();
    }

    match fs::read_to_string(path) {
        Ok(contents) => match serde_json::from_str::<RuntimeDisplaySettings>(&contents) {
            Ok(settings) => {
                if is_valid_rotation_degrees(settings.rotation_degrees) {
                    settings
                } else {
                    warn!(
                        "Invalid rotation {} in runtime settings '{}', defaulting to {}",
                        settings.rotation_degrees,
                        path.display(),
                        DEFAULT_ROTATION_DEGREES
                    );
                    RuntimeDisplaySettings::default()
                }
            }
            Err(e) => {
                warn!(
                    "Failed to parse runtime settings '{}': {}. Using defaults.",
                    path.display(),
                    e
                );
                RuntimeDisplaySettings::default()
            }
        },
        Err(e) => {
            warn!(
                "Failed to read runtime settings '{}': {}. Using defaults.",
                path.display(),
                e
            );
            RuntimeDisplaySettings::default()
        }
    }
}

fn save_runtime_settings_to_path(
    path: &Path,
    settings: &RuntimeDisplaySettings,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Invalid settings path: {}", path.display()))?;

    fs::create_dir_all(parent).map_err(|e| {
        format!(
            "Failed to create settings directory '{}': {}",
            parent.display(),
            e
        )
    })?;

    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Failed to serialize runtime settings: {}", e))?;

    let temp_path = path.with_extension("json.tmp");
    fs::write(&temp_path, json).map_err(|e| {
        format!(
            "Failed to write temp runtime settings '{}': {}",
            temp_path.display(),
            e
        )
    })?;

    fs::rename(&temp_path, path).map_err(|e| {
        format!(
            "Failed to atomically persist runtime settings '{}': {}",
            path.display(),
            e
        )
    })?;

    Ok(())
}

/// Loads runtime display settings from writable app data storage.
pub fn load_runtime_settings() -> RuntimeDisplaySettings {
    load_runtime_settings_from_path(&config::display_runtime_settings_path())
}

/// Persists runtime display settings using atomic write (temp file + rename).
pub fn save_runtime_settings(settings: &RuntimeDisplaySettings) -> Result<(), String> {
    if !is_valid_rotation_degrees(settings.rotation_degrees) {
        return Err(format!(
            "Invalid rotation_degrees {}. Must be one of 0, 90, 180, 270.",
            settings.rotation_degrees
        ));
    }

    save_runtime_settings_to_path(&config::display_runtime_settings_path(), settings)
}

/// Returns the currently configured rotation.
pub fn load_rotation_degrees() -> u16 {
    load_runtime_settings().rotation_degrees
}

/// Saves a validated rotation.
pub fn save_rotation_degrees(rotation_degrees: u16) -> Result<(), String> {
    if !is_valid_rotation_degrees(rotation_degrees) {
        return Err(format!(
            "Invalid rotation_degrees {}. Must be one of 0, 90, 180, 270.",
            rotation_degrees
        ));
    }

    let settings = RuntimeDisplaySettings { rotation_degrees };
    save_runtime_settings(&settings).map_err(|e| {
        error!("Failed to persist display rotation: {}", e);
        e
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("{}_{}_{}", prefix, std::process::id(), nanos));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn test_rotation_validation() {
        assert!(is_valid_rotation_degrees(0));
        assert!(is_valid_rotation_degrees(90));
        assert!(is_valid_rotation_degrees(180));
        assert!(is_valid_rotation_degrees(270));
        assert!(!is_valid_rotation_degrees(45));
        assert!(!is_valid_rotation_degrees(360));
    }

    #[test]
    fn test_parse_rotation_degrees() {
        assert_eq!(parse_rotation_degrees(0), Some(0));
        assert_eq!(parse_rotation_degrees(90), Some(90));
        assert_eq!(parse_rotation_degrees(180), Some(180));
        assert_eq!(parse_rotation_degrees(270), Some(270));
        assert_eq!(parse_rotation_degrees(-90), None);
        assert_eq!(parse_rotation_degrees(45), None);
    }

    #[test]
    fn test_logical_dimensions_swap_for_90_and_270() {
        assert_eq!(compute_logical_dimensions(1600, 1200, 0), (1600, 1200));
        assert_eq!(compute_logical_dimensions(1600, 1200, 180), (1600, 1200));
        assert_eq!(compute_logical_dimensions(1600, 1200, 90), (1200, 1600));
        assert_eq!(compute_logical_dimensions(1600, 1200, 270), (1200, 1600));
    }

    #[test]
    fn test_flash_rotation_compensates_for_mounting_orientation() {
        assert_eq!(compute_flash_rotation_degrees(0), 0);
        assert_eq!(compute_flash_rotation_degrees(90), 270);
        assert_eq!(compute_flash_rotation_degrees(180), 180);
        assert_eq!(compute_flash_rotation_degrees(270), 90);
    }

    #[test]
    fn test_runtime_settings_persistence_round_trip() {
        let temp_dir = unique_temp_dir("inky_soup_rotation_settings");
        let settings_path = temp_dir.join("display-runtime.json");
        let settings = RuntimeDisplaySettings {
            rotation_degrees: 270,
        };

        save_runtime_settings_to_path(&settings_path, &settings).unwrap();
        let loaded = load_runtime_settings_from_path(&settings_path);
        assert_eq!(loaded.rotation_degrees, 270);

        fs::remove_dir_all(temp_dir).unwrap();
    }

    #[test]
    fn test_invalid_runtime_settings_fall_back_to_default() {
        let temp_dir = unique_temp_dir("inky_soup_rotation_settings_invalid");
        let settings_path = temp_dir.join("display-runtime.json");
        fs::write(&settings_path, r#"{"rotation_degrees":45}"#).unwrap();

        let loaded = load_runtime_settings_from_path(&settings_path);
        assert_eq!(loaded.rotation_degrees, DEFAULT_ROTATION_DEGREES);

        fs::remove_dir_all(temp_dir).unwrap();
    }
}
