import Cocoa
import FlutterMacOS

// Wrapper to avoid naming conflict with NSObject.version
private func ndrVersion() -> String {
    return version()
}

/// Flutter plugin for ndr-ffi bindings (macOS) using real UniFFI bindings.
public class NdrFfiPlugin: NSObject, FlutterPlugin {
    private var inviteHandles: [String: InviteHandle] = [:]
    private var sessionHandles: [String: SessionHandle] = [:]
    private var nextHandleId: UInt64 = 1

    private func generateHandleId() -> String {
        let id = nextHandleId
        nextHandleId += 1
        return String(id)
    }

    public static func register(with registrar: FlutterPluginRegistrar) {
        let channel = FlutterMethodChannel(
            name: "to.iris.chat/ndr_ffi",
            binaryMessenger: registrar.messenger
        )
        let instance = NdrFfiPlugin()
        registrar.addMethodCallDelegate(instance, channel: channel)
    }

    public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        do {
            switch call.method {
            case "version":
                result(ndrVersion())
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
        } catch let error as NdrError {
            result(FlutterError(code: "NdrError", message: String(describing: error), details: nil))
        } catch let error as PluginError {
            result(FlutterError(code: error.code, message: error.message, details: nil))
        } catch {
            result(FlutterError(code: "NdrError", message: error.localizedDescription, details: nil))
        }
    }

    // MARK: - Keypair

    private func handleGenerateKeypair(result: FlutterResult) {
        let keypair = generateKeypair()
        result([
            "publicKeyHex": keypair.publicKeyHex,
            "privateKeyHex": keypair.privateKeyHex
        ])
    }

    private func handleDerivePublicKey(call: FlutterMethodCall, result: FlutterResult) throws {
        // Note: derivePublicKey is not exposed in the current ndr-ffi API
        // We can implement it using generateKeypair as a workaround or add it to the Rust lib
        throw PluginError.invalidArguments("derivePublicKey not yet implemented")
    }

    // MARK: - Invite Creation

    private func handleCreateInvite(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let inviterPubkeyHex = args["inviterPubkeyHex"] as? String else {
            throw PluginError.invalidArguments("Missing inviterPubkeyHex")
        }
        let deviceId = args["deviceId"] as? String
        let maxUses = args["maxUses"] as? Int

        let invite = try InviteHandle.createNew(
            inviterPubkeyHex: inviterPubkeyHex,
            deviceId: deviceId,
            maxUses: maxUses.map { UInt32($0) }
        )
        let id = generateHandleId()
        inviteHandles[id] = invite
        result(["id": id])
    }

    private func handleInviteFromUrl(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let url = args["url"] as? String else {
            throw PluginError.invalidArguments("Missing url")
        }

        let invite = try InviteHandle.fromUrl(url: url)
        let id = generateHandleId()
        inviteHandles[id] = invite
        result(["id": id])
    }

    private func handleInviteFromEventJson(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let eventJson = args["eventJson"] as? String else {
            throw PluginError.invalidArguments("Missing eventJson")
        }

        let invite = try InviteHandle.fromEventJson(eventJson: eventJson)
        let id = generateHandleId()
        inviteHandles[id] = invite
        result(["id": id])
    }

    private func handleInviteDeserialize(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let json = args["json"] as? String else {
            throw PluginError.invalidArguments("Missing json")
        }

        let invite = try InviteHandle.deserialize(json: json)
        let id = generateHandleId()
        inviteHandles[id] = invite
        result(["id": id])
    }

    // MARK: - Invite Methods

    private func handleInviteToUrl(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String,
              let root = args["root"] as? String else {
            throw PluginError.invalidArguments("Missing id or root")
        }
        guard let invite = inviteHandles[id] else {
            throw PluginError.handleNotFound("Invite handle not found: \(id)")
        }

        let url = try invite.toUrl(root: root)
        result(url)
    }

    private func handleInviteToEventJson(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String else {
            throw PluginError.invalidArguments("Missing id")
        }
        guard let invite = inviteHandles[id] else {
            throw PluginError.handleNotFound("Invite handle not found: \(id)")
        }

        let eventJson = try invite.toEventJson()
        result(eventJson)
    }

    private func handleInviteSerialize(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String else {
            throw PluginError.invalidArguments("Missing id")
        }
        guard let invite = inviteHandles[id] else {
            throw PluginError.handleNotFound("Invite handle not found: \(id)")
        }

        let json = try invite.serialize()
        result(json)
    }

    private func handleInviteAccept(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String,
              let inviteePubkeyHex = args["inviteePubkeyHex"] as? String,
              let inviteePrivkeyHex = args["inviteePrivkeyHex"] as? String else {
            throw PluginError.invalidArguments("Missing required arguments")
        }
        let deviceId = args["deviceId"] as? String

        guard let invite = inviteHandles[id] else {
            throw PluginError.handleNotFound("Invite handle not found: \(id)")
        }

        let acceptResult = try invite.accept(
            inviteePubkeyHex: inviteePubkeyHex,
            inviteePrivkeyHex: inviteePrivkeyHex,
            deviceId: deviceId
        )

        let sessionId = generateHandleId()
        sessionHandles[sessionId] = acceptResult.session

        result([
            "session": ["id": sessionId],
            "responseEventJson": acceptResult.responseEventJson
        ])
    }

