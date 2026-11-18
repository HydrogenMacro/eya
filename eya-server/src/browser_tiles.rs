//! Negotiated, lossless canonical-RGBA screencast updates.
//!
//! The reference is the last successfully presented *tile* frame, never a
//! browser-decoded JPEG/PNG. Independent PNG fallbacks leave it intact. Call
//! preparation from a blocking task: PNG decoding and DEFLATE are CPU work.

use flate2::{Compression, write::DeflateEncoder};
use std::io::{Cursor, Write};
use std::time::{Duration, Instant};

pub const MAX_PIXELS: usize = 4_194_304;
pub const MAX_PAYLOAD_BYTES: usize = 16 * 1024 * 1024;
pub const TILE_EDGE: usize = 64;
const MAX_DIMENSION: u32 = 8192;
const MAX_TILES: usize = 1024;

#[derive(Debug)]
pub enum Prepared {
    Tiles {
        bytes: Vec<u8>,
        width: u32,
        height: u32,
        base: u32,
        tile_count: u16,
    },
    Unchanged,
    PngFallback,
}

struct Reference {
    seq: u32,
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

#[derive(Default)]
pub struct Encoder {
    reference: Option<Reference>,
    pending: Option<Reference>,
    reference_displayed: bool,
    png_fallbacks: u8,
    last_keyframe: Option<Instant>,
}

impl Encoder {
    pub fn reset(&mut self) {
        self.reference = None;
        self.pending = None;
        self.reference_displayed = false;
        self.png_fallbacks = 0;
        self.last_keyframe = None;
    }

    /// Commit only the matching positive presentation ACK. A rejection drops
    /// the reference, so the next update is an independent keyframe.
    pub fn ack(&mut self, seq: u32, success: bool) -> bool {
        if self.pending.as_ref().map(|frame| frame.seq) != Some(seq) {
            return false;
        }
        let pending = self.pending.take();
        if success {
            self.reference = pending;
            self.reference_displayed = true;
            self.png_fallbacks = 0;
        } else {
            self.reference = None;
            self.reference_displayed = false;
            self.png_fallbacks = 0;
        }
        true
    }

