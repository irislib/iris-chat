import Flutter
import UIKit

// MARK: - Configuration

/// Set this to true once ndr-ffi is built and the UniFFI bindings are integrated.
/// This enables the real Rust library calls instead of returning "NotImplemented" errors.
///
/// Integration steps:
/// 1. Build ndr-ffi: cd /path/to/nostr-double-ratchet && ./scripts/mobile/build-ios.sh --release
/// 2. Add NdrFfi.xcframework to the Xcode project (link with Runner target)
/// 3. Replace ios/Runner/ndr_ffi.swift with the UniFFI-generated version
/// 4. Set NDR_FFI_ENABLED to true below
/// 5. Uncomment the UniFFI implementation blocks in each handler
private let NDR_FFI_ENABLED = false

/// Flutter plugin for ndr-ffi bindings.
///
/// This plugin bridges Flutter's platform channels to the UniFFI-generated
/// Swift bindings for the Rust ndr-ffi library.
public class NdrFfiPlugin: NSObject, FlutterPlugin {
    // Handle storage with type-erased containers
    // These will hold InviteHandle and SessionHandle instances once UniFFI is integrated
    private var inviteHandles: [String: Any] = [:]
    private var sessionHandles: [String: Any] = [:]
    private var nextHandleId: UInt64 = 1

    private func generateHandleId() -> String {
        let id = nextHandleId
        nextHandleId += 1
        return String(id)
    }

    public static func register(with registrar: FlutterPluginRegistrar) {
        let channel = FlutterMethodChannel(
            name: "to.iris.chat/ndr_ffi",
            binaryMessenger: registrar.messenger()
        )
        let instance = NdrFfiPlugin()
        registrar.addMethodCallDelegate(instance, channel: channel)
    }

    /// Cleanup all handles when the plugin is detached
    private func cleanup() {
        // When UniFFI is integrated, close all handles:
        // for (_, invite) in inviteHandles {
        //     (invite as? InviteHandle)?.close()
        // }
        // for (_, session) in sessionHandles {
        //     (session as? SessionHandle)?.close()
        // }
        inviteHandles.removeAll()
        sessionHandles.removeAll()
    }

