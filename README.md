# Iris Chat

End-to-end encrypted mobile chat app using the Nostr Double Ratchet protocol.

## Features

- **End-to-end encryption** - Messages encrypted using Double Ratchet (Signal protocol)
- **Decentralized** - Uses Nostr relays, no central server
- **Offline support** - Messages queued when offline, sent when connected
- **QR code invites** - Easy contact sharing via QR codes or links
- **Cross-platform** - Android and iOS

## Architecture

- **Flutter** with Riverpod for state management
- **Rust** native library (ndr-ffi) for cryptography via FFI
- **SQLite** for local message storage
- **Secure storage** for private keys

## Building

### Prerequisites

- Flutter 3.24+
- For Android: Android SDK
- For iOS: macOS with Xcode

### Android

```bash
flutter build apk --release
```

### iOS

1. Build the native library on macOS (see `ios/Frameworks/README.md`)
2. Run:
```bash
flutter build ios --release
```

## Development

```bash
# Install dependencies
flutter pub get

# Run code generation (freezed, riverpod)
dart run build_runner build

# Run tests
flutter test

# Run analyzer
flutter analyze
```

## Project Structure

```
lib/
├── config/          # Providers, router, theme
├── core/            # FFI bindings, services
├── features/        # Feature modules
│   ├── auth/        # Identity management
│   ├── chat/        # Messaging
│   ├── invite/      # QR invites
│   └── settings/    # App settings
└── shared/          # Common utilities
```

## License

MIT