    pub fn prepare_png(&mut self, png: &[u8], seq: u32) -> Result<Prepared, String> {
        if seq == 0 || self.pending.is_some() {
            return Err("Invalid or outstanding tile frame".into());
        }
        let Some((width, height, pixels)) = decode_png(png)? else {
            self.reference = None;
            self.reference_displayed = false;
            self.png_fallbacks = 0;
            return Ok(Prepared::PngFallback);
        };
        // A large scroll or a new scene can make the old reference permanently
        // uneconomical. Establish a fresh canonical surface after a short
        // fallback streak, without adding a second full-size pixel buffer or
        // repeatedly forcing keyframes during sustained animation.
        if self.reference.is_some()
            && self.png_fallbacks >= 3
            && self
                .last_keyframe
                .is_some_and(|created| created.elapsed() >= Duration::from_secs(2))
        {
            self.reference = None;
            self.reference_displayed = false;
            self.png_fallbacks = 0;
        }
        if self
            .reference
            .as_ref()
            .is_some_and(|frame| frame.width != width || frame.height != height)
        {
            self.reference = None;
            self.reference_displayed = false;
            self.png_fallbacks = 0;
        }
        let columns = (width as usize).div_ceil(TILE_EDGE);
        let rows = (height as usize).div_ceil(TILE_EDGE);
        let total_tiles = columns * rows;
        if total_tiles > MAX_TILES {
            self.reference = None;
            self.reference_displayed = false;
            self.png_fallbacks = 0;
            return Ok(Prepared::PngFallback);
        }
        let base = self.reference.as_ref().map_or(0, |frame| frame.seq);
        let mut changed = vec![true; total_tiles];
        if let Some(reference) = self.reference.as_ref() {
            let stride = width as usize * 4;
            let mut changed_pixels = 0;
            for (index, changed) in changed.iter_mut().enumerate() {
                let x = (index % columns) * TILE_EDGE;
                let y = (index / columns) * TILE_EDGE;
                let tile_width = TILE_EDGE.min(width as usize - x);
                let tile_height = TILE_EDGE.min(height as usize - y);
                *changed = !(0..tile_height).all(|row| {
                    let start = (y + row) * stride + x * 4;
                    pixels[start..start + tile_width * 4]
                        == reference.pixels[start..start + tile_width * 4]
                });
                if *changed {
                    changed_pixels += tile_width * tile_height;
                    // Scrolling and full-motion content should not run two
                    // encoders per tile merely to rediscover that PNG wins.
                    // This threshold bounds wasted work; initial reference
                    // establishment deliberately takes the keyframe path.
                    if changed_pixels * 5 > width as usize * height as usize * 3 {
                        self.reference_displayed = false;
                        self.png_fallbacks = self.png_fallbacks.saturating_add(1);
                        return Ok(Prepared::PngFallback);
                    }
                }
            }
        }
        // Fixed eight-byte header, then index:u16, mode:u8, compressed size:u32
        // and one independent raw-DEFLATE block for each changed tile.
        let mut payload = Vec::from(&b"EYT1"[..]);
        payload.extend_from_slice(&(TILE_EDGE as u16).to_be_bytes());
        payload.extend_from_slice(&0u16.to_be_bytes());
        let mut count = 0u16;
        for index in 0..total_tiles {
            if !changed[index] {
                continue;
            }
            let x = (index % columns) * TILE_EDGE;
            let y = (index / columns) * TILE_EDGE;
            let tile_width = TILE_EDGE.min(width as usize - x);
            let tile_height = TILE_EDGE.min(height as usize - y);
            let row_bytes = tile_width * 4;
            let stride = width as usize * 4;
            let reference = self.reference.as_ref();
            let mut replacement = Vec::with_capacity(row_bytes * tile_height);
            let mut residual = reference.map(|_| Vec::with_capacity(row_bytes * tile_height));
            for row in 0..tile_height {
                let start = (y + row) * stride + x * 4;
                let current = &pixels[start..start + row_bytes];
                replacement.extend_from_slice(current);
                if let (Some(frame), Some(residual)) = (reference, residual.as_mut()) {
                    residual.extend(
                        current
                            .iter()
                            .zip(&frame.pixels[start..start + row_bytes])
                            .map(|(current, old)| current ^ old),
                    );
                }
            }
            let mut compressed = deflate(&replacement)?;
            let mut mode = 0u8;
            if let Some(residual) = residual {
                let xor = deflate(&residual)?;
                if xor.len() < compressed.len() {
                    compressed = xor;
                    mode = 1;
                }
            }
            let next_size = payload.len() + 7 + compressed.len();
            if next_size > MAX_PAYLOAD_BYTES || (base != 0 && next_size >= png.len()) {
                // The old canonical reference remains valid while the panel
                // displays this independent PNG. No reference ACK is expected.
                self.reference_displayed = false;
                self.png_fallbacks = self.png_fallbacks.saturating_add(1);
                return Ok(Prepared::PngFallback);
            }
            payload.extend_from_slice(&(index as u16).to_be_bytes());
            payload.push(mode);
            payload.extend_from_slice(&(compressed.len() as u32).to_be_bytes());
            payload.extend_from_slice(&compressed);
            count += 1;
        }
        if count == 0 && self.reference_displayed {
            return Ok(Prepared::Unchanged);
        }
        payload[6..8].copy_from_slice(&count.to_be_bytes());
        self.pending = Some(Reference {
            seq,
            width,
            height,
            pixels,
        });
        if base == 0 {
            self.last_keyframe = Some(Instant::now());
        }
        Ok(Prepared::Tiles {
            bytes: payload,
            width,
            height,
            base,
            tile_count: count,
        })
    }
}

fn deflate(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::fast());
    encoder
        .write_all(bytes)
        .map_err(|_| "Tile compression failed".to_owned())?;
    encoder
        .finish()
        .map_err(|_| "Tile compression failed".to_owned())
}