    public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        do {
            switch call.method {
            case "version":
                handleVersion(result: result)
            case "generateKeypair":
                handleGenerateKeypair(result: result)
            case "derivePublicKey":
                try handleDerivePublicKey(call: call, result: result)
            case "createInvite":
                try handleCreateInvite(call: call, result: result)
            case "inviteFromUrl":
                try handleInviteFromUrl(call: call, result: result)
            case "inviteFromEventJson":
                try handleInviteFromEventJson(call: call, result: result)
            case "inviteDeserialize":
                try handleInviteDeserialize(call: call, result: result)
            case "inviteToUrl":
                try handleInviteToUrl(call: call, result: result)
            case "inviteToEventJson":
                try handleInviteToEventJson(call: call, result: result)
            case "inviteSerialize":
                try handleInviteSerialize(call: call, result: result)
            case "inviteAccept":
                try handleInviteAccept(call: call, result: result)
            case "inviteGetInviterPubkeyHex":
                try handleInviteGetInviterPubkeyHex(call: call, result: result)
            case "inviteGetSharedSecretHex":
                try handleInviteGetSharedSecretHex(call: call, result: result)
            case "inviteDispose":
                try handleInviteDispose(call: call, result: result)
            case "sessionFromStateJson":
                try handleSessionFromStateJson(call: call, result: result)
            case "sessionInit":
                try handleSessionInit(call: call, result: result)
            case "sessionCanSend":
                try handleSessionCanSend(call: call, result: result)
            case "sessionSendText":
                try handleSessionSendText(call: call, result: result)
            case "sessionDecryptEvent":
                try handleSessionDecryptEvent(call: call, result: result)
            case "sessionStateJson":
                try handleSessionStateJson(call: call, result: result)
            case "sessionIsDrMessage":
                try handleSessionIsDrMessage(call: call, result: result)
            case "sessionDispose":
                try handleSessionDispose(call: call, result: result)
            default:
                result(FlutterMethodNotImplemented)
            }
        } catch let error as NdrPluginError {
            result(FlutterError(code: error.code, message: error.message, details: nil))
        } catch {
            result(FlutterError(code: "NdrError", message: error.localizedDescription, details: nil))
        }
    }

    // MARK: - Version

    private func handleVersion(result: FlutterResult) {
        if NDR_FFI_ENABLED {
            // Uncomment when UniFFI bindings are integrated:
            // result(version())
            result("0.0.39")
        } else {
            // Return version string even in stub mode for compatibility
            result("0.0.39-stub")
        }
    }

    // MARK: - Keypair

    private func handleGenerateKeypair(result: FlutterResult) {
        if NDR_FFI_ENABLED {
            // Uncomment when UniFFI bindings are integrated:
            // let keypair = generateKeypair()
            // result([
            //     "publicKeyHex": keypair.publicKeyHex,
            //     "privateKeyHex": keypair.privateKeyHex
            // ])
            result(notImplementedError())
        } else {
            result(notImplementedError())
        }
    }

    private func handleDerivePublicKey(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let privkeyHex = args["privkeyHex"] as? String else {
            throw NdrPluginError.invalidArguments("Missing privkeyHex")
        }
        _ = privkeyHex // Silence unused variable warning

        if NDR_FFI_ENABLED {
            // Uncomment when UniFFI bindings are integrated:
            // do {
            //     let pubkeyHex = try derivePublicKey(privkeyHex: privkeyHex)
            //     result(pubkeyHex)
            // } catch {
            //     throw NdrPluginError.ndrError(error.localizedDescription)
            // }
            result(notImplementedError())
        } else {
            result(notImplementedError())
        }
    }

    // MARK: - Invite Creation

    private func handleCreateInvite(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let inviterPubkeyHex = args["inviterPubkeyHex"] as? String else {
            throw NdrPluginError.invalidArguments("Missing inviterPubkeyHex")
        }
        let deviceId = args["deviceId"] as? String
        let maxUses = args["maxUses"] as? Int
        _ = (inviterPubkeyHex, deviceId, maxUses) // Silence unused variable warning

        if NDR_FFI_ENABLED {
            // Uncomment when UniFFI bindings are integrated:
            // do {
            //     let invite = try InviteHandle.createNew(
            //         inviterPubkeyHex: inviterPubkeyHex,
            //         deviceId: deviceId,
            //         maxUses: maxUses.map { UInt32($0) }
            //     )
            //     let id = generateHandleId()
            //     inviteHandles[id] = invite
            //     result(["id": id])
            // } catch {
            //     throw NdrPluginError.ndrError(error.localizedDescription)
            // }
            result(notImplementedError())
        } else {
            result(notImplementedError())
        }
    }

    private func handleInviteFromUrl(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let url = args["url"] as? String else {
            throw NdrPluginError.invalidArguments("Missing url")
        }
        _ = url // Silence unused variable warning

        if NDR_FFI_ENABLED {
            // Uncomment when UniFFI bindings are integrated:
            // do {
            //     let invite = try InviteHandle.fromUrl(url: url)
            //     let id = generateHandleId()
            //     inviteHandles[id] = invite
            //     result(["id": id])
            // } catch {
            //     throw NdrPluginError.ndrError(error.localizedDescription)
            // }
            result(notImplementedError())
        } else {
            result(notImplementedError())
        }
    }

    private func handleInviteFromEventJson(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let eventJson = args["eventJson"] as? String else {
            throw NdrPluginError.invalidArguments("Missing eventJson")
        }
        _ = eventJson // Silence unused variable warning

        if NDR_FFI_ENABLED {
            // Uncomment when UniFFI bindings are integrated:
            // do {
            //     let invite = try InviteHandle.fromEventJson(eventJson: eventJson)
            //     let id = generateHandleId()
            //     inviteHandles[id] = invite
            //     result(["id": id])
            // } catch {
            //     throw NdrPluginError.ndrError(error.localizedDescription)
            // }
            result(notImplementedError())
        } else {
            result(notImplementedError())
        }
    }

    private func handleInviteDeserialize(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let json = args["json"] as? String else {
            throw NdrPluginError.invalidArguments("Missing json")
        }
        _ = json // Silence unused variable warning

        if NDR_FFI_ENABLED {
            // Uncomment when UniFFI bindings are integrated:
            // do {
            //     let invite = try InviteHandle.deserialize(json: json)
            //     let id = generateHandleId()
            //     inviteHandles[id] = invite
            //     result(["id": id])
            // } catch {
            //     throw NdrPluginError.ndrError(error.localizedDescription)
            // }
            result(notImplementedError())
        } else {
            result(notImplementedError())
        }
    }

    // MARK: - Invite Methods

    private func handleInviteToUrl(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String,
              let root = args["root"] as? String else {
            throw NdrPluginError.invalidArguments("Missing id or root")
        }
        _ = root // Silence unused variable warning

        if NDR_FFI_ENABLED {
            // Uncomment when UniFFI bindings are integrated:
            // guard let invite = inviteHandles[id] as? InviteHandle else {
            //     throw NdrPluginError.handleNotFound("Invite handle not found: \(id)")
            // }
            // do {
            //     let url = try invite.toUrl(root: root)
            //     result(url)
            // } catch {
            //     throw NdrPluginError.ndrError(error.localizedDescription)
            // }
            guard inviteHandles[id] != nil else {
                throw NdrPluginError.handleNotFound("Invite handle not found: \(id)")
            }
            result(notImplementedError())
        } else {
            result(notImplementedError())
        }
    }

    private func handleInviteToEventJson(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String else {
            throw NdrPluginError.invalidArguments("Missing id")
        }

        if NDR_FFI_ENABLED {
            // Uncomment when UniFFI bindings are integrated:
            // guard let invite = inviteHandles[id] as? InviteHandle else {
            //     throw NdrPluginError.handleNotFound("Invite handle not found: \(id)")
            // }
            // do {
            //     let eventJson = try invite.toEventJson()
            //     result(eventJson)
            // } catch {
            //     throw NdrPluginError.ndrError(error.localizedDescription)
            // }
            guard inviteHandles[id] != nil else {
                throw NdrPluginError.handleNotFound("Invite handle not found: \(id)")
            }
            result(notImplementedError())
        } else {
            result(notImplementedError())
        }
    }

    private func handleInviteSerialize(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String else {
            throw NdrPluginError.invalidArguments("Missing id")
        }

        if NDR_FFI_ENABLED {
            // Uncomment when UniFFI bindings are integrated:
            // guard let invite = inviteHandles[id] as? InviteHandle else {
            //     throw NdrPluginError.handleNotFound("Invite handle not found: \(id)")
            // }
            // do {
            //     let json = try invite.serialize()
            //     result(json)
            // } catch {
            //     throw NdrPluginError.ndrError(error.localizedDescription)
            // }
            guard inviteHandles[id] != nil else {
                throw NdrPluginError.handleNotFound("Invite handle not found: \(id)")
            }
            result(notImplementedError())
        } else {
            result(notImplementedError())
        }
    }

    private func handleInviteAccept(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String,
              let inviteePubkeyHex = args["inviteePubkeyHex"] as? String,
              let inviteePrivkeyHex = args["inviteePrivkeyHex"] as? String else {
            throw NdrPluginError.invalidArguments("Missing required arguments")
        }
        let deviceId = args["deviceId"] as? String
        _ = (inviteePubkeyHex, inviteePrivkeyHex, deviceId) // Silence unused variable warning

        if NDR_FFI_ENABLED {
            // Uncomment when UniFFI bindings are integrated:
            // guard let invite = inviteHandles[id] as? InviteHandle else {
            //     throw NdrPluginError.handleNotFound("Invite handle not found: \(id)")
            // }
            // do {
            //     let acceptResult = try invite.accept(
            //         inviteePubkeyHex: inviteePubkeyHex,
            //         inviteePrivkeyHex: inviteePrivkeyHex,
            //         deviceId: deviceId
            //     )
            //     let sessionId = generateHandleId()
            //     sessionHandles[sessionId] = acceptResult.session
            //     result([
            //         "session": ["id": sessionId],
            //         "responseEventJson": acceptResult.responseEventJson
            //     ])
            // } catch {
            //     throw NdrPluginError.ndrError(error.localizedDescription)
            // }
            guard inviteHandles[id] != nil else {
                throw NdrPluginError.handleNotFound("Invite handle not found: \(id)")
            }
            result(notImplementedError())
        } else {
            result(notImplementedError())
        }
    }

    private func handleInviteGetInviterPubkeyHex(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String else {
            throw NdrPluginError.invalidArguments("Missing id")
        }

        if NDR_FFI_ENABLED {
            // Uncomment when UniFFI bindings are integrated:
            // guard let invite = inviteHandles[id] as? InviteHandle else {
            //     throw NdrPluginError.handleNotFound("Invite handle not found: \(id)")
            // }
            // result(invite.getInviterPubkeyHex())
            guard inviteHandles[id] != nil else {
                throw NdrPluginError.handleNotFound("Invite handle not found: \(id)")
            }
            result(notImplementedError())
        } else {
            result(notImplementedError())
        }
    }

    private func handleInviteGetSharedSecretHex(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String else {
            throw NdrPluginError.invalidArguments("Missing id")
        }

        if NDR_FFI_ENABLED {
            // Uncomment when UniFFI bindings are integrated:
            // guard let invite = inviteHandles[id] as? InviteHandle else {
            //     throw NdrPluginError.handleNotFound("Invite handle not found: \(id)")
            // }
            // result(invite.getSharedSecretHex())
            guard inviteHandles[id] != nil else {
                throw NdrPluginError.handleNotFound("Invite handle not found: \(id)")
            }
            result(notImplementedError())
        } else {
            result(notImplementedError())
        }
    }

    private func handleInviteDispose(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String else {
            throw NdrPluginError.invalidArguments("Missing id")
        }

        // When UniFFI is integrated:
        // (inviteHandles[id] as? InviteHandle)?.close()
        inviteHandles.removeValue(forKey: id)
        result(nil)
    }

    // MARK: - Session Creation

    private func handleSessionFromStateJson(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let stateJson = args["stateJson"] as? String else {
            throw NdrPluginError.invalidArguments("Missing stateJson")
        }
        _ = stateJson // Silence unused variable warning

        if NDR_FFI_ENABLED {
            // Uncomment when UniFFI bindings are integrated:
            // do {
            //     let session = try SessionHandle.fromStateJson(stateJson: stateJson)
            //     let id = generateHandleId()
            //     sessionHandles[id] = session
            //     result(["id": id])
            // } catch {
            //     throw NdrPluginError.ndrError(error.localizedDescription)
            // }
            result(notImplementedError())
        } else {
            result(notImplementedError())
        }
    }

    private func handleSessionInit(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let theirEphemeralPubkeyHex = args["theirEphemeralPubkeyHex"] as? String,
              let ourEphemeralPrivkeyHex = args["ourEphemeralPrivkeyHex"] as? String,
              let isInitiator = args["isInitiator"] as? Bool,
              let sharedSecretHex = args["sharedSecretHex"] as? String else {
            throw NdrPluginError.invalidArguments("Missing required arguments")
        }
        let name = args["name"] as? String
        _ = (theirEphemeralPubkeyHex, ourEphemeralPrivkeyHex, isInitiator, sharedSecretHex, name) // Silence unused variable warning

        if NDR_FFI_ENABLED {
            // Uncomment when UniFFI bindings are integrated:
            // do {
            //     let session = try SessionHandle.init(
            //         theirEphemeralPubkeyHex: theirEphemeralPubkeyHex,
            //         ourEphemeralPrivkeyHex: ourEphemeralPrivkeyHex,
            //         isInitiator: isInitiator,
            //         sharedSecretHex: sharedSecretHex,
            //         name: name
            //     )
            //     let id = generateHandleId()
            //     sessionHandles[id] = session
            //     result(["id": id])
            // } catch {
            //     throw NdrPluginError.ndrError(error.localizedDescription)
            // }
            result(notImplementedError())
        } else {
            result(notImplementedError())
        }
    }

    // MARK: - Session Methods

    private func handleSessionCanSend(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String else {
            throw NdrPluginError.invalidArguments("Missing id")
        }

        if NDR_FFI_ENABLED {
            // Uncomment when UniFFI bindings are integrated:
            // guard let session = sessionHandles[id] as? SessionHandle else {
            //     throw NdrPluginError.handleNotFound("Session handle not found: \(id)")
            // }
            // result(session.canSend())
            guard sessionHandles[id] != nil else {
                throw NdrPluginError.handleNotFound("Session handle not found: \(id)")
            }
            result(notImplementedError())
        } else {
            result(notImplementedError())
        }
    }

    private func handleSessionSendText(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String,
              let text = args["text"] as? String else {
            throw NdrPluginError.invalidArguments("Missing id or text")
        }
        _ = text // Silence unused variable warning

        if NDR_FFI_ENABLED {
            // Uncomment when UniFFI bindings are integrated:
            // guard let session = sessionHandles[id] as? SessionHandle else {
            //     throw NdrPluginError.handleNotFound("Session handle not found: \(id)")
            // }
            // do {
            //     let sendResult = try session.sendText(text: text)
            //     result([
            //         "outerEventJson": sendResult.outerEventJson,
            //         "innerEventJson": sendResult.innerEventJson
            //     ])
            // } catch {
            //     throw NdrPluginError.ndrError(error.localizedDescription)
            // }
            guard sessionHandles[id] != nil else {
                throw NdrPluginError.handleNotFound("Session handle not found: \(id)")
            }
            result(notImplementedError())
        } else {
            result(notImplementedError())
        }
    }

    private func handleSessionDecryptEvent(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String,
              let outerEventJson = args["outerEventJson"] as? String else {
            throw NdrPluginError.invalidArguments("Missing id or outerEventJson")
        }
        _ = outerEventJson // Silence unused variable warning

        if NDR_FFI_ENABLED {
            // Uncomment when UniFFI bindings are integrated:
            // guard let session = sessionHandles[id] as? SessionHandle else {
            //     throw NdrPluginError.handleNotFound("Session handle not found: \(id)")
            // }
            // do {
            //     let decryptResult = try session.decryptEvent(outerEventJson: outerEventJson)
            //     result([
            //         "plaintext": decryptResult.plaintext,
            //         "innerEventJson": decryptResult.innerEventJson
            //     ])
            // } catch {
            //     throw NdrPluginError.ndrError(error.localizedDescription)
            // }
            guard sessionHandles[id] != nil else {
                throw NdrPluginError.handleNotFound("Session handle not found: \(id)")
            }
            result(notImplementedError())
        } else {
            result(notImplementedError())
        }
    }

    private func handleSessionStateJson(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String else {
            throw NdrPluginError.invalidArguments("Missing id")
        }

        if NDR_FFI_ENABLED {
            // Uncomment when UniFFI bindings are integrated:
            // guard let session = sessionHandles[id] as? SessionHandle else {
            //     throw NdrPluginError.handleNotFound("Session handle not found: \(id)")
            // }
            // do {
            //     let stateJson = try session.stateJson()
            //     result(stateJson)
            // } catch {
            //     throw NdrPluginError.ndrError(error.localizedDescription)
            // }
            guard sessionHandles[id] != nil else {
                throw NdrPluginError.handleNotFound("Session handle not found: \(id)")
            }
            result(notImplementedError())
        } else {
            result(notImplementedError())
        }
    }

    private func handleSessionIsDrMessage(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String,
              let eventJson = args["eventJson"] as? String else {
            throw NdrPluginError.invalidArguments("Missing id or eventJson")
        }
        _ = eventJson // Silence unused variable warning

        if NDR_FFI_ENABLED {
            // Uncomment when UniFFI bindings are integrated:
            // guard let session = sessionHandles[id] as? SessionHandle else {
            //     throw NdrPluginError.handleNotFound("Session handle not found: \(id)")
            // }
            // result(session.isDrMessage(eventJson: eventJson))
            guard sessionHandles[id] != nil else {
                throw NdrPluginError.handleNotFound("Session handle not found: \(id)")
            }
            result(notImplementedError())
        } else {
            result(notImplementedError())
        }
    }

    private func handleSessionDispose(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String else {
            throw NdrPluginError.invalidArguments("Missing id")
        }

        // When UniFFI is integrated:
        // (sessionHandles[id] as? SessionHandle)?.close()
        sessionHandles.removeValue(forKey: id)
        result(nil)
    }

    // MARK: - Helper Methods

    private func notImplementedError() -> FlutterError {
        return FlutterError(
            code: "NotImplemented",
            message: "Build ndr-ffi for iOS and integrate UniFFI bindings. See NdrFfiPlugin.swift for instructions.",
            details: nil
        )
    }
}

// MARK: - Error Types

enum NdrPluginError: Error {
    case invalidArguments(String)
    case handleNotFound(String)
    case ndrError(String)

    var code: String {
        switch self {
        case .invalidArguments: return "InvalidArguments"
        case .handleNotFound: return "HandleNotFound"
        case .ndrError: return "NdrError"
        }
    }

    var message: String {
        switch self {
        case .invalidArguments(let msg): return msg
        case .handleNotFound(let msg): return msg
        case .ndrError(let msg): return msg
        }
    }
}
