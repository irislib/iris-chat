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
    let records_path = core.join("src/core/device_sync/records.rs");
    let history_path = core.join("src/core/device_sync/history.rs");
    let model_path = core.join("src/core/model.rs");
    let mute_path = core.join("src/core/chat_mute_sync.rs");
    let pin_path = core.join("src/core/chat_pin_sync.rs");
    let label_path = core.join("src/core/private_device_labels.rs");
    let private_contact_path = core.join("src/private_contact_sync_v2.rs");
    for path in [
        &protocol_path,
        &tcp_path,
        &framing_path,
        &body_path,
        &history_path,
        &records_path,
        &model_path,
        &label_path,
        &private_contact_path,
        &mute_path,
        &pin_path,
    ] {
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
    let contract = format!(
        "{}\n{}\n{}\n{}",
        derived_item(&read(model_path), "struct ChatReadState").replace("pub(super) ", ""),
        derived_item(&read(mute_path), "struct ChatMuteState").replace("pub(crate) ", ""),
        derived_item(&read(pin_path), "struct ChatPinState").replace("pub(crate) ", ""),
        protocol[contract_start..contract_end]
            .replace("super::private_device_labels::PrivateDeviceLabel", "crate::private_device_labels::PrivateDeviceLabel"),
    );

    let framing = read(framing_path);
    let framing_start = framing
        .find("pub(super) struct RecordReader")
        .expect("RecordReader");
    let frame_at = framing.find("pub(super) fn frame").expect("frame function");
    let framing_end = item_end(&framing, frame_at);

    let out = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR"));
    let records = read(records_path);
    let record_types = derived_items(&records, "enum RecordScope", "struct DeviceSyncGroupSettings").replace("pub(super) ", "");
    let methods = ["pub(super) fn id", "pub(super) fn timestamp", "pub(super) fn scope"].map(|name| {
        let start = records.find(name).expect("native typed record method");
        records[start..item_end(&records, start)].replace("pub(super) ", "")
    }).join("\n");
    fs::write(out.join("native_records.rs"), format!("{record_types}\nimpl DeviceSyncRecord {{\n{methods}\n}}"))
        .expect("write native typed record declarations");
    let history = read(history_path);
    let record_at = history.find("pub(super) fn record_id").expect("native history record identity");
    fs::write(out.join("native_history_record.rs"), history[record_at..item_end(&history, record_at)].replace("pub(super) ", ""))
        .expect("write native history record identity");
    fs::write(out.join("native_contract.rs"), contract).expect("write contract");
    // Preserve the production wire declarations and aliases verbatim, without
    // importing the unrelated event encryption and storage implementation.
    fs::write(
        out.join("native_private_contacts.rs"),
        derived_items(
            &read(private_contact_path),
            "struct PrivateContactRegisterV2",
            "struct PrivateContactDocumentV2",
        ),
    )
    .expect("write private contact contract");
    let labels = read(label_path);
    let label_fn = labels.find("fn required_label").expect("native label deserializer");
    fs::write(
        out.join("native_private_device_labels.rs"),
        format!("{}\n{}", derived_item(&labels, "struct PrivateDeviceLabel"),
            &labels[label_fn..item_end(&labels, label_fn)]),
    ).expect("write private device label contract");
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

fn derived_item<'a>(source: &'a str, name: &str) -> &'a str {
    derived_items(source, name, name)
}

fn derived_items<'a>(source: &'a str, first: &str, last: &str) -> &'a str {
    let item = source
        .find(first)
        .unwrap_or_else(|| panic!("missing native {first}"));
    let start = source[..item].rfind("#[derive").expect("item derive");
    let end = source[item..]
        .find(last)
        .map(|offset| item + offset)
        .unwrap_or_else(|| panic!("missing native {last}"));
    &source[start..item_end(source, end)]
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