/// Validate IHDR geometry before asking the decoder to allocate its own row
/// buffers. Its separate internal budget covers bounded ancillary metadata.
fn decode_png(png: &[u8]) -> Result<Option<(u32, u32, Vec<u8>)>, String> {
    if png.len() < 33
        || png.len() > MAX_PAYLOAD_BYTES
        || &png[..8] != b"\x89PNG\r\n\x1a\n"
        || &png[8..16] != b"\0\0\0\rIHDR"
    {
        return Err("Invalid screencast PNG".into());
    }
    let width = u32::from_be_bytes(png[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(png[20..24].try_into().unwrap());
    if width == 0 || height == 0 || width > MAX_DIMENSION || height > MAX_DIMENSION {
        return Err("Invalid screencast PNG dimensions".into());
    }
    let pixels = width as usize * height as usize;
    if pixels > MAX_PIXELS {
        return Ok(None);
    }
    // CDP's compositor PNGs are eight-bit. Do not silently quantize an
    // unexpected sixteen-bit source into the exact-reference protocol.
    if png[24] == 16 {
        return Err("Unsupported screencast PNG bit depth".into());
    }
    let mut decoder = png::Decoder::new(Cursor::new(png));
    decoder.set_limits(png::Limits {
        bytes: 32 * 1024 * 1024,
    });
    decoder.set_ignore_text_chunk(true);
    decoder.set_ignore_iccp_chunk(true);
    decoder.set_transformations(png::Transformations::EXPAND);
    let mut reader = decoder
        .read_info()
        .map_err(|_| "Invalid screencast PNG".to_owned())?;
    if reader.info().animation_control.is_some()
        || reader.info().width != width
        || reader.info().height != height
    {
        return Err("Unsupported screencast PNG".into());
    }
    let output_size = reader
        .output_buffer_size()
        .filter(|size| *size <= MAX_PIXELS * 4)
        .ok_or_else(|| "Screencast PNG exceeds pixel limit".to_owned())?;
    let mut decoded = vec![0; output_size];
    let info = reader
        .next_frame(&mut decoded)
        .map_err(|_| "Invalid screencast PNG pixels".to_owned())?;
    if info.bit_depth != png::BitDepth::Eight || info.width != width || info.height != height {
        return Err("Unsupported screencast PNG pixels".into());
    }
    decoded.truncate(info.buffer_size());
    let channels = info.color_type.samples();
    if decoded.len() != pixels * channels {
        return Err("Invalid screencast PNG pixel count".into());
    }
    if info.color_type == png::ColorType::Rgba {
        return Ok(Some((width, height, decoded)));
    }
    let mut rgba = Vec::with_capacity(pixels * 4);
    for pixel in decoded.chunks_exact(channels) {
        match info.color_type {
            png::ColorType::Rgb => rgba.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 255]),
            png::ColorType::Grayscale => {
                rgba.extend_from_slice(&[pixel[0], pixel[0], pixel[0], 255]);
            }
            png::ColorType::GrayscaleAlpha => {
                rgba.extend_from_slice(&[pixel[0], pixel[0], pixel[0], pixel[1]]);
            }
            _ => return Err("Unsupported screencast PNG color type".into()),
        }
    }
    Ok(Some((width, height, rgba)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::read::DeflateDecoder;
    use std::io::Read;

    fn png(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut out, width, height);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder
                .write_header()
                .unwrap()
                .write_image_data(rgba)
                .unwrap();
        }
        out
    }

    fn apply(prepared: &Prepared, previous: Option<&[u8]>) -> Vec<u8> {
        let Prepared::Tiles {
            bytes,
            width,
            height,
            base,
            tile_count,
        } = prepared
        else {
            panic!("Expected tile frame");
        };
        assert_eq!(&bytes[..4], b"EYT1");
        let edge = u16::from_be_bytes(bytes[4..6].try_into().unwrap()) as usize;
        let count = u16::from_be_bytes(bytes[6..8].try_into().unwrap());
        assert_eq!(count, *tile_count);
        let mut out = if *base == 0 {
            vec![0; *width as usize * *height as usize * 4]
        } else {
            previous.unwrap().to_vec()
        };
        let columns = (*width as usize).div_ceil(edge);
        let mut offset = 8;
        let mut seen = std::collections::HashSet::new();
        for _ in 0..count {
            let index = u16::from_be_bytes(bytes[offset..offset + 2].try_into().unwrap()) as usize;
            assert!(seen.insert(index));
            let mode = bytes[offset + 2];
            let size =
                u32::from_be_bytes(bytes[offset + 3..offset + 7].try_into().unwrap()) as usize;
            let x = index % columns * edge;
            let y = index / columns * edge;
            let tw = edge.min(*width as usize - x);
            let th = edge.min(*height as usize - y);
            let mut decoded = Vec::new();
            DeflateDecoder::new(&bytes[offset + 7..offset + 7 + size])
                .read_to_end(&mut decoded)
                .unwrap();
            assert_eq!(decoded.len(), tw * th * 4);
            for row in 0..th {
                let start = ((y + row) * *width as usize + x) * 4;
                for col in 0..tw * 4 {
                    let value = decoded[row * tw * 4 + col];
                    out[start + col] = if mode == 1 {
                        out[start + col] ^ value
                    } else {
                        value
                    };
                }
            }
            offset += 7 + size;
        }
        assert_eq!(offset, bytes.len());
        if *base == 0 {
            assert_eq!(count as usize, columns * (*height as usize).div_ceil(edge));
        }
        out
    }

    #[test]
    fn keyframe_delta_and_ack_are_exact_and_bounded() {
        let mut encoder = Encoder::default();
        let mut pixels = vec![255; 129 * 67 * 4];
        let first = encoder.prepare_png(&png(129, 67, &pixels), 1).unwrap();
        assert_eq!(apply(&first, None), pixels);
        assert!(!encoder.ack(2, true));
        assert!(encoder.prepare_png(&png(129, 67, &pixels), 2).is_err());
        assert!(encoder.ack(1, true));
        assert!(matches!(
            encoder.prepare_png(&png(129, 67, &pixels), 2).unwrap(),
            Prepared::Unchanged
        ));
        pixels[10] = 7;
        pixels[11] = 128;
        let delta = encoder.prepare_png(&png(129, 67, &pixels), 3).unwrap();
        assert!(matches!(
            delta,
            Prepared::Tiles {
                base: 1,
                tile_count: 1,
                ..
            }
        ));
        assert_eq!(apply(&delta, Some(&apply(&first, None))), pixels);
        assert!(encoder.ack(3, false));
        let reset = encoder.prepare_png(&png(129, 67, &pixels), 4).unwrap();
        assert!(matches!(reset, Prepared::Tiles { base: 0, .. }));
        assert_eq!(apply(&reset, None), pixels);
        assert!(encoder.ack(4, true));
        let resized = vec![0; 31 * 19 * 4];
        let resize = encoder.prepare_png(&png(31, 19, &resized), 5).unwrap();
        assert!(matches!(resize, Prepared::Tiles { base: 0, .. }));
        assert_eq!(apply(&resize, None), resized);
    }

    #[test]
    fn fallback_does_not_change_reference_and_reset_forces_keyframe() {
        let mut encoder = Encoder::default();
        let mut noisy = vec![0; 128 * 128 * 4];
        let mut seed = 17u32;
        for pixel in noisy.chunks_exact_mut(4) {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            pixel.copy_from_slice(&[seed as u8, (seed >> 8) as u8, (seed >> 16) as u8, 255]);
        }
        encoder.prepare_png(&png(128, 128, &noisy), 1).unwrap();
        assert!(encoder.ack(1, true));
        // A simple replacement compresses well as filtered PNG, so a full
        // independent PNG is often cheaper than many independent tile blocks.
        let simple = vec![255; 128 * 128 * 4];
        assert!(matches!(
            encoder.prepare_png(&png(128, 128, &simple), 2).unwrap(),
            Prepared::PngFallback
        ));
        assert!(!encoder.ack(2, true));
        let restore = encoder.prepare_png(&png(128, 128, &noisy), 3).unwrap();
        assert!(matches!(
            restore,
            Prepared::Tiles {
                base: 1,
                tile_count: 0,
                ..
            }
        ));
        assert_eq!(apply(&restore, Some(&noisy)), noisy);
        assert!(encoder.ack(3, true));
        assert!(matches!(
            encoder.prepare_png(&png(128, 128, &noisy), 4).unwrap(),
            Prepared::Unchanged
        ));
        encoder.reset();
        assert!(matches!(
            encoder.prepare_png(&png(128, 128, &simple), 5).unwrap(),
            Prepared::Tiles { base: 0, .. }
        ));
    }

    #[test]
    fn png_geometry_and_decode_limits_precede_pixel_allocation() {
        let mut encoder = Encoder::default();
        assert!(encoder.prepare_png(b"not a png", 1).is_err());
        let mut data = png(1, 1, &[1, 2, 3, 4]);
        data[16..20].copy_from_slice(&8193u32.to_be_bytes());
        assert!(encoder.prepare_png(&data, 1).is_err());
        data[16..20].copy_from_slice(&4096u32.to_be_bytes());
        data[20..24].copy_from_slice(&4096u32.to_be_bytes());
        assert!(matches!(
            encoder.prepare_png(&data, 1).unwrap(),
            Prepared::PngFallback
        ));
        let mut corrupt = png(1, 1, &[1, 2, 3, 4]);
        corrupt.truncate(35);
        assert!(encoder.prepare_png(&corrupt, 1).is_err());
        let mut sixteen_bit = Vec::new();
        {
            let mut png = png::Encoder::new(&mut sixteen_bit, 1, 1);
            png.set_color(png::ColorType::Rgba);
            png.set_depth(png::BitDepth::Sixteen);
            png.write_header()
                .unwrap()
                .write_image_data(&[0; 8])
                .unwrap();
        }
        assert!(encoder.prepare_png(&sixteen_bit, 1).is_err());
    }

    #[test]
    fn sparse_residual_uses_xor_but_replacing_noise_uses_replacement() {
        let mut pixels = vec![0; 256 * 128 * 4];
        let mut seed = 19u32;
        for pixel in pixels.chunks_exact_mut(4) {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            pixel.copy_from_slice(&[seed as u8, (seed >> 8) as u8, (seed >> 16) as u8, 255]);
        }
        let mut encoder = Encoder::default();
        encoder.prepare_png(&png(256, 128, &pixels), 1).unwrap();
        encoder.ack(1, true);
        let original = pixels.clone();
        pixels[0] ^= 7;
        let sparse = encoder.prepare_png(&png(256, 128, &pixels), 2).unwrap();
        assert_eq!(apply(&sparse, Some(&original)), pixels);
        let Prepared::Tiles {
            bytes, tile_count, ..
        } = sparse
        else {
            panic!()
        };
        assert_eq!(tile_count, 1);
        assert_eq!(bytes[10], 1, "A sparse edit of noise should use XOR");
        encoder.ack(2, true);
        let reference = pixels.clone();
        for row in 0..64 {
            pixels[row * 256 * 4..row * 256 * 4 + 64 * 4].fill(255);
        }
        let replaced = encoder.prepare_png(&png(256, 128, &pixels), 3).unwrap();
        assert_eq!(apply(&replaced, Some(&reference)), pixels);
        let Prepared::Tiles {
            bytes, tile_count, ..
        } = replaced
        else {
            panic!()
        };
        assert_eq!(tile_count, 1);
        assert_eq!(
            bytes[10], 0,
            "A simple replacement should not retain old noise"
        );
    }

    #[test]
    fn fallback_streak_reseeds_only_after_keyframe_interval() {
        let original = vec![255; 256 * 128 * 4];
        let current = vec![0; 256 * 128 * 4];
        let mut encoder = Encoder::default();
        encoder.prepare_png(&png(256, 128, &original), 1).unwrap();
        assert!(encoder.ack(1, true));
        for sequence in 2..=5 {
            assert!(matches!(
                encoder
                    .prepare_png(&png(256, 128, &current), sequence)
                    .unwrap(),
                Prepared::PngFallback
            ));
        }
        // Advance the policy's private timestamp rather than sleeping in a
        // regression test. Three fallbacks alone must not force rapid rebases.
        encoder.last_keyframe = Some(Instant::now() - Duration::from_secs(3));
        let reseeded = encoder.prepare_png(&png(256, 128, &current), 6).unwrap();
        assert!(matches!(reseeded, Prepared::Tiles { base: 0, .. }));
        assert_eq!(apply(&reseeded, None), current);
        assert!(encoder.ack(6, true));
        assert_eq!(encoder.png_fallbacks, 0);
        assert!(encoder.last_keyframe.unwrap().elapsed() < Duration::from_secs(1));
        assert!(matches!(
            encoder.prepare_png(&png(256, 128, &current), 7).unwrap(),
            Prepared::Unchanged
        ));
    }

    #[test]
    fn rgba_conversion_preserves_alpha_and_eight_bit_gray() {
        let data = png(1, 1, &[91, 92, 93, 17]);
        assert_eq!(decode_png(&data).unwrap().unwrap().2, [91, 92, 93, 17]);
        let mut data = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut data, 2, 1);
            encoder.set_color(png::ColorType::Grayscale);
            encoder.set_depth(png::BitDepth::Eight);
            encoder
                .write_header()
                .unwrap()
                .write_image_data(&[17, 128])
                .unwrap();
        }
        assert_eq!(
            decode_png(&data).unwrap().unwrap().2,
            [17, 17, 17, 255, 128, 128, 128, 255]
        );
    }

    /// Reproducible production-codec timing on real CDP captures produced by
    /// tests/browser-compression-candidates.cjs. This is deliberately opt-in;
    /// unit tests do not depend on local image files or timing thresholds.
    #[test]
    #[ignore = "set EYA_TILE_BENCH_DIR to the real CDP capture directory"]
    fn production_tile_measurements() {
        let directory = std::path::PathBuf::from(
            std::env::var("EYA_TILE_BENCH_DIR").expect("EYA_TILE_BENCH_DIR"),
        );
        let names = [
            "unchanged",
            "caret",
            "typing",
            "selection",
            "scroll-32px",
            "scroll-256px",
            "image-simplification",
            "image-animation",
        ];
        let mut rows = Vec::new();
        for name in names {
            let base = std::fs::read(directory.join(format!("{name}-base.png"))).unwrap();
            let current = std::fs::read(directory.join(format!("{name}.png"))).unwrap();
            let original_pixels = decode_png(&base).unwrap().unwrap().2;
            let expected_pixels = decode_png(&current).unwrap().unwrap().2;
            let mut key_times = Vec::new();
            let mut update_times = Vec::new();
            let mut key_bytes = 0;
            let mut update_bytes = 0;
            let mut mode = "";
            let mut tile_count = 0;
            for _ in 0..5 {
                let mut encoder = Encoder::default();
                let started = std::time::Instant::now();
                let key = encoder.prepare_png(&base, 1).unwrap();
                key_times.push(started.elapsed().as_secs_f64() * 1000.0);
                assert_eq!(apply(&key, None), original_pixels);
                if let Prepared::Tiles { bytes, .. } = &key {
                    key_bytes = bytes.len();
                }
                assert!(encoder.ack(1, true));
                let started = std::time::Instant::now();
                let update = encoder.prepare_png(&current, 2).unwrap();
                update_times.push(started.elapsed().as_secs_f64() * 1000.0);
                match &update {
                    Prepared::Tiles {
                        bytes,
                        tile_count: count,
                        ..
                    } => {
                        assert_eq!(apply(&update, Some(&original_pixels)), expected_pixels);
                        update_bytes = bytes.len();
                        tile_count = *count;
                        mode = "tiles";
                    }
                    Prepared::PngFallback => {
                        update_bytes = current.len();
                        mode = "png";
                    }
                    Prepared::Unchanged => {
                        assert_eq!(expected_pixels, original_pixels);
                        update_bytes = 0;
                        mode = "omitted";
                    }
                }
            }
            key_times.sort_by(f64::total_cmp);
            update_times.sort_by(f64::total_cmp);
            rows.push(serde_json::json!({
                "scene":name,"pngBytes":current.len(),"keyframeBytes":key_bytes,
                "updateBytes":update_bytes,"mode":mode,"tiles":tile_count,
                "medianKeyframeMs":key_times[2],"medianPrepareMs":update_times[2],
                "maxPrepareMs":update_times[4]
            }));
        }
        let metadata: serde_json::Value =
            serde_json::from_slice(&std::fs::read(directory.join("metadata.json")).unwrap())
                .unwrap();
        let report = serde_json::json!({
            "description":"Production Rust PNG decode, changed-area scan and adaptive64px raw-DEFLATE replacement/XOR encoder; five preparations per scene; exact keyframe/delta reconstruction asserted. Timings exclude Chromium capture, network and client presentation.",
            "optimized":!cfg!(debug_assertions),"arch":std::env::consts::ARCH,
            "captureMetadata":metadata,"results":rows
        });
        let serialized = serde_json::to_string_pretty(&report).unwrap();
        if let Ok(path) = std::env::var("EYA_TILE_BENCH_REPORT") {
            std::fs::write(path, format!("{serialized}\n")).unwrap();
        }
        println!("{serialized}");
    }
}
