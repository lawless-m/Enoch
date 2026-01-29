//! Test authentication against a real auth server
//!
//! Usage: cargo run --example auth_test

use std::io::{Read, Write};
use std::net::TcpStream;

// Re-use constants from the crate
const ANAMELEN: usize = 28;
const DOMLEN: usize = 48;
const CHALLEN: usize = 8;
const TICKETLEN: usize = 72;

const AUTH_TREQ: u8 = 1;
const AUTH_PAK: u8 = 19;
const AUTH_OK: u8 = 4;
const AUTH_ERR: u8 = 5;

fn main() {
    let username = "glenda";
    let password = "testZ1234";

    // Skip p9sk1, go straight to dp9ik
    let authdoms: [&str; 0] = [];

    println!("=== Enoch Auth Server Test ===");
    println!("Connecting to localhost:567...");

    // Derive DES key from password
    let des_key = enoch_auth::pass_to_key(password);
    println!("DES key derived: {:02x?}", des_key);

    // Derive PAK hash for dp9ik
    let pak_hash = enoch_auth::authpak_hash(password, username);
    println!("PAK hash derived ({} bytes)", pak_hash.len());

    // Try each auth domain
    for authdom in &authdoms {
        println!("\n--- Trying authdom: '{}' ---", authdom);

        match try_p9sk1_auth(username, password, authdom, &des_key) {
            Ok(()) => {
                println!("SUCCESS with authdom '{}'!", authdom);
                return;
            }
            Err(e) => {
                println!("Failed: {}", e);
            }
        }
    }

    println!("\n--- Trying dp9ik (AuthPAK) ---");
    let dp9ik_authdoms = ["nawin"];
    for authdom in &dp9ik_authdoms {
        println!("\n--- Trying dp9ik with authdom: '{}' ---", authdom);

        match try_dp9ik_auth(username, &pak_hash, authdom) {
            Ok(()) => {
                println!("dp9ik SUCCESS with authdom '{}'!", authdom);
                return;
            }
            Err(e) => {
                println!("dp9ik Failed: {}", e);
            }
        }
    }

    println!("\nAll attempts failed.");
}

fn try_p9sk1_auth(username: &str, _password: &str, authdom: &str, des_key: &[u8; 7]) -> Result<(), String> {
    let mut stream = TcpStream::connect("localhost:567")
        .map_err(|e| format!("Connect failed: {}", e))?;

    stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).ok();
    stream.set_nodelay(true).ok();

    // Build ticket request
    // type[1] + authid[28] + authdom[48] + chal[8] + hostid[28] + uid[28] = 141
    let mut treq = [0u8; 141];
    treq[0] = AUTH_TREQ;

    // authid - use username as auth identity
    write_fixed_string(&mut treq[1..1 + ANAMELEN], username);

    // authdom
    write_fixed_string(&mut treq[1 + ANAMELEN..1 + ANAMELEN + DOMLEN], authdom);

    // challenge - random 8 bytes
    let challenge: [u8; CHALLEN] = rand_bytes();
    treq[1 + ANAMELEN + DOMLEN..1 + ANAMELEN + DOMLEN + CHALLEN].copy_from_slice(&challenge);

    // hostid - use username for simple test
    write_fixed_string(
        &mut treq[1 + ANAMELEN + DOMLEN + CHALLEN..1 + ANAMELEN + DOMLEN + CHALLEN + ANAMELEN],
        username,
    );

    // uid
    write_fixed_string(
        &mut treq[1 + ANAMELEN + DOMLEN + CHALLEN + ANAMELEN..],
        username,
    );

    println!("Sending ticket request ({} bytes)...", treq.len());
    stream.write_all(&treq).map_err(|e| format!("Write failed: {}", e))?;
    stream.flush().map_err(|e| format!("Flush failed: {}", e))?;

    // Read response
    let mut status = [0u8; 1];
    stream.read_exact(&mut status).map_err(|e| format!("Read status failed: {}", e))?;

    match status[0] {
        AUTH_OK => {
            println!("Got AUTH_OK!");

            // Read two tickets
            let mut client_ticket = [0u8; TICKETLEN];
            let mut server_ticket = [0u8; TICKETLEN];

            stream.read_exact(&mut client_ticket).map_err(|e| format!("Read client ticket failed: {}", e))?;
            stream.read_exact(&mut server_ticket).map_err(|e| format!("Read server ticket failed: {}", e))?;

            println!("Received tickets!");
            println!("Client ticket (encrypted): {:02x?}...", &client_ticket[..16]);
            println!("Server ticket (encrypted): {:02x?}...", &server_ticket[..16]);

            println!("\n=== DES Self-test ===");
            // First verify our DES works by round-tripping
            let test_data = b"Hello, Plan 9!!"; // 15 bytes
            let mut test_buf = test_data.to_vec();
            println!("Original:  {:02x?}", &test_buf);
            enoch_auth::des9::plan9_encrypt(des_key, &mut test_buf);
            println!("Encrypted: {:02x?}", &test_buf);
            enoch_auth::des9::plan9_decrypt(des_key, &mut test_buf);
            println!("Decrypted: {:02x?}", &test_buf);
            println!("Round-trip OK: {}", test_buf == test_data);

            println!("\n=== Ticket Decryption ===");
            println!("DES key: {:02x?}", des_key);
            println!("Client ticket raw ({} bytes): {:02x?}", client_ticket.len(), &client_ticket);

            // Try to decrypt client ticket
            let mut decrypted = client_ticket;
            enoch_auth::des9::plan9_decrypt(des_key, &mut decrypted);

            println!("Decrypted ticket: {:02x?}", &decrypted);
            println!("\nParsed fields:");
            println!("  Type: {} (expected 65 = AUTH_TC)", decrypted[0]);
            println!("  Challenge: {:02x?}", &decrypted[1..9]);
            println!("  Our challenge was: {:02x?}", &challenge);
            println!("  cuid bytes: {:02x?}", &decrypted[9..9 + ANAMELEN]);
            println!("  suid bytes: {:02x?}", &decrypted[9 + ANAMELEN..9 + 2 * ANAMELEN]);
            println!("  Session key: {:02x?}", &decrypted[9 + 2 * ANAMELEN..]);

            // Verify challenge matches
            if decrypted[1..9] == challenge {
                println!("\nChallenge MATCHES - authentication successful!");
            } else {
                println!("\nChallenge MISMATCH - trying encrypt instead of decrypt...");
                let mut try_encrypt = client_ticket;
                enoch_auth::des9::plan9_encrypt(des_key, &mut try_encrypt);
                println!("With encrypt: type={}, chal={:02x?}", try_encrypt[0], &try_encrypt[1..9]);
            }

            Ok(())
        }
        AUTH_ERR => {
            let mut error_buf = [0u8; 64];
            stream.read_exact(&mut error_buf).map_err(|e| format!("Read error msg failed: {}", e))?;
            let error_msg = read_fixed_string(&error_buf);
            Err(format!("AUTH_ERR: {}", error_msg))
        }
        other => {
            Err(format!("Unexpected response type: {}", other))
        }
    }
}

