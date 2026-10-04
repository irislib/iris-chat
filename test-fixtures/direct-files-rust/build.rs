use std::{env, fs, path::PathBuf};

fn main() {
    let core =
        PathBuf::from(env::var("IRIS_CHAT_RS_CORE_DIR").expect("Select the native core source"));
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
        if name == "direct_file_tcp" {
            let source = fs::read_to_string(&path).unwrap();
            let source = ["files", "wire"].iter().fold(source, |source, child| {
                source.replace(
                    &format!("mod {child};"),
                    &format!(
                        "#[path = {:?}] mod {child};",
                        core.join(format!("src/core/direct_file_tcp/{child}.rs"))
                    ),
                )
            });
            let copied = out.join("direct_file_tcp.rs");
            fs::write(&copied, source).unwrap();
            modules.push_str(&format!("#[path = {:?}] mod {name};\n", copied));
        } else {
            modules.push_str(&format!("#[path = {:?}] mod {name};\n", path));
        }
    }
    for file in [
        "src/core/direct_file_tcp/files.rs",
        "src/core/direct_file_tcp/wire.rs",
        "src/direct_files.rs",
    ] {
        println!("cargo:rerun-if-changed={}", core.join(file).display());
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
