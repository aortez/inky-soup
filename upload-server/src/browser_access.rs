//! Browser access for the hosted frame client. This is an origin policy, not LAN authentication.

use rocket::fairing::{Fairing, Info, Kind};
use rocket::http::{Header, Method, Status};
use rocket::request::{FromRequest, Outcome};
use rocket::{Request, Response, State};

pub struct BrowserAccess {
    origins: Vec<String>,
}

impl BrowserAccess {
    pub fn from_env() -> Self {
        let mut origins = vec!["https://allan.pizza".to_string()];
        if let Ok(extra) = std::env::var("INKY_SOUP_CLIENT_ORIGINS") {
            origins.extend(
                extra
                    .split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned),
            );
        }
        Self { origins }
    }

    fn allows(&self, origin: &str) -> bool {
        self.origins.iter().any(|allowed| allowed == origin)
    }
}

/// Reject foreign browser writes even when they use a form without a CORS preflight.
pub struct BrowserWrite;

#[rocket::async_trait]
impl<'r> FromRequest<'r> for BrowserWrite {
    type Error = ();

    async fn from_request(request: &'r Request<'_>) -> Outcome<Self, Self::Error> {
        let origin = match request.headers().get_one("Origin") {
            Some(origin) => origin,
            // CLI clients and same-origin requests may omit Origin.
            None => return Outcome::Success(Self),
        };
        let same_origin = request
            .host()
            .map(|host| origin == format!("http://{host}"))
            .unwrap_or(false);
        if same_origin
            || request
                .rocket()
                .state::<BrowserAccess>()
                .is_some_and(|access| access.allows(origin))
        {
            Outcome::Success(Self)
        } else {
            Outcome::Error((Status::Forbidden, ()))
        }
    }
}

pub struct Cors;

#[rocket::async_trait]
impl Fairing for Cors {
    fn info(&self) -> Info {
        Info {
            name: "Hosted frame client CORS",
            kind: Kind::Response,
        }
    }

    async fn on_response<'r>(&self, request: &'r Request<'_>, response: &mut Response<'r>) {
        response.adjoin_header(Header::new("Vary", "Origin"));
        let origin = match request.headers().get_one("Origin") {
            Some(origin) => origin,
            None => return,
        };
        let access = match request.rocket().state::<BrowserAccess>() {
            Some(access) => access,
            None => return,
        };
        if access.allows(origin) {
            response.set_header(Header::new(
                "Access-Control-Allow-Origin",
                origin.to_owned(),
            ));
            response.set_header(Header::new(
                "Access-Control-Allow-Methods",
                "GET, POST, OPTIONS",
            ));
            response.set_header(Header::new("Access-Control-Allow-Headers", "Content-Type"));
        }
    }
}

#[options("/<_path..>")]
pub fn preflight(
    _path: std::path::PathBuf,
    request: Preflight,
    _access: &State<BrowserAccess>,
) -> Status {
    let _ = request;
    Status::NoContent
}

pub struct Preflight;

#[rocket::async_trait]
impl<'r> FromRequest<'r> for Preflight {
    type Error = ();

    async fn from_request(request: &'r Request<'_>) -> Outcome<Self, Self::Error> {
        let allowed = request
            .headers()
            .get_one("Origin")
            .zip(request.rocket().state::<BrowserAccess>())
            .is_some_and(|(origin, access)| access.allows(origin));
        let method = request
            .headers()
            .get_one("Access-Control-Request-Method")
            .and_then(|value| value.parse::<Method>().ok());
        let headers_ok = request
            .headers()
            .get_one("Access-Control-Request-Headers")
            .map(|headers| {
                headers
                    .split(',')
                    .all(|h| h.trim().eq_ignore_ascii_case("content-type"))
            })
            .unwrap_or(true);
        if allowed && matches!(method, Some(Method::Get | Method::Post)) && headers_ok {
            Outcome::Success(Self)
        } else {
            Outcome::Error((Status::Forbidden, ()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rocket::local::asynchronous::Client;

    #[get("/read")]
    fn read() -> &'static str {
        "frame"
    }

    #[post("/write")]
    fn write(_origin: BrowserWrite) -> &'static str {
        "written"
    }

    async fn client() -> Client {
        Client::tracked(
            rocket::build()
                .manage(BrowserAccess {
                    origins: vec!["https://allan.pizza".into()],
                })
                .attach(Cors)
                .mount("/", routes![read, write, preflight]),
        )
        .await
        .unwrap()
    }

    #[rocket::async_test]
    async fn only_exact_client_origin_can_read_cross_origin() {
        let client = client().await;
        for origin in [
            "https://allan.pizza",
            "https://allan.pizza.evil.example",
            "http://allan.pizza",
            "null",
        ] {
            let response = client
                .get("/read")
                .header(Header::new("Origin", origin))
                .dispatch()
                .await;
            assert_eq!(
                response.headers().get_one("Access-Control-Allow-Origin"),
                if origin == "https://allan.pizza" {
                    Some(origin)
                } else {
                    None
                }
            );
        }
    }

    #[rocket::async_test]
    async fn reject_foreign_simple_posts_before_route_execution() {
        let client = client().await;
        for origin in ["https://evil.example", "null"] {
            let response = client
                .post("/write")
                .header(Header::new("Origin", origin))
                .dispatch()
                .await;
            assert_eq!(response.status(), Status::Forbidden);
        }
        assert_eq!(client.post("/write").dispatch().await.status(), Status::Ok);
        assert_eq!(
            client
                .post("/write")
                .header(Header::new("Origin", "https://allan.pizza"))
                .dispatch()
                .await
                .status(),
            Status::Ok
        );
        let mut local = client
            .post("/write")
            .header(Header::new("Origin", "http://inky-soup.local:8000"));
        local
            .inner_mut()
            .set_host(rocket::http::uri::Host::from(uri!("inky-soup.local:8000")));
        assert_eq!(local.dispatch().await.status(), Status::Ok);
    }

    #[rocket::async_test]
    async fn preflight_requires_known_origin_method_and_headers() {
        let client = client().await;
        for (origin, method, headers, expected) in [
            (
                "https://allan.pizza",
                "POST",
                "content-type",
                Status::NoContent,
            ),
            (
                "https://allan.pizza",
                "DELETE",
                "content-type",
                Status::Forbidden,
            ),
            (
                "https://allan.pizza",
                "POST",
                "x-unexpected",
                Status::Forbidden,
            ),
            (
                "https://evil.example",
                "POST",
                "content-type",
                Status::Forbidden,
            ),
        ] {
            let response = client
                .options("/api/upload-dithered")
                .header(Header::new("Origin", origin))
                .header(Header::new("Access-Control-Request-Method", method))
                .header(Header::new("Access-Control-Request-Headers", headers))
                .dispatch()
                .await;
            assert_eq!(response.status(), expected);
        }
    }
}
