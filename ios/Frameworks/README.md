# iOS Native Libraries

This directory contains the native ndr-ffi library for iOS.

## Building NdrFfi.xcframework

The iOS library must be built on macOS. Follow these steps:

### Prerequisites

1. macOS with Xcode installed
2. Rust with iOS targets:
   ```bash
   rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
   ```

### Build Steps

1. Clone the nostr-double-ratchet repository:
   ```bash
   git clone https://github.com/mmalmi/nostr-double-ratchet.git
   cd nostr-double-ratchet
   ```

2. Run the iOS build script:
   ```bash
   ./scripts/mobile/build-ios.sh --release
   ```

3. Copy the built framework:
   ```bash
   cp -r rust/target/ios/NdrFfi.xcframework /path/to/iris-chat-flutter/ios/Frameworks/
   ```

4. Copy the Swift bindings:
   ```bash
   cp rust/target/ios/bindings/ndr_ffi.swift /path/to/iris-chat-flutter/ios/Runner/
   ```

### Xcode Integration

1. Open `ios/Runner.xcworkspace` in Xcode
2. Select the Runner target
3. Go to General > Frameworks, Libraries, and Embedded Content
4. Click + and add the NdrFfi.xcframework
5. Set "Embed & Sign" for the framework

### Enable the Plugin

After adding the framework, edit `ios/Runner/NdrFfiPlugin.swift`:

```swift
// Change this line:
private let NDR_FFI_ENABLED = false
// To:
private let NDR_FFI_ENABLED = true
```

Then uncomment the UniFFI implementation blocks in each handler.

## Placeholder State

Until the native library is built and integrated, the app uses a placeholder
implementation that returns "NotImplemented" errors for all cryptographic
operations. The app will function on iOS but cannot perform actual encryption.
