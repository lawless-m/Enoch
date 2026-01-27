//! p9sk1 - Classic Plan 9 authentication protocol
//!
//! This implements the client side of p9sk1 authentication:
//! 1. Receive challenge from server (via auth fid)
//! 2. Contact auth server to get tickets
//! 3. Decrypt client ticket to get session key
//! 4. Build authenticator and send to server
//!
//! Key functions:
//! - `pass_to_key`: Derive 7-byte DES key from password (passtokey.c)
//! - `decrypt_ticket`: Decrypt a p9sk1 ticket
//! - `make_authenticator`: Create an authenticator message

use crate::des9;

// Protocol constants from authsrv.h
pub const ANAMELEN: usize = 28;
pub const DOMLEN: usize = 48;
pub const CHALLEN: usize = 8;
pub const DESSION: usize = 7; // DES session key is 7 bytes
pub const TICKETLEN: usize = 72; // 1 + 8 + 28 + 28 + 7 = 72
pub const AUTHENTLEN: usize = 13; // 1 + 8 + 4 = 13

// Auth message types
pub const AUTH_TREQ: u8 = 1; // Ticket request
pub const AUTH_OK: u8 = 4; // Success
pub const AUTH_ERR: u8 = 5; // Error
pub const AUTH_TS: u8 = 64; // Server ticket
pub const AUTH_TC: u8 = 65; // Client ticket
pub const AUTH_AS: u8 = 66; // Server authenticator
pub const AUTH_AC: u8 = 67; // Client authenticator

/// Decrypted p9sk1 ticket contents
#[derive(Debug, Clone)]
pub struct Ticket {
    pub ticket_type: u8,
    pub challenge: [u8; CHALLEN],
    pub cuid: String,
    pub suid: String,
    pub key: [u8; DESSION],
}

/// p9sk1 authenticator
#[derive(Debug, Clone)]
pub struct Authenticator {
    pub auth_type: u8,
    pub challenge: [u8; CHALLEN],
    pub id: u32,
}

/// Plan 9 passtokey - derives 7-byte DES key from password.
/// This is the exact algorithm from 9front's passtokey.c.
pub fn pass_to_key(password: &str) -> [u8; DESSION] {
    let mut buf = [0u8; ANAMELEN];
    let mut key = [0u8; DESSION];

    // Pad password with spaces to 8 bytes minimum
    for i in 0..8.min(ANAMELEN) {
        buf[i] = b' ';
    }

    // Copy password bytes
    let pw_bytes = password.as_bytes();
    let n = pw_bytes.len().min(ANAMELEN - 1);
    buf[..n].copy_from_slice(&pw_bytes[..n]);
    buf[n] = 0; // null terminate

    let mut remaining = n;
    let mut t: &[u8] = &buf;

    loop {
        // Extract 7-byte key using Plan 9's bit-shift algorithm
        // key[i] = (t[i] >> i) | (t[i+1] << (8 - (i+1)))
        for i in 0..DESSION {
            key[i] = (t[i] >> i) | (t[i + 1] << (7 - i));
        }

        if remaining <= 8 {
            break;
        }

        remaining -= 8;

        // Build next chunk
        let mut new_t = [0u8; 8];
        let offset = if remaining < 8 { 8 - remaining } else { 0 };
        let src_start = buf.len() - remaining - offset;
        new_t[..8].copy_from_slice(&buf[src_start..src_start + 8]);

        // Encrypt the next chunk with current key
        des9::plan9_encrypt(&key, &mut new_t);

        // For next iteration, we need to keep new_t around
        // Since we can't easily do this with references, we'll
        // copy back to buf and use that
        buf[..8].copy_from_slice(&new_t);
        t = &buf[..8];

        if remaining < 8 {
            remaining = 8;
        }
    }

    key
}

/// Decrypt a p9sk1 ticket using the given key.
/// Returns the decrypted ticket contents.
pub fn decrypt_ticket(encrypted: &[u8; TICKETLEN], key: &[u8; DESSION]) -> Ticket {
    let mut data = *encrypted;
    des9::plan9_decrypt(key, &mut data);

    let ticket_type = data[0];

    let mut challenge = [0u8; CHALLEN];
    challenge.copy_from_slice(&data[1..1 + CHALLEN]);

    let cuid = read_fixed_string(&data[1 + CHALLEN..1 + CHALLEN + ANAMELEN]);
    let suid = read_fixed_string(&data[1 + CHALLEN + ANAMELEN..1 + CHALLEN + 2 * ANAMELEN]);

    let mut session_key = [0u8; DESSION];
    session_key.copy_from_slice(&data[1 + CHALLEN + 2 * ANAMELEN..TICKETLEN]);

    Ticket {
        ticket_type,
        challenge,
        cuid,
        suid,
        key: session_key,
    }
}

