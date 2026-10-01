//! A JSON-line driver around unchanged native offer validation and FIPS-TCP code.
//! All keys and files belong to the test; only the loopback seed is configured.
use base64::{engine::general_purpose::STANDARD, Engine};
use direct_file_tcp::{DirectFileEvent, TransferFile};
use fips_core::{
    config::{TransportInstances, WebSocketConfig},
    FipsEndpoint, PeerIdentity,
};
use nostr::{Keys, ToBech32};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, BufRead, Write},
    path::PathBuf,
    sync::Arc,
};

include!(concat!(env!("OUT_DIR"), "/native.rs"));

fn emit(value: Value) {
    println!("{value}");
    io::stdout().flush().unwrap();
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key].as_str().ok_or_else(|| format!("Missing {key}"))
}
fn peer(value: &str) -> Result<PeerIdentity, String> {
    let public = nostr::PublicKey::from_hex(value).map_err(|e| e.to_string())?;
    PeerIdentity::from_npub(&public.to_bech32().map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    let seed = args.get(1).ok_or("Loopback seed required")?;
    if !seed.starts_with("ws://127.0.0.1:") {
        return Err("Only a local test seed is allowed".into());
    }
    let directory = PathBuf::from(args.get(2).ok_or("Test directory required")?);
    fs::create_dir_all(directory.join("source"))?;
    fs::create_dir_all(directory.join("received"))?;
    let keys = if let Some(secret) = args.get(3) {
        Keys::parse(secret)?
    } else {
        Keys::generate()
    };
    let device = keys.public_key().to_hex();
    let mut config = fips_core::Config::new();
    config.node.control.enabled = false;
    config.node.discovery.lan.enabled = false;
    config.node.discovery.nostr.enabled = false;
    config.node.routing.mode = fips_core::config::RoutingMode::ReplyLearned;
    config.transports.udp = TransportInstances::default();
    config.transports.websocket = TransportInstances::Single(WebSocketConfig {
        seed_urls: vec![seed.clone()],
        ..Default::default()
    });
    let endpoint = Arc::new(
        FipsEndpoint::builder()
            .config(config)
            .identity_nsec(keys.secret_key().to_secret_hex())
            .without_system_tun()
            .bind()
            .await?,
    );
    let (event_tx, events) = flume::unbounded();
    let (sender, task) = direct_file_tcp::start_direct_file_tcp(endpoint.clone(), event_tx).await?;
    let (commands_tx, commands) = flume::unbounded();
    std::thread::spawn(move || {
        for line in io::stdin().lock().lines().map_while(Result::ok) {
            if commands_tx.send(line).is_err() {
                break;
            }
        }
    });
    emit(json!({"type":"ready","device":device}));
    loop {
        tokio::select! {
            event = events.recv_async() => {
                let Ok(event) = event else { break };
                emit(match event {
                    DirectFileEvent::Accepted { transfer_id, peer } => json!({"type":"accepted","id":transfer_id,"peer":peer}),
                    DirectFileEvent::Progress { transfer_id, peer, transferred_bytes, total_bytes } => json!({"type":"progress","id":transfer_id,"peer":peer,"transferredBytes":transferred_bytes,"totalBytes":total_bytes}),
                    DirectFileEvent::Completed { transfer_id, peer, local_paths } => {
                        let files: Vec<_> = local_paths.iter().map(|path| { let bytes=fs::read(path).unwrap(); json!({"path":path,"bytes":STANDARD.encode(&bytes),"sha256":format!("{:x}",Sha256::digest(&bytes))}) }).collect();
                        json!({"type":"completed","id":transfer_id,"peer":peer,"files":files})
                    }
                    DirectFileEvent::Failed { transfer_id, peer, error } => json!({"type":"failed","id":transfer_id,"peer":peer,"error":error}),
                    DirectFileEvent::Declined { transfer_id, peer } => json!({"type":"declined","id":transfer_id,"peer":peer}),
                    DirectFileEvent::Cancelled { transfer_id, peer } => json!({"type":"cancelled","id":transfer_id,"peer":peer}),
                });
            }
            line = commands.recv_async() => {
                let Ok(line) = line else { break };
                let command: Value = serde_json::from_str(&line)?;
                let result = if command["op"] == "peers" {
                    endpoint.peers().await.map(|peers| json!(peers.into_iter().map(|peer| json!({"npub":peer.npub,"connected":peer.connected})).collect::<Vec<_>>())).map_err(|e|e.to_string())
                } else { execute(&command, &directory, &keys, &sender) };
                emit(match result { Ok(value) => json!({"type":"reply","requestId":command["requestId"],"value":value}), Err(error) => json!({"type":"reply","requestId":command["requestId"],"error":error}) });
            }
        }
    }
    task.abort();
    endpoint.shutdown().await?;
    Ok(())
}

fn execute(
    command: &Value,
    directory: &std::path::Path,
    keys: &Keys,
    sender: &direct_file_tcp::DirectFileSender,
) -> Result<Value, String> {
    match text(command, "op")? {
        "offer" => {
            let files = command["files"]
                .as_array()
                .ok_or("Missing files")?
                .iter()
                .enumerate()
                .map(|(index, file)| {
                    let filename = text(file, "filename")?.to_owned();
                    let bytes = STANDARD
                        .decode(text(file, "bytes")?)
                        .map_err(|e| e.to_string())?;
                    let path = directory.join("source").join(index.to_string());
                    fs::write(&path, &bytes).map_err(|e| e.to_string())?;
                    Ok(TransferFile {
                        filename,
                        size_bytes: bytes.len() as u64,
                        sha256: format!("{:x}", Sha256::digest(&bytes)),
                        path,
                    })
                })
                .collect::<Result<Vec<_>, String>>()?;
            let offer = model::Offer {
                id: text(command, "id")?.into(),
                token: text(command, "token")?.into(),
                owner: text(command, "owner")?.into(),
                recipient: text(command, "recipient")?.into(),
                device: keys.public_key().to_hex(),
                caption: "Native direct files".into(),
                expires_at_secs: nostr::Timestamp::now().as_secs() + 3600,
                files: files
                    .iter()
                    .map(|file| model::ManifestFile {
                        filename: file.filename.clone(),
                        size_bytes: file.size_bytes,
                        sha256: file.sha256.clone(),
                    })
                    .collect(),
            };
            sender.register_offer(
                offer.id.clone(),
                offer.token.clone(),
                vec![peer(text(command, "peer")?)?],
                files,
            )?;
            Ok(json!({"body":offer.wire(keys)?,"offer":offer}))
        }
        "receive" => {
            let offer = model::parse(text(command, "body")?)
                .ok_or("Native parser rejected signed browser offer")?;
            sender.receive(
                offer.id.clone(),
                offer.token.clone(),
                peer(&offer.device)?,
                offer.transport_files(&[]),
                directory.join("received"),
            )?;
            Ok(
                json!({"id":offer.id,"device":offer.device,"owner":offer.owner,"recipient":offer.recipient}),
            )
        }
        "parse" => Ok(serde_json::to_value(
            model::parse(text(command, "body")?)
                .ok_or("Native parser rejected signed browser offer")?,
        )
        .map_err(|e| e.to_string())?),
        "receivedBytes" => Ok(json!(received_bytes(&directory.join("received"))?)),
        "cancel" => {
            sender.cancel(text(command, "id")?)?;
            Ok(json!(true))
        }
        _ => Err("Unknown operation".into()),
    }
}
fn received_bytes(path: &std::path::Path) -> Result<u64, String> {
    let mut total = 0;
    for item in fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = item.map_err(|e| e.to_string())?;
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        total += if metadata.is_dir() {
            received_bytes(&entry.path())?
        } else {
            metadata.len()
        };
    }
    Ok(total)
}
