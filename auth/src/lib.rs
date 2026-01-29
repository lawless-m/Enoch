//! Enoch Auth - Plan 9 authentication (p9sk1/dp9ik) for browser WASM
//!
//! This crate implements the client-side authentication protocols used by Plan 9:
//! - p9sk1: Classic Plan 9 auth using non-standard DES
//! - dp9ik: Modern 9front auth using SPAKE2-EE on Ed448 + ChaCha20-Poly1305

pub mod authpak;
pub mod des9;
pub mod p9sk1;

// Re-export main types for p9sk1
pub use p9sk1::{pass_to_key, P9sk1Client};

// Re-export main types for dp9ik (authpak)
pub use authpak::{
    authpak_finish, authpak_hash, authpak_new, PakError, PakPriv, PAKHASHLEN, PAKKEYLEN, PAKYLEN,
};