/// Create an encrypted authenticator.
/// The challenge should be the server's challenge with byte 0 incremented.
pub fn make_authenticator(
    auth_type: u8,
    challenge: &[u8; CHALLEN],
    id: u32,
    session_key: &[u8; DESSION],
) -> [u8; AUTHENTLEN] {
    let mut auth = [0u8; AUTHENTLEN];
    auth[0] = auth_type;
    auth[1..1 + CHALLEN].copy_from_slice(challenge);
    auth[1 + CHALLEN..].copy_from_slice(&id.to_le_bytes());

    // Encrypt with session key
    des9::plan9_encrypt(session_key, &mut auth);

    auth
}

/// Decrypt an authenticator received from server.
pub fn decrypt_authenticator(
    encrypted: &[u8; AUTHENTLEN],
    session_key: &[u8; DESSION],
) -> Authenticator {
    let mut data = *encrypted;
    des9::plan9_decrypt(session_key, &mut data);

    let auth_type = data[0];
    let mut challenge = [0u8; CHALLEN];
    challenge.copy_from_slice(&data[1..1 + CHALLEN]);
    let id = u32::from_le_bytes([data[9], data[10], data[11], data[12]]);

    Authenticator {
        auth_type,
        challenge,
        id,
    }
}

/// Build a ticket request message.
/// Format: type[1] + authid[28] + authdom[48] + chal[8] + hostid[28] + uid[28] = 141 bytes
pub fn make_ticket_request(
    authid: &str,
    authdom: &str,
    challenge: &[u8; CHALLEN],
    hostid: &str,
    uid: &str,
) -> [u8; 141] {
    let mut req = [0u8; 141];
    req[0] = AUTH_TREQ;
    write_fixed_string(&mut req[1..1 + ANAMELEN], authid);
    write_fixed_string(&mut req[1 + ANAMELEN..1 + ANAMELEN + DOMLEN], authdom);
    req[1 + ANAMELEN + DOMLEN..1 + ANAMELEN + DOMLEN + CHALLEN].copy_from_slice(challenge);
    write_fixed_string(
        &mut req[1 + ANAMELEN + DOMLEN + CHALLEN..1 + ANAMELEN + DOMLEN + CHALLEN + ANAMELEN],
        hostid,
    );
    write_fixed_string(
        &mut req[1 + ANAMELEN + DOMLEN + CHALLEN + ANAMELEN..],
        uid,
    );
    req
}

/// Helper to read a null-terminated string from a fixed-size buffer
fn read_fixed_string(data: &[u8]) -> String {
    let end = data.iter().position(|&b| b == 0).unwrap_or(data.len());
    String::from_utf8_lossy(&data[..end]).to_string()
}

/// Helper to write a string to a fixed-size buffer (null-padded)
fn write_fixed_string(dest: &mut [u8], s: &str) {
    dest.fill(0);
    let bytes = s.as_bytes();
    let len = bytes.len().min(dest.len() - 1);
    dest[..len].copy_from_slice(&bytes[..len]);
}

/// Client-side p9sk1 state machine
pub struct P9sk1Client {
    pub user: String,
    pub password: String,
    key: [u8; DESSION],
}

impl P9sk1Client {
    pub fn new(user: &str, password: &str) -> Self {
        let key = pass_to_key(password);
        Self {
            user: user.to_string(),
            password: password.to_string(),
            key,
        }
    }

    /// Get the DES key derived from password
    pub fn get_key(&self) -> &[u8; DESSION] {
        &self.key
    }

    /// Decrypt the client ticket from auth server response
    pub fn decrypt_client_ticket(&self, encrypted: &[u8; TICKETLEN]) -> Ticket {
        decrypt_ticket(encrypted, &self.key)
    }

