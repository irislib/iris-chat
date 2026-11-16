use std::{env, fs, path::PathBuf};

fn main() {
    let core =
        PathBuf::from(env::var("IRIS_CHAT_RS_CORE_DIR").expect("Select the native core source"));
    let manifest = core.join("Cargo.toml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-check-cfg=cfg(shared_file_engine)");
    let shared_engine = fs::read_to_string(manifest).unwrap().lines().any(|line| {
        line.split_once('=')
            .is_some_and(|(name, _)| name.trim() == "nvpn-fips-file-transfer")
    });
    if shared_engine {
        println!("cargo:rustc-cfg=shared_file_engine");
    }
    let mut modules = String::new();
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    for (name, file) in [
        ("direct_file_tcp", "src/core/direct_file_tcp.rs"),
        ("model", "src/core/direct_files/model.rs"),
    ] {
        let path = core
            .join(file)
            .canonicalize()
            .expect("Native direct-file source");
        println!("cargo:rerun-if-changed={}", path.display());
        let path = if name == "direct_file_tcp" && !shared_engine {
            let dir = out.join(name);
            fs::create_dir_all(&dir).unwrap();
            for child in fs::read_dir(path.with_extension("")).unwrap() {
                let child = child.unwrap().path();
                if child.extension().is_some_and(|ext| ext == "rs") {
                    println!("cargo:rerun-if-changed={}", child.display());
                    fs::copy(&child, dir.join(child.file_name().unwrap())).unwrap();
                }
            }
            let module = dir.join("mod.rs");
            fs::copy(path, &module).unwrap();
            module
        } else {
            path
        };
        modules.push_str(&format!("#[path = {:?}] mod {name};\n", path));
    }

    // Use the production validators and selected-destination implementation.
    // Only the foreign-language bindings are omitted from this standalone driver.
    for name in ["direct_files", "direct_file_destination"] {
        let path = core.join(format!("src/{name}.rs"));
        println!("cargo:rerun-if-changed={}", path.display());
        let mut source = fs::read_to_string(path)
            .unwrap()
            .replace("uniffi::Enum, ", "")
            .replace("uniffi::Record, ", "")
            .replace(", uniffi::Error", "")
            .replace("#[uniffi::export(with_foreign)]", "")
            .replace("#[uniffi::export]", "");
        if name == "direct_file_destination" {
            let start = source
                .find("impl From<uniffi::UnexpectedUniFFICallbackError>")
                .unwrap();
            let end = source[start..].find("impl From<std::io::Error>").unwrap() + start;
            source.replace_range(start..end, "");
        }
        let copied = out.join(format!("{name}.rs"));
        fs::write(&copied, source).unwrap();
        modules.push_str(&format!("#[path = {:?}] mod {name};\n", copied));
    }
    modules.push_str("pub use direct_files::{DirectFileSnapshot, DirectFileTransferStatus};\n");
    modules.push_str("pub use direct_file_destination::{DirectFileDestination, direct_file_directory_destination};\n");
    fs::write(out.join("native.rs"), modules).unwrap();
    println!("cargo:rerun-if-env-changed=IRIS_CHAT_RS_CORE_DIR");
}
