//! Small monochrome test card renderer; no fonts or display libraries required.
use anyhow::{bail, Context, Result};
use image::{imageops, DynamicImage, ImageFormat, Rgb, RgbImage};
use serde_json::Value;
use std::io::Cursor;

const BLACK: Rgb<u8> = Rgb([0, 0, 0]);
const WHITE: Rgb<u8> = Rgb([255, 255, 255]);

fn glyph(c: char) -> [u8; 7] {
    match c {
        'A' => [14, 17, 17, 31, 17, 17, 17],
        'B' => [30, 17, 17, 30, 17, 17, 30],
        'C' => [14, 17, 16, 16, 16, 17, 14],
        'D' => [30, 17, 17, 17, 17, 17, 30],
        'E' => [31, 16, 16, 30, 16, 16, 31],
        'G' => [14, 17, 16, 23, 17, 17, 15],
        'H' => [17, 17, 17, 31, 17, 17, 17],
        'I' => [31, 4, 4, 4, 4, 4, 31],
        'K' => [17, 18, 20, 24, 20, 18, 17],
        'L' => [16, 16, 16, 16, 16, 16, 31],
        'M' => [17, 27, 21, 21, 17, 17, 17],
        'O' => [14, 17, 17, 17, 17, 17, 14],
        'P' => [30, 17, 17, 30, 16, 16, 16],
        'R' => [30, 17, 17, 30, 20, 18, 17],
        'S' => [15, 16, 16, 14, 1, 1, 30],
        'T' => [31, 4, 4, 4, 4, 4, 4],
        'U' => [17, 17, 17, 17, 17, 17, 14],
        'W' => [17, 17, 17, 21, 21, 21, 10],
        'X' => [17, 17, 10, 4, 10, 17, 17],
        'Y' => [17, 17, 10, 4, 4, 4, 4],
        'F' => [31, 16, 16, 30, 16, 16, 16],
        '0' => [14, 17, 19, 21, 25, 17, 14],
        '1' => [4, 12, 4, 4, 4, 4, 14],
        '2' => [14, 17, 1, 2, 4, 8, 31],
        '3' => [30, 1, 1, 14, 1, 1, 30],
        '4' => [2, 6, 10, 18, 31, 2, 2],
        '5' => [31, 16, 16, 30, 1, 1, 30],
        '6' => [14, 16, 16, 30, 17, 17, 14],
        '7' => [31, 1, 2, 4, 8, 8, 8],
        '8' => [14, 17, 17, 14, 17, 17, 14],
        '9' => [14, 17, 17, 15, 1, 1, 14],
        _ => [0; 7],
    }
}

fn text_image(text: &str, scale: u32) -> RgbImage {
    let mut image = RgbImage::from_pixel(text.len() as u32 * 6 * scale - scale, 7 * scale, WHITE);
    for (i, c) in text.chars().enumerate() {
        for (y, row) in glyph(c).into_iter().enumerate() {
            for x in 0..5 {
                if row & (16 >> x) != 0 {
                    for dy in 0..scale {
                        for dx in 0..scale {
                            image.put_pixel(
                                (i as u32 * 6 + x) * scale + dx,
                                y as u32 * scale + dy,
                                BLACK,
                            );
                        }
                    }
                }
            }
        }
    }
    image
}

fn centered(image: &mut RgbImage, text: &RgbImage, x: u32, y: u32) {
    imageops::overlay(
        image,
        text,
        x as i64 - text.width() as i64 / 2,
        y as i64 - text.height() as i64 / 2,
    );
}

pub fn render(config: &Value) -> Result<Vec<u8>> {
    let width = config["width"].as_u64().context("Missing display width")?;
    let height = config["height"]
        .as_u64()
        .context("Missing display height")?;
    let degrees = config["rotation_degrees"].as_u64().unwrap_or(0);
    let physical = match config["model"].as_str() {
        Some("impression-13.3-2025") => (1600, 1200),
        Some("impression-5.7") => (600, 448),
        _ => bail!("Unsupported display model"),
    };
    let expected = if matches!(degrees, 90 | 270) {
        (physical.1, physical.0)
    } else {
        physical
    };
    if !matches!(degrees, 0 | 90 | 180 | 270) || (width, height) != expected {
        bail!("Invalid display dimensions or orientation");
    }
    let (width, height) = (width as u32, height as u32);
    let mut image = RgbImage::from_pixel(width, height, WHITE);
    let unit = width.min(height) / 100;
    for y in unit * 2..height - unit * 2 {
        for x in unit * 2..width - unit * 2 {
            if x < unit * 3 || x >= width - unit * 3 || y < unit * 3 || y >= height - unit * 3 {
                image.put_pixel(x, y, BLACK);
            }
        }
    }
    centered(&mut image, &text_image("TOP", unit), width / 2, unit * 10);
    centered(
        &mut image,
        &text_image("BOTTOM", unit),
        width / 2,
        height - unit * 10,
    );
    centered(
        &mut image,
        &imageops::rotate270(&text_image("LEFT", unit)),
        unit * 10,
        height / 2,
    );
    centered(
        &mut image,
        &imageops::rotate90(&text_image("RIGHT", unit)),
        width - unit * 10,
        height / 2,
    );
    for y in height / 4..height * 43 / 100 {
        let half = if y < height / 4 + unit * 8 {
            (y - height / 4) * 3 / 4
        } else {
            unit * 2
        };
        for x in width / 2 - half..=width / 2 + half {
            image.put_pixel(x, y, BLACK);
        }
    }
    let small = (unit * 2 / 3).max(1);
    centered(
        &mut image,
        &text_image("THIS WAY UP", small),
        width / 2,
        height * 51 / 100,
    );
    centered(
        &mut image,
        &text_image(&format!("{degrees} DEG CLOCKWISE"), small),
        width / 2,
        height * 61 / 100,
    );
    centered(
        &mut image,
        &text_image(&format!("{width} X {height}"), small),
        width / 2,
        height * 69 / 100,
    );
    let mut png = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(image).write_to(&mut png, ImageFormat::Png)?;
    Ok(png.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn cards_match_both_panels_in_all_orientations_and_only_use_native_colors() {
        for (model, w, h) in [
            ("impression-13.3-2025", 1600, 1200),
            ("impression-5.7", 600, 448),
        ] {
            for degrees in [0, 90, 180, 270] {
                let (width, height) = if degrees % 180 == 0 { (w, h) } else { (h, w) };
                let config =
                    json!({"model":model,"width":width,"height":height,"rotation_degrees":degrees});
                let png = render(&config).unwrap();
                let image = crate::validate_prepared(&png, &config).unwrap().to_rgb8();
                assert_eq!(image.dimensions(), (width, height));
                assert!(image.pixels().all(|p| *p == WHITE || *p == BLACK));
                assert_eq!(*image.get_pixel(width / 2, height / 3), BLACK);
                assert_eq!(*image.get_pixel(width / 2, height * 4 / 5), WHITE);
            }
        }
        assert!(render(&json!({"model":"impression-5.7","width":999999,"height":448})).is_err());
    }
}
