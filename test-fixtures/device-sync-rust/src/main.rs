use std::{
    env,
    error::Error,
    io::{self, Read, Write},
};

use serde::{Deserialize, Serialize};

include!(concat!(env!("OUT_DIR"), "/native_constants.rs"));

mod body {
    include!(concat!(
        env!("IRIS_CHAT_RS_CORE_DIR"),
        "/src/core/device_sync/body.rs"
    ));
}

include!(concat!(env!("OUT_DIR"), "/native_contract.rs"));
include!(concat!(env!("OUT_DIR"), "/native_framing.rs"));

fn main() -> Result<(), Box<dyn Error>> {
    let operation = env::args().nth(1).unwrap_or_else(|| "contract".to_string());
    if operation == "contract" {
        println!(
            "{{\"port\":{DEVICE_SYNC_PORT},\"maxPacketBytes\":{DEVICE_SYNC_MAX_PACKET_BYTES},\"pageMessages\":{DEVICE_SYNC_PAGE_MESSAGES},\"pagePackets\":{DEVICE_SYNC_PAGE_PACKETS},\"frameHeaderBytes\":{FRAME_HEADER_BYTES}}}"
        );
        return Ok(());
    }

    let mut input = Vec::new();
    io::stdin().read_to_end(&mut input)?;
    match operation.as_str() {
        "roundtrip" => write_packet(roundtrip(&input)?),
        "frame" => write_packet(frame(&roundtrip(&input)?)),
        "read" => {
            let split = env::args()
                .nth(2)
                .and_then(|value| value.parse().ok())
                .unwrap_or(input.len().max(1));
            let mut reader = RecordReader::new(DEVICE_SYNC_MAX_PACKET_BYTES);
            let mut records = Vec::new();
            for chunk in input.chunks(split) {
                records.extend(reader.push(chunk).map_err(|_| "native frame rejected")?);
            }
            if !reader.bytes.is_empty() {
                return Err("native frame is truncated".into());
            }
            if records.len() != 1 {
                return Err(format!("expected one native record, got {}", records.len()).into());
            }
            write_packet(roundtrip(&records.remove(0))?)
        }
        _ => Err(format!("unknown operation {operation}").into()),
    }
}

fn roundtrip(input: &[u8]) -> Result<Vec<u8>, Box<dyn Error>> {
    if input.len() > DEVICE_SYNC_MAX_PACKET_BYTES {
        return Err("native packet exceeds 64 KiB".into());
    }
    let packet = serde_json::from_slice::<DeviceSyncPacket>(input)?;
    Ok(serde_json::to_vec(&packet)?)
}

fn write_packet(bytes: Vec<u8>) -> Result<(), Box<dyn Error>> {
    io::stdout().write_all(&bytes)?;
    Ok(())
}