    private func handleInviteGetInviterPubkeyHex(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String else {
            throw PluginError.invalidArguments("Missing id")
        }
        guard let invite = inviteHandles[id] else {
            throw PluginError.handleNotFound("Invite handle not found: \(id)")
        }

        result(invite.getInviterPubkeyHex())
    }

    private func handleInviteGetSharedSecretHex(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String else {
            throw PluginError.invalidArguments("Missing id")
        }
        guard let invite = inviteHandles[id] else {
            throw PluginError.handleNotFound("Invite handle not found: \(id)")
        }

        result(invite.getSharedSecretHex())
    }

    private func handleInviteDispose(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String else {
            throw PluginError.invalidArguments("Missing id")
        }
        inviteHandles.removeValue(forKey: id)
        result(nil)
    }

    // MARK: - Session Creation

    private func handleSessionFromStateJson(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let stateJson = args["stateJson"] as? String else {
            throw PluginError.invalidArguments("Missing stateJson")
        }

        let session = try SessionHandle.fromStateJson(stateJson: stateJson)
        let id = generateHandleId()
        sessionHandles[id] = session
        result(["id": id])
    }

    private func handleSessionInit(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let theirEphemeralPubkeyHex = args["theirEphemeralPubkeyHex"] as? String,
              let ourEphemeralPrivkeyHex = args["ourEphemeralPrivkeyHex"] as? String,
              let isInitiator = args["isInitiator"] as? Bool,
              let sharedSecretHex = args["sharedSecretHex"] as? String else {
            throw PluginError.invalidArguments("Missing required arguments")
        }
        let name = args["name"] as? String

        let session = try SessionHandle.`init`(
            theirEphemeralPubkeyHex: theirEphemeralPubkeyHex,
            ourEphemeralPrivkeyHex: ourEphemeralPrivkeyHex,
            isInitiator: isInitiator,
            sharedSecretHex: sharedSecretHex,
            name: name
        )
        let id = generateHandleId()
        sessionHandles[id] = session
        result(["id": id])
    }

    // MARK: - Session Methods

    private func handleSessionCanSend(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String else {
            throw PluginError.invalidArguments("Missing id")
        }
        guard let session = sessionHandles[id] else {
            throw PluginError.handleNotFound("Session handle not found: \(id)")
        }

        result(session.canSend())
    }

    private func handleSessionSendText(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String,
              let text = args["text"] as? String else {
            throw PluginError.invalidArguments("Missing id or text")
        }
        guard let session = sessionHandles[id] else {
            throw PluginError.handleNotFound("Session handle not found: \(id)")
        }

        let sendResult = try session.sendText(text: text)
        result([
            "outerEventJson": sendResult.outerEventJson,
            "innerEventJson": sendResult.innerEventJson
        ])
    }

    private func handleSessionDecryptEvent(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String,
              let outerEventJson = args["outerEventJson"] as? String else {
            throw PluginError.invalidArguments("Missing id or outerEventJson")
        }
        guard let session = sessionHandles[id] else {
            throw PluginError.handleNotFound("Session handle not found: \(id)")
        }

        let decryptResult = try session.decryptEvent(outerEventJson: outerEventJson)
        result([
            "plaintext": decryptResult.plaintext,
            "innerEventJson": decryptResult.innerEventJson
        ])
    }

    private func handleSessionStateJson(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String else {
            throw PluginError.invalidArguments("Missing id")
        }
        guard let session = sessionHandles[id] else {
            throw PluginError.handleNotFound("Session handle not found: \(id)")
        }

        let stateJson = try session.stateJson()
        result(stateJson)
    }

    private func handleSessionIsDrMessage(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String,
              let eventJson = args["eventJson"] as? String else {
            throw PluginError.invalidArguments("Missing id or eventJson")
        }
        guard let session = sessionHandles[id] else {
            throw PluginError.handleNotFound("Session handle not found: \(id)")
        }

        result(session.isDrMessage(eventJson: eventJson))
    }

    private func handleSessionDispose(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String else {
            throw PluginError.invalidArguments("Missing id")
        }
        sessionHandles.removeValue(forKey: id)
        result(nil)
    }
}

// MARK: - Error Types

enum PluginError: Error {
    case invalidArguments(String)
    case handleNotFound(String)

    var code: String {
        switch self {
        case .invalidArguments: return "InvalidArguments"
        case .handleNotFound: return "HandleNotFound"
        }
    }

    var message: String {
        switch self {
        case .invalidArguments(let msg): return msg
        case .handleNotFound(let msg): return msg
        }
    }
}
