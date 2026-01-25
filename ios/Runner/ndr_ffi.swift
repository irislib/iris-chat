// This file is a PLACEHOLDER for UniFFI-generated Swift bindings.
//
// When you build the ndr-ffi Rust library for iOS, UniFFI will generate
// this file with the actual implementations. The structure below matches
// what UniFFI generates so the NdrFfiPlugin.swift can be prepared for it.
//
// Build steps:
// 1. cd /path/to/nostr-double-ratchet
// 2. ./scripts/mobile/build-ios.sh --release
// 3. Copy the generated ndr_ffi.swift from the build output here
// 4. Add NdrFfi.xcframework to the Xcode project
//
// IMPORTANT: Replace this entire file with the UniFFI-generated version.

import Foundation

// MARK: - Error Types

/// Error type for ndr-ffi operations
public enum NdrException: Error {
    case InvalidKey(message: String)
    case InvalidSignature(message: String)
    case InvalidInvite(message: String)
    case SessionError(message: String)
    case SerializationError(message: String)
    case CryptoError(message: String)
    case Other(message: String)
}

// MARK: - Data Structures

/// A Nostr keypair with hex-encoded keys
public struct FfiKeypair {
    public let publicKeyHex: String
    public let privateKeyHex: String
}

/// Result from sending a message
public struct SendResult {
    public let outerEventJson: String
    public let innerEventJson: String
}

/// Result from decrypting an event
public struct DecryptResult {
    public let plaintext: String
    public let innerEventJson: String
}

/// Result from accepting an invite
public struct InviteAcceptResult {
    public let session: SessionHandle
    public let responseEventJson: String
}

// MARK: - Top-level Functions

/// Get the version of the ndr-ffi library
public func version() -> String {
    // Placeholder - will be implemented by UniFFI
    fatalError("UniFFI bindings not integrated. Build ndr-ffi and replace this file.")
}

/// Generate a new Nostr keypair
public func generateKeypair() -> FfiKeypair {
    // Placeholder - will be implemented by UniFFI
    fatalError("UniFFI bindings not integrated. Build ndr-ffi and replace this file.")
}

/// Derive a public key from a private key
public func derivePublicKey(privkeyHex: String) throws -> String {
    // Placeholder - will be implemented by UniFFI
    fatalError("UniFFI bindings not integrated. Build ndr-ffi and replace this file.")
}

// MARK: - InviteHandle

/// Handle to an invite object in the Rust library
public class InviteHandle {
    // Internal pointer/handle to Rust object
    private var handle: UInt64 = 0

    private init(handle: UInt64) {
        self.handle = handle
    }

    deinit {
        // Cleanup handled by close()
    }

    /// Create a new invite
    public static func createNew(
        inviterPubkeyHex: String,
        deviceId: String?,
        maxUses: UInt32?
    ) throws -> InviteHandle {
        // Placeholder - will be implemented by UniFFI
        fatalError("UniFFI bindings not integrated. Build ndr-ffi and replace this file.")
    }

    /// Parse an invite from a URL
    public static func fromUrl(url: String) throws -> InviteHandle {
        // Placeholder - will be implemented by UniFFI
        fatalError("UniFFI bindings not integrated. Build ndr-ffi and replace this file.")
    }

    /// Parse an invite from a Nostr event JSON
    public static func fromEventJson(eventJson: String) throws -> InviteHandle {
        // Placeholder - will be implemented by UniFFI
        fatalError("UniFFI bindings not integrated. Build ndr-ffi and replace this file.")
    }

    /// Deserialize an invite from JSON
    public static func deserialize(json: String) throws -> InviteHandle {
        // Placeholder - will be implemented by UniFFI
        fatalError("UniFFI bindings not integrated. Build ndr-ffi and replace this file.")
    }

    /// Convert the invite to a URL
    public func toUrl(root: String) throws -> String {
        // Placeholder - will be implemented by UniFFI
        fatalError("UniFFI bindings not integrated. Build ndr-ffi and replace this file.")
    }

    /// Convert the invite to a Nostr event JSON
    public func toEventJson() throws -> String {
        // Placeholder - will be implemented by UniFFI
        fatalError("UniFFI bindings not integrated. Build ndr-ffi and replace this file.")
    }

    /// Serialize the invite to JSON
    public func serialize() throws -> String {
        // Placeholder - will be implemented by UniFFI
        fatalError("UniFFI bindings not integrated. Build ndr-ffi and replace this file.")
    }

    /// Accept the invite and create a session
    public func accept(
        inviteePubkeyHex: String,
        inviteePrivkeyHex: String,
        deviceId: String?
    ) throws -> InviteAcceptResult {
        // Placeholder - will be implemented by UniFFI
        fatalError("UniFFI bindings not integrated. Build ndr-ffi and replace this file.")
    }

    /// Get the inviter's public key
    public func getInviterPubkeyHex() -> String {
        // Placeholder - will be implemented by UniFFI
        fatalError("UniFFI bindings not integrated. Build ndr-ffi and replace this file.")
    }

    /// Get the shared secret
    public func getSharedSecretHex() -> String {
        // Placeholder - will be implemented by UniFFI
        fatalError("UniFFI bindings not integrated. Build ndr-ffi and replace this file.")
    }

    /// Close and release the handle
    public func close() {
        // Placeholder - will be implemented by UniFFI
        // In the real implementation, this releases the Rust object
    }
}

// MARK: - SessionHandle

/// Handle to a session object in the Rust library
public class SessionHandle {
    // Internal pointer/handle to Rust object
    private var handle: UInt64 = 0

    private init(handle: UInt64) {
        self.handle = handle
    }

    deinit {
        // Cleanup handled by close()
    }

    /// Restore a session from state JSON
    public static func fromStateJson(stateJson: String) throws -> SessionHandle {
        // Placeholder - will be implemented by UniFFI
        fatalError("UniFFI bindings not integrated. Build ndr-ffi and replace this file.")
    }

    /// Initialize a new session
    public static func `init`(
        theirEphemeralPubkeyHex: String,
        ourEphemeralPrivkeyHex: String,
        isInitiator: Bool,
        sharedSecretHex: String,
        name: String?
    ) throws -> SessionHandle {
        // Placeholder - will be implemented by UniFFI
        fatalError("UniFFI bindings not integrated. Build ndr-ffi and replace this file.")
    }

    /// Check if the session can send messages
    public func canSend() -> Bool {
        // Placeholder - will be implemented by UniFFI
        fatalError("UniFFI bindings not integrated. Build ndr-ffi and replace this file.")
    }

    /// Send a text message
    public func sendText(text: String) throws -> SendResult {
        // Placeholder - will be implemented by UniFFI
        fatalError("UniFFI bindings not integrated. Build ndr-ffi and replace this file.")
    }

    /// Decrypt an event
    public func decryptEvent(outerEventJson: String) throws -> DecryptResult {
        // Placeholder - will be implemented by UniFFI
        fatalError("UniFFI bindings not integrated. Build ndr-ffi and replace this file.")
    }

    /// Get the session state as JSON
    public func stateJson() throws -> String {
        // Placeholder - will be implemented by UniFFI
        fatalError("UniFFI bindings not integrated. Build ndr-ffi and replace this file.")
    }

    /// Check if an event is a double-ratchet message
    public func isDrMessage(eventJson: String) -> Bool {
        // Placeholder - will be implemented by UniFFI
        fatalError("UniFFI bindings not integrated. Build ndr-ffi and replace this file.")
    }

    /// Close and release the handle
    public func close() {
        // Placeholder - will be implemented by UniFFI
        // In the real implementation, this releases the Rust object
    }
}