    /// Build authenticator to send to server
    /// challenge should be server's challenge with byte[0] incremented
    pub fn make_client_authenticator(
        &self,
        ticket: &Ticket,
        server_challenge: &[u8; CHALLEN],
        id: u32,
    ) -> [u8; AUTHENTLEN] {
        // Increment first byte of challenge for authenticator
        let mut auth_challenge = *server_challenge;
        auth_challenge[0] = auth_challenge[0].wrapping_add(1);

        make_authenticator(AUTH_AC, &auth_challenge, id, &ticket.key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pass_to_key_simple() {
        // Simple password
        let key = pass_to_key("password");
        assert_eq!(key.len(), 7);

        // Should be deterministic
        let key2 = pass_to_key("password");
        assert_eq!(key, key2);

        // Different password should give different key
        let key3 = pass_to_key("different");
        assert_ne!(key, key3);
    }

    #[test]
    fn test_pass_to_key_empty() {
        // Empty password should work (all spaces)
        let key = pass_to_key("");
        assert_eq!(key.len(), 7);
    }

    #[test]
    fn test_pass_to_key_long() {
        // Long password (uses iterative encryption)
        let key = pass_to_key("this is a very long password that exceeds 8 characters");
        assert_eq!(key.len(), 7);
    }

    #[test]
    fn test_fixed_string_roundtrip() {
        let mut buf = [0u8; ANAMELEN];
        write_fixed_string(&mut buf, "testuser");
        let result = read_fixed_string(&buf);
        assert_eq!(result, "testuser");
    }

    #[test]
    fn test_ticket_request_format() {
        let challenge = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08];
        let req = make_ticket_request("authserver", "9front.local", &challenge, "cpuserver", "glenda");

        assert_eq!(req[0], AUTH_TREQ);
        assert_eq!(req.len(), 141);

        // Verify challenge is in the right place
        assert_eq!(
            &req[1 + ANAMELEN + DOMLEN..1 + ANAMELEN + DOMLEN + CHALLEN],
            &challenge
        );
    }

    #[test]
    fn test_authenticator_roundtrip() {
        let session_key: [u8; 7] = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77];
        let challenge: [u8; 8] = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08];
        let id = 12345u32;

        let encrypted = make_authenticator(AUTH_AC, &challenge, id, &session_key);
        let decrypted = decrypt_authenticator(&encrypted, &session_key);

        assert_eq!(decrypted.auth_type, AUTH_AC);
        assert_eq!(decrypted.challenge, challenge);
        assert_eq!(decrypted.id, id);
    }

    #[test]
    fn test_ticket_decrypt() {
        // Create a fake ticket, encrypt it, then decrypt
        let key: [u8; 7] = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77];
        let session_key: [u8; 7] = [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00];
        let challenge: [u8; 8] = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08];

        // Build plaintext ticket
        let mut ticket = [0u8; TICKETLEN];
        ticket[0] = AUTH_TC;
        ticket[1..9].copy_from_slice(&challenge);
        write_fixed_string(&mut ticket[9..9 + ANAMELEN], "glenda");
        write_fixed_string(&mut ticket[9 + ANAMELEN..9 + 2 * ANAMELEN], "cpuserver");
        ticket[9 + 2 * ANAMELEN..].copy_from_slice(&session_key);

        // Encrypt
        des9::plan9_encrypt(&key, &mut ticket);

        // Decrypt and verify
        let decrypted = decrypt_ticket(&ticket, &key);
        assert_eq!(decrypted.ticket_type, AUTH_TC);
        assert_eq!(decrypted.challenge, challenge);
        assert_eq!(decrypted.cuid, "glenda");
        assert_eq!(decrypted.suid, "cpuserver");
        assert_eq!(decrypted.key, session_key);
    }

    // Test vectors from Nawin.Auth - verifies interoperability with working C# implementation
    #[test]
    fn test_pass_to_key_interop() {
        // These values were generated by Nawin.Auth's PassToKey function
        let test_vectors: &[(&str, &str)] = &[
            ("", "00100804028140"),
            ("glenda", "6776d94d0e0340"),
            ("password", "f0f07c7e7fcbc9"),
            ("p", "70000804028140"),
            ("12345678", "31d98c56b3dd70"),
            ("this is a long password", "0230f8b49e8dde"),
        ];

        for (password, expected_hex) in test_vectors {
            let key = pass_to_key(password);
            let actual_hex = hex::encode(key);
            assert_eq!(
                actual_hex, *expected_hex,
                "PassToKey mismatch for password {:?}: expected {}, got {}",
                password, expected_hex, actual_hex
            );
        }
    }
}
