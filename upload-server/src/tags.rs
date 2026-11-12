//! Photo tags: short lowercase labels that also choose what the slideshow shows.
//! `favorite` is built in as the slideshow's default tag. Tag changes need no
//! edit lock of their own, since they change no pixels or image settings, but
//! they wait while another session edits the photo.
use crate::{
    api_error::{failure, Failure},
    browser_access::BrowserWrite,
    config,
    image_locks::ImageLocksState,
    metadata,
    storage::{self, StorageLock},
};
use rocket::{
    http::Status,
    serde::json::{json, Json, Value},
    State,
};
use serde::Deserialize;

/// The built-in tag, and the slideshow's default.
pub const FAVORITE: &str = "favorite";
/// The most tags a photo, or the slideshow, can have.
pub const MAX_TAGS: usize = 20;
const MAX_CHARS: usize = 32;

/// Returns a tag as it is stored: trimmed, with each run of whitespace as one
/// space, in lowercase. Tags have no commas, so clients can separate tags with
/// them.
pub fn normalize(tag: &str) -> Result<String, String> {
    let tag = tag
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if tag.is_empty() {
        return Err("A tag can't be empty".into());
    }
    if tag.chars().count() > MAX_CHARS {
        return Err(format!(
            "Tags can be at most {MAX_CHARS} characters: {tag:?}"
        ));
    }
    if tag.chars().any(|c| c == ',' || c.is_control()) {
        return Err(format!(
            "Tags can't contain commas or control characters: {tag:?}"
        ));
    }
    Ok(tag)
}

/// Normalizes tags, sorted and without duplicates.
pub fn normalize_all(tags: &[String]) -> Result<Vec<String>, String> {
    let mut tags = tags
        .iter()
        .map(|tag| normalize(tag))
        .collect::<Result<Vec<_>, _>>()?;
    tags.sort();
    tags.dedup();
    Ok(tags)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TagChange {
    filename: String,
    /// Lets the session holding the photo's edit lock change its tags.
    session_id: Option<String>,
    #[serde(default)]
    add: Vec<String>,
    #[serde(default)]
    remove: Vec<String>,
}

type TagResult = Result<Json<Value>, Failure>;

#[post("/api/settings/tags", format = "json", data = "<request>")]
pub async fn update_tags(
    _origin: BrowserWrite,
    request: Json<TagChange>,
    storage: &State<StorageLock>,
    locks: &State<ImageLocksState>,
) -> TagResult {
    let filename = &request.filename;
    if crate::sanitize_filename(filename).as_ref() != Some(filename) || filename.contains('\0') {
        return Err(failure(Status::BadRequest, "Invalid filename"));
    }
    let invalid = |message: String| failure(Status::BadRequest, message);
    let add = normalize_all(&request.add).map_err(invalid)?;
    let remove = normalize_all(&request.remove).map_err(invalid)?;
    if add.is_empty() && remove.is_empty() {
        return Err(invalid("Provide tags to add or remove".into()));
    }
    if add.iter().any(|tag| remove.contains(tag)) {
        return Err(invalid("A tag can't be added and removed at once".into()));
    }
    let Some(_storage) = storage::lock_unless_edited_by_another(
        storage,
        locks,
        filename,
        request.session_id.as_deref(),
    )
    .await
    else {
        return Err(failure(
            Status::Conflict,
            "Another editor has this photo open",
        ));
    };
    if !config::original_path(filename).is_file() {
        return Err(failure(Status::NotFound, "Photo not found"));
    }
    let mut meta = metadata::get_all_metadata(filename);
    let mut tags: Vec<_> = meta
        .tags()
        .iter()
        .filter(|tag| !remove.contains(tag))
        .cloned()
        .chain(add)
        .collect();
    tags.sort();
    tags.dedup();
    if tags.len() > MAX_TAGS {
        return Err(invalid(format!("A photo can have at most {MAX_TAGS} tags")));
    }
    meta.set_tags(tags);
    metadata::try_save_metadata(filename, &meta)
        .map_err(|error| failure(Status::InternalServerError, error))?;
    Ok(Json(
        json!({"success": true, "filename": filename, "tags": meta.tags()}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tags_are_trimmed_lowercase_and_short() {
        assert_eq!(normalize("  Beach \t Trip ").unwrap(), "beach trip");
        assert_eq!(normalize("ÉTÉ").unwrap(), "été");
        let longest = "x".repeat(MAX_CHARS);
        assert_eq!(normalize(&longest).unwrap(), longest);
        let long = "x".repeat(MAX_CHARS + 1);
        for tag in ["", " \t ", long.as_str(), "a,b", "a\u{7}b"] {
            assert!(normalize(tag).is_err(), "{tag:?}");
        }
        assert_eq!(
            normalize_all(&["Kids".into(), "beach".into(), "KIDS ".into()]).unwrap(),
            ["beach", "kids"]
        );
    }
}