fn try_dp9ik_auth(username: &str, pak_hash: &[u8; 448], authdom: &str) -> Result<(), String> {
    let mut stream = TcpStream::connect("localhost:567")
        .map_err(|e| format!("Connect failed: {}", e))?;

    stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).ok();
    stream.set_nodelay(true).ok();

    // Build AuthPAK request (same format as ticket request but type=19)
    // Note: If both authid and hostid are set, server does TWO PAK exchanges.
    // Clear authid to do only one PAK exchange for hostid.
    let mut treq = [0u8; 141];
    treq[0] = AUTH_PAK;

    write_fixed_string(&mut treq[1..1 + ANAMELEN], "");  // authid empty
    write_fixed_string(&mut treq[1 + ANAMELEN..1 + ANAMELEN + DOMLEN], authdom);

    let challenge: [u8; CHALLEN] = rand_bytes();
    treq[1 + ANAMELEN + DOMLEN..1 + ANAMELEN + DOMLEN + CHALLEN].copy_from_slice(&challenge);

    write_fixed_string(
        &mut treq[1 + ANAMELEN + DOMLEN + CHALLEN..1 + ANAMELEN + DOMLEN + CHALLEN + ANAMELEN],
        username,
    );
    write_fixed_string(
        &mut treq[1 + ANAMELEN + DOMLEN + CHALLEN + ANAMELEN..],
        username,
    );

    println!("Sending AuthPAK request...");
    stream.write_all(&treq).map_err(|e| format!("Write failed: {}", e))?;
    stream.flush().map_err(|e| format!("Flush failed: {}", e))?;

    // Read response
    let mut status = [0u8; 1];
    stream.read_exact(&mut status).map_err(|e| format!("Read status failed: {}", e))?;

    if status[0] == AUTH_ERR {
        let mut error_buf = [0u8; 64];
        stream.read_exact(&mut error_buf).map_err(|e| format!("Read error msg failed: {}", e))?;
        return Err(format!("AUTH_ERR: {}", read_fixed_string(&error_buf)));
    }

    if status[0] != AUTH_OK {
        return Err(format!("Unexpected response: {}", status[0]));
    }

    println!("Got AUTH_OK for PAK, reading server Y...");

    // Read server's Y value (56 bytes)
    let mut server_y = [0u8; 56];
    stream.read_exact(&mut server_y).map_err(|e| format!("Read server Y failed: {}", e))?;
    println!("Server Y: {:02x?}...", &server_y[..16]);

    // Generate our Y and send it
    let pak_hash_arr: &[u8; 448] = pak_hash;
    let client_priv = enoch_auth::authpak_new(pak_hash_arr, true);

    println!("Sending client Y...");
    stream.write_all(&client_priv.y).map_err(|e| format!("Write client Y failed: {}", e))?;
    stream.flush().map_err(|e| format!("Flush failed: {}", e))?;

    // Complete PAK to get shared key
    let pak_key = enoch_auth::authpak_finish(&client_priv, pak_hash_arr, &server_y)
        .map_err(|e| format!("PAK finish failed: {}", e))?;
    println!("PAK key derived: {:02x?}", pak_key);

    // Now send ticket request
    treq[0] = AUTH_TREQ;
    println!("Sending ticket request...");
    stream.write_all(&treq).map_err(|e| format!("Write treq failed: {}", e))?;
    stream.flush().map_err(|e| format!("Flush failed: {}", e))?;

    // Read response
    stream.read_exact(&mut status).map_err(|e| format!("Read status2 failed: {}", e))?;

    if status[0] == AUTH_ERR {
        let mut error_buf = [0u8; 64];
        stream.read_exact(&mut error_buf).map_err(|e| format!("Read error msg failed: {}", e))?;
        return Err(format!("AUTH_ERR on treq: {}", read_fixed_string(&error_buf)));
    }

    if status[0] != AUTH_OK {
        // Try to read more to see what's happening
        let mut extra = [0u8; 128];
        let n = stream.read(&mut extra).unwrap_or(0);
        return Err(format!("Unexpected treq response: {} (0x{:02x}), extra {} bytes: {:02x?}",
            status[0], status[0], n, &extra[..n.min(32)]));
    }

    println!("Got AUTH_OK for tickets!");

    // Read dp9ik tickets (124 bytes each)
    let mut client_ticket = [0u8; 124];
    let mut server_ticket = [0u8; 124];

    stream.read_exact(&mut client_ticket).map_err(|e| format!("Read dp9ik client ticket failed: {}", e))?;
    stream.read_exact(&mut server_ticket).map_err(|e| format!("Read dp9ik server ticket failed: {}", e))?;

    println!("Received dp9ik tickets!");
    println!("Client ticket ({} bytes): {:02x?}", client_ticket.len(), &client_ticket);
    println!("Server ticket ({} bytes): {:02x?}", server_ticket.len(), &server_ticket);

    // Decrypt client ticket with ChaCha20-Poly1305
    // Format: sig[8] + counter[4] + encrypted[96] + tag[16] = 124 bytes
    use chacha20poly1305::{ChaCha20Poly1305, KeyInit, aead::Aead};
    use chacha20poly1305::aead::generic_array::GenericArray;

    let sig = &client_ticket[..8];
    let counter = &client_ticket[8..12];
    let ciphertext_and_tag = &client_ticket[12..];  // 112 bytes (96 + 16)

    println!("\nClient ticket structure:");
    println!("  Signature: {} (expected 'form1 Tc')", String::from_utf8_lossy(sig));
    println!("  Counter: {:02x?}", counter);
    println!("  Ciphertext+tag: {} bytes", ciphertext_and_tag.len());

    // Nonce = sig[8] + counter[4] = 12 bytes
    let mut nonce = [0u8; 12];
    nonce[..8].copy_from_slice(sig);
    nonce[8..12].copy_from_slice(counter);

    let cipher = ChaCha20Poly1305::new(GenericArray::from_slice(&pak_key));
    match cipher.decrypt(GenericArray::from_slice(&nonce), ciphertext_and_tag) {
        Ok(plaintext) => {
            println!("\n=== DECRYPTED CLIENT TICKET ===");
            println!("Plaintext ({} bytes): {:02x?}", plaintext.len(), &plaintext);
            // Format: chal[8] + cuid[28] + suid[28] + key[32] = 96 bytes
            if plaintext.len() >= 96 {
                println!("  Challenge: {:02x?}", &plaintext[..8]);
                println!("  Our challenge was: {:02x?}", &challenge);
                println!("  cuid: {}", String::from_utf8_lossy(&plaintext[8..8+28]).trim_end_matches('\0'));
                println!("  suid: {}", String::from_utf8_lossy(&plaintext[8+28..8+56]).trim_end_matches('\0'));
                println!("  Session key: {:02x?}", &plaintext[8+56..]);

                if plaintext[..8] == challenge {
                    println!("\n*** CHALLENGE MATCHES - AUTHENTICATION SUCCESSFUL! ***");
                } else {
                    println!("\nChallenge mismatch");
                }
            }
        }
        Err(e) => {
            println!("Decryption failed: {:?}", e);
        }
    }

    println!("\ndp9ik protocol exchange completed successfully!");
    Ok(())
}

fn write_fixed_string(dest: &mut [u8], value: &str) {
    dest.fill(0);
    let bytes = value.as_bytes();
    let len = bytes.len().min(dest.len() - 1);
    dest[..len].copy_from_slice(&bytes[..len]);
}

fn read_fixed_string(data: &[u8]) -> String {
    let end = data.iter().position(|&b| b == 0).unwrap_or(data.len());
    String::from_utf8_lossy(&data[..end]).to_string()
}

fn rand_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    getrandom::getrandom(&mut buf).expect("Failed to get random bytes");
    buf
}
