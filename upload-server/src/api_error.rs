//! API failures: an HTTP error status with the body
//! `{"success": false, "message": "…"}`. Clients show the message.
use rocket::http::Status;
use rocket::serde::json::{json, Json, Value};
use rocket::Request;

pub type Failure = (Status, Json<Value>);

pub fn failure(status: Status, message: impl ToString) -> Failure {
    (
        status,
        Json(json!({"success": false, "message": message.to_string()})),
    )
}

/// Explains, in the same shape, the requests that Rocket refuses before a
/// route runs: unreadable or incomplete bodies, foreign origins and unknown
/// paths.
#[catch(default)]
pub fn catcher(status: Status, request: &Request<'_>) -> Failure {
    let message = match status.code {
        400 => "The frame could not read this request.".to_string(),
        403 => "Requests from this origin cannot change the frame.".to_string(),
        404 => format!(
            "{} {} was not found on this frame.",
            request.method(),
            request.uri().path()
        ),
        413 => "The upload is larger than the frame accepts.".to_string(),
        422 => "The request is missing a field or has an invalid value.".to_string(),
        _ => format!("The frame answered {status}."),
    };
    failure(status, message)
}

/// Checks that `response` is an API failure with `status`, and returns its
/// message.
#[cfg(test)]
pub(crate) async fn expect_failure(
    response: rocket::local::asynchronous::LocalResponse<'_>,
    status: Status,
) -> String {
    assert_eq!(response.status(), status);
    assert_eq!(
        response.content_type(),
        Some(rocket::http::ContentType::JSON)
    );
    let body = response.into_json::<Value>().await.unwrap();
    assert_eq!(body["success"], false, "{body}");
    let message = body["message"].as_str().unwrap_or_default();
    assert!(!message.is_empty(), "{body}");
    message.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser_access::{BrowserAccess, BrowserWrite};
    use crate::image_locks::ImageLocksState;
    use rocket::http::{ContentType, Header};
    use rocket::local::asynchronous::Client;
    use rocket::serde::Deserialize;
    use std::collections::HashMap;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    #[derive(Deserialize)]
    #[serde(crate = "rocket::serde")]
    struct Greeting {
        name: String,
    }

    #[post("/greet", data = "<greeting>")]
    fn greet(_origin: BrowserWrite, greeting: Json<Greeting>) -> String {
        greeting.name.clone()
    }

    #[rocket::async_test]
    async fn requests_refused_before_a_route_runs_explain_themselves() {
        let locks: ImageLocksState = Arc::new(Mutex::new(HashMap::new()));
        let client = Client::tracked(
            rocket::build()
                .manage(BrowserAccess::from_env())
                .manage(locks)
                .mount("/", routes![greet, crate::unlock_image])
                .register("/", catchers![catcher]),
        )
        .await
        .unwrap();
        let greet = |body: &'static str| client.post("/greet").header(ContentType::JSON).body(body);
        for (request, status, message) in [
            (
                greet("{"),
                Status::BadRequest,
                "The frame could not read this request.",
            ),
            (
                greet("{}"),
                Status::UnprocessableEntity,
                "The request is missing a field or has an invalid value.",
            ),
            (
                greet(r#"{"name":"frame"}"#).header(Header::new("Origin", "https://example.com")),
                Status::Forbidden,
                "Requests from this origin cannot change the frame.",
            ),
            (
                client.get("/greet"),
                Status::NotFound,
                "GET /greet was not found on this frame.",
            ),
            // Routes refuse requests in the same shape.
            (
                client
                    .post("/api/unlock-image")
                    .header(ContentType::JSON)
                    .body(r#"{"filename":"..","session_id":"editor"}"#),
                Status::BadRequest,
                "Invalid filename",
            ),
        ] {
            assert_eq!(
                expect_failure(request.dispatch().await, status).await,
                message
            );
        }
    }
}
