use std::{env, fs, path::PathBuf};

fn main() {
    let core = PathBuf::from(
        env::var("IRIS_CHAT_RS_CORE_DIR")
            .expect("IRIS_CHAT_RS_CORE_DIR must point to the iris-chat-rs core crate"),
    );
    let protocol_path = core.join("src/core/device_sync.rs");
    let tcp_path = core.join("src/core/device_sync_tcp.rs");
    let framing_path = core.join("src/core/device_sync_tcp/framing.rs");
    let body_path = core.join("src/core/device_sync/body.rs");
    for path in [&protocol_path, &tcp_path, &framing_path, &body_path] {
        println!("cargo:rerun-if-changed={}", path.display());
    }
    println!("cargo:rerun-if-env-changed=IRIS_CHAT_RS_CORE_DIR");
    println!("cargo:rustc-env=IRIS_CHAT_RS_CORE_DIR={}", core.display());

    let protocol = read(protocol_path);
    let tcp = read(tcp_path);
    assert!(
        tcp.contains("frame, random_isn_seed, RecordReader"),
        "native TCP source no longer consumes the expected framing module"
    );

    let enum_at = protocol
        .find("enum DeviceSyncPacket")
        .expect("DeviceSyncPacket enum");
    let contract_start = protocol[..enum_at]
        .rfind("#[derive")
        .expect("packet derive");
    let page_at = protocol
        .find("enum DeviceSyncPage")
        .expect("DeviceSyncPage enum");
    let contract_end = item_end(&protocol, page_at);
    let contract = &protocol[contract_start..contract_end];

    let framing = read(framing_path);
    let framing_start = framing
        .find("pub(super) struct RecordReader")
        .expect("RecordReader");
    let frame_at = framing.find("pub(super) fn frame").expect("frame function");
    let framing_end = item_end(&framing, frame_at);

    let out = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR"));
    fs::write(out.join("native_contract.rs"), contract).expect("write contract");
    fs::write(
        out.join("native_framing.rs"),
        framing[framing_start..framing_end].replace("pub(super) ", ""),
    )
    .expect("write framing");
    fs::write(
        out.join("native_constants.rs"),
        [
            constant(&protocol, "DEVICE_SYNC_PORT"),
            constant(&protocol, "DEVICE_SYNC_MAX_PACKET_BYTES"),
            constant(&protocol, "DEVICE_SYNC_PAGE_MESSAGES"),
            constant(&protocol, "DEVICE_SYNC_PAGE_PACKETS"),
            constant(&tcp, "FRAME_HEADER_BYTES"),
        ]
        .join("\n"),
    )
    .expect("write constants");
}

fn read(path: PathBuf) -> String {
    fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}

fn constant(source: &str, name: &str) -> String {
    source
        .lines()
        .find(|line| line.contains(&format!("const {name}:")))
        .unwrap_or_else(|| panic!("missing native constant {name}"))
        .trim()
        .replace("pub(super) ", "")
        .to_string()
}

fn item_end(source: &str, start: usize) -> usize {
    let open = source[start..]
        .find('{')
        .map(|offset| start + offset)
        .expect("item body");
    let mut depth = 0_u32;
    for (offset, byte) in source.as_bytes()[open..].iter().enumerate() {
        match byte {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return open + offset + 1;
                }
            }
            _ => {}
        }
    }
    panic!("unterminated Rust item")
}
