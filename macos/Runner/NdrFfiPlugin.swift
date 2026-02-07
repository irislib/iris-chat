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
    private var sessionManagerHandles: [String: SessionManagerHandle] = [:]
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
            case "createSignedAppKeysEvent":
                try handleCreateSignedAppKeysEvent(call: call, result: result)
            case "parseAppKeysEvent":
                try handleParseAppKeysEvent(call: call, result: result)
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
            case "inviteAcceptWithOwner":
                try handleInviteAcceptWithOwner(call: call, result: result)
            case "inviteSetPurpose":
                try handleInviteSetPurpose(call: call, result: result)
            case "inviteSetOwnerPubkeyHex":
                try handleInviteSetOwnerPubkeyHex(call: call, result: result)
            case "inviteGetInviterPubkeyHex":
                try handleInviteGetInviterPubkeyHex(call: call, result: result)
            case "inviteGetSharedSecretHex":
                try handleInviteGetSharedSecretHex(call: call, result: result)
            case "inviteProcessResponse":
                try handleInviteProcessResponse(call: call, result: result)
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
            case "sessionManagerNew":
                try handleSessionManagerNew(call: call, result: result)
            case "sessionManagerNewWithStoragePath":
                try handleSessionManagerNewWithStoragePath(call: call, result: result)
            case "sessionManagerInit":
                try handleSessionManagerInit(call: call, result: result)
            case "sessionManagerSendText":
                try handleSessionManagerSendText(call: call, result: result)
            case "sessionManagerSendTextWithInnerId":
                try handleSessionManagerSendTextWithInnerId(call: call, result: result)
            case "sessionManagerSendEventWithInnerId":
                try handleSessionManagerSendEventWithInnerId(call: call, result: result)
            case "sessionManagerSendReceipt":
                try handleSessionManagerSendReceipt(call: call, result: result)
            case "sessionManagerSendTyping":
                try handleSessionManagerSendTyping(call: call, result: result)
            case "sessionManagerSendReaction":
                try handleSessionManagerSendReaction(call: call, result: result)
            case "sessionManagerImportSessionState":
                try handleSessionManagerImportSessionState(call: call, result: result)
            case "sessionManagerGetActiveSessionState":
                try handleSessionManagerGetActiveSessionState(call: call, result: result)
            case "sessionManagerProcessEvent":
                try handleSessionManagerProcessEvent(call: call, result: result)
            case "sessionManagerDrainEvents":
                try handleSessionManagerDrainEvents(call: call, result: result)
            case "sessionManagerGetDeviceId":
                try handleSessionManagerGetDeviceId(call: call, result: result)
            case "sessionManagerGetOurPubkeyHex":
                try handleSessionManagerGetOurPubkeyHex(call: call, result: result)
            case "sessionManagerGetOwnerPubkeyHex":
                try handleSessionManagerGetOwnerPubkeyHex(call: call, result: result)
            case "sessionManagerGetTotalSessions":
                try handleSessionManagerGetTotalSessions(call: call, result: result)
            case "sessionManagerDispose":
                try handleSessionManagerDispose(call: call, result: result)
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
        guard let args = call.arguments as? [String: Any],
              let privkeyHex = args["privkeyHex"] as? String else {
            throw PluginError.invalidArguments("Missing privkeyHex")
        }

        result(try derivePublicKey(privkeyHex: privkeyHex))
    }

    // MARK: - AppKeys

    private func handleCreateSignedAppKeysEvent(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let ownerPubkeyHex = args["ownerPubkeyHex"] as? String,
              let ownerPrivkeyHex = args["ownerPrivkeyHex"] as? String else {
            throw PluginError.invalidArguments("Missing ownerPubkeyHex or ownerPrivkeyHex")
        }

        let deviceMaps = args["devices"] as? [[String: Any]] ?? []
        let devices: [FfiDeviceEntry] = deviceMaps.compactMap { m in
            guard let identity = m["identityPubkeyHex"] as? String else { return nil }
            let createdAt = (m["createdAt"] as? NSNumber)?.uint64Value ?? 0
            return FfiDeviceEntry(identityPubkeyHex: identity, createdAt: createdAt)
        }

        result(try createSignedAppKeysEvent(
            ownerPubkeyHex: ownerPubkeyHex,
            ownerPrivkeyHex: ownerPrivkeyHex,
            devices: devices
        ))
    }

    private func handleParseAppKeysEvent(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let eventJson = args["eventJson"] as? String else {
            throw PluginError.invalidArguments("Missing eventJson")
        }

        let devices = try parseAppKeysEvent(eventJson: eventJson).map { d in
            return [
                "identityPubkeyHex": d.identityPubkeyHex,
                "createdAt": d.createdAt,
            ]
        }
        result(devices)
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

    private func handleInviteAcceptWithOwner(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String,
              let inviteePubkeyHex = args["inviteePubkeyHex"] as? String,
              let inviteePrivkeyHex = args["inviteePrivkeyHex"] as? String else {
            throw PluginError.invalidArguments("Missing required arguments")
        }
        let deviceId = args["deviceId"] as? String
        let ownerPubkeyHex = args["ownerPubkeyHex"] as? String

        guard let invite = inviteHandles[id] else {
            throw PluginError.handleNotFound("Invite handle not found: \(id)")
        }

        let acceptResult = try invite.acceptWithOwner(
            inviteePubkeyHex: inviteePubkeyHex,
            inviteePrivkeyHex: inviteePrivkeyHex,
            deviceId: deviceId,
            ownerPubkeyHex: ownerPubkeyHex
        )

        let sessionId = generateHandleId()
        sessionHandles[sessionId] = acceptResult.session

        result([
            "session": ["id": sessionId],
            "responseEventJson": acceptResult.responseEventJson
        ])
    }

    private func handleInviteSetPurpose(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String else {
            throw PluginError.invalidArguments("Missing id")
        }
        let purpose = args["purpose"] as? String

        guard let invite = inviteHandles[id] else {
            throw PluginError.handleNotFound("Invite handle not found: \(id)")
        }

        invite.setPurpose(purpose: purpose)
        result(nil)
    }

    private func handleInviteSetOwnerPubkeyHex(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String else {
            throw PluginError.invalidArguments("Missing id")
        }
        let ownerPubkeyHex = args["ownerPubkeyHex"] as? String

        guard let invite = inviteHandles[id] else {
            throw PluginError.handleNotFound("Invite handle not found: \(id)")
        }

        try invite.setOwnerPubkeyHex(ownerPubkeyHex: ownerPubkeyHex)
        result(nil)
    }

    private func handleInviteProcessResponse(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String,
              let eventJson = args["eventJson"] as? String,
              let inviterPrivkeyHex = args["inviterPrivkeyHex"] as? String else {
            throw PluginError.invalidArguments("Missing required arguments")
        }

        guard let invite = inviteHandles[id] else {
            throw PluginError.handleNotFound("Invite handle not found: \(id)")
        }

        let processResult = try invite.processResponse(eventJson: eventJson, inviterPrivkeyHex: inviterPrivkeyHex)
        guard let r = processResult else {
            result(nil)
            return
        }

        let sessionId = generateHandleId()
        sessionHandles[sessionId] = r.session

        result([
            "session": ["id": sessionId],
            "inviteePubkeyHex": r.inviteePubkeyHex,
            "deviceId": r.deviceId as Any,
            "ownerPubkeyHex": r.ownerPubkeyHex as Any,
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

    // MARK: - Session Manager

    private func handleSessionManagerNew(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let ourPubkeyHex = args["ourPubkeyHex"] as? String,
              let ourIdentityPrivkeyHex = args["ourIdentityPrivkeyHex"] as? String,
              let deviceId = args["deviceId"] as? String else {
            throw PluginError.invalidArguments("Missing required arguments")
        }
        let ownerPubkeyHex = args["ownerPubkeyHex"] as? String

        let manager = try SessionManagerHandle(
            ourPubkeyHex: ourPubkeyHex,
            ourIdentityPrivkeyHex: ourIdentityPrivkeyHex,
            deviceId: deviceId,
            ownerPubkeyHex: ownerPubkeyHex
        )
        let id = generateHandleId()
        sessionManagerHandles[id] = manager
        result(["id": id])
    }

    private func handleSessionManagerNewWithStoragePath(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let ourPubkeyHex = args["ourPubkeyHex"] as? String,
              let ourIdentityPrivkeyHex = args["ourIdentityPrivkeyHex"] as? String,
              let deviceId = args["deviceId"] as? String,
              let storagePath = args["storagePath"] as? String else {
            throw PluginError.invalidArguments("Missing required arguments")
        }
        let ownerPubkeyHex = args["ownerPubkeyHex"] as? String

        let manager = try SessionManagerHandle.newWithStoragePath(
            ourPubkeyHex: ourPubkeyHex,
            ourIdentityPrivkeyHex: ourIdentityPrivkeyHex,
            deviceId: deviceId,
            storagePath: storagePath,
            ownerPubkeyHex: ownerPubkeyHex
        )
        let id = generateHandleId()
        sessionManagerHandles[id] = manager
        result(["id": id])
    }

    private func handleSessionManagerInit(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String else {
            throw PluginError.invalidArguments("Missing id")
        }
        guard let manager = sessionManagerHandles[id] else {
            throw PluginError.handleNotFound("SessionManager handle not found: \(id)")
        }
        try manager.`init`()
        result(nil)
    }

    private func handleSessionManagerSendText(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String,
              let recipientPubkeyHex = args["recipientPubkeyHex"] as? String,
              let text = args["text"] as? String else {
            throw PluginError.invalidArguments("Missing required arguments")
        }
        guard let manager = sessionManagerHandles[id] else {
            throw PluginError.handleNotFound("SessionManager handle not found: \(id)")
        }
        result(try manager.sendText(recipientPubkeyHex: recipientPubkeyHex, text: text, expiresAtSeconds: nil))
    }

    private func handleSessionManagerSendTextWithInnerId(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String,
              let recipientPubkeyHex = args["recipientPubkeyHex"] as? String,
              let text = args["text"] as? String else {
            throw PluginError.invalidArguments("Missing required arguments")
        }
        guard let manager = sessionManagerHandles[id] else {
            throw PluginError.handleNotFound("SessionManager handle not found: \(id)")
        }

        let sendResult = try manager.sendTextWithInnerId(recipientPubkeyHex: recipientPubkeyHex, text: text, expiresAtSeconds: nil)
        result([
            "innerId": sendResult.innerId,
            "outerEventIds": sendResult.outerEventIds,
        ])
    }

    private func handleSessionManagerSendEventWithInnerId(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String,
              let recipientPubkeyHex = args["recipientPubkeyHex"] as? String,
              let kind = (args["kind"] as? NSNumber)?.uint32Value,
              let content = args["content"] as? String,
              let tagsJson = args["tagsJson"] as? String else {
            throw PluginError.invalidArguments("Missing required arguments")
        }
        let createdAtSeconds = (args["createdAtSeconds"] as? NSNumber)?.uint64Value
        guard let manager = sessionManagerHandles[id] else {
            throw PluginError.handleNotFound("SessionManager handle not found: \(id)")
        }

        let sendResult = try manager.sendEventWithInnerId(
            recipientPubkeyHex: recipientPubkeyHex,
            kind: kind,
            content: content,
            tagsJson: tagsJson,
            createdAtSeconds: createdAtSeconds,
        )
        result([
            "innerId": sendResult.innerId,
            "outerEventIds": sendResult.outerEventIds,
        ])
    }

    private func handleSessionManagerSendReceipt(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String,
              let recipientPubkeyHex = args["recipientPubkeyHex"] as? String,
              let receiptType = args["receiptType"] as? String,
              let messageIds = args["messageIds"] as? [String] else {
            throw PluginError.invalidArguments("Missing required arguments")
        }
        guard let manager = sessionManagerHandles[id] else {
            throw PluginError.handleNotFound("SessionManager handle not found: \(id)")
        }
        result(try manager.sendReceipt(recipientPubkeyHex: recipientPubkeyHex, receiptType: receiptType, messageIds: messageIds, expiresAtSeconds: nil))
    }

    private func handleSessionManagerSendTyping(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String,
              let recipientPubkeyHex = args["recipientPubkeyHex"] as? String else {
            throw PluginError.invalidArguments("Missing required arguments")
        }
        guard let manager = sessionManagerHandles[id] else {
            throw PluginError.handleNotFound("SessionManager handle not found: \(id)")
        }
        result(try manager.sendTyping(recipientPubkeyHex: recipientPubkeyHex, expiresAtSeconds: nil))
    }

    private func handleSessionManagerSendReaction(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String,
              let recipientPubkeyHex = args["recipientPubkeyHex"] as? String,
              let messageId = args["messageId"] as? String,
              let emoji = args["emoji"] as? String else {
            throw PluginError.invalidArguments("Missing required arguments")
        }
        guard let manager = sessionManagerHandles[id] else {
            throw PluginError.handleNotFound("SessionManager handle not found: \(id)")
        }
        result(try manager.sendReaction(recipientPubkeyHex: recipientPubkeyHex, messageId: messageId, emoji: emoji, expiresAtSeconds: nil))
    }

    private func handleSessionManagerImportSessionState(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String,
              let peerPubkeyHex = args["peerPubkeyHex"] as? String,
              let stateJson = args["stateJson"] as? String else {
            throw PluginError.invalidArguments("Missing required arguments")
        }
        let deviceId = args["deviceId"] as? String

        guard let manager = sessionManagerHandles[id] else {
            throw PluginError.handleNotFound("SessionManager handle not found: \(id)")
        }
        try manager.importSessionState(peerPubkeyHex: peerPubkeyHex, stateJson: stateJson, deviceId: deviceId)
        result(nil)
    }

    private func handleSessionManagerGetActiveSessionState(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String,
              let peerPubkeyHex = args["peerPubkeyHex"] as? String else {
            throw PluginError.invalidArguments("Missing required arguments")
        }
        guard let manager = sessionManagerHandles[id] else {
            throw PluginError.handleNotFound("SessionManager handle not found: \(id)")
        }
        result(try manager.getActiveSessionState(peerPubkeyHex: peerPubkeyHex))
    }

    private func handleSessionManagerProcessEvent(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String,
              let eventJson = args["eventJson"] as? String else {
            throw PluginError.invalidArguments("Missing required arguments")
        }
        guard let manager = sessionManagerHandles[id] else {
            throw PluginError.handleNotFound("SessionManager handle not found: \(id)")
        }
        try manager.processEvent(eventJson: eventJson)
        result(nil)
    }

    private func handleSessionManagerDrainEvents(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String else {
            throw PluginError.invalidArguments("Missing id")
        }
        guard let manager = sessionManagerHandles[id] else {
            throw PluginError.handleNotFound("SessionManager handle not found: \(id)")
        }

        let events = try manager.drainEvents().map { e in
            return [
                "kind": e.kind,
                "subid": e.subid as Any,
                "filterJson": e.filterJson as Any,
                "eventJson": e.eventJson as Any,
                "senderPubkeyHex": e.senderPubkeyHex as Any,
                "content": e.content as Any,
                "eventId": e.eventId as Any,
            ]
        }
        result(events)
    }

    private func handleSessionManagerGetDeviceId(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String else {
            throw PluginError.invalidArguments("Missing id")
        }
        guard let manager = sessionManagerHandles[id] else {
            throw PluginError.handleNotFound("SessionManager handle not found: \(id)")
        }
        result(manager.getDeviceId())
    }

    private func handleSessionManagerGetOurPubkeyHex(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String else {
            throw PluginError.invalidArguments("Missing id")
        }
        guard let manager = sessionManagerHandles[id] else {
            throw PluginError.handleNotFound("SessionManager handle not found: \(id)")
        }
        result(manager.getOurPubkeyHex())
    }

    private func handleSessionManagerGetOwnerPubkeyHex(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String else {
            throw PluginError.invalidArguments("Missing id")
        }
        guard let manager = sessionManagerHandles[id] else {
            throw PluginError.handleNotFound("SessionManager handle not found: \(id)")
        }
        result(manager.getOwnerPubkeyHex())
    }

    private func handleSessionManagerGetTotalSessions(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String else {
            throw PluginError.invalidArguments("Missing id")
        }
        guard let manager = sessionManagerHandles[id] else {
            throw PluginError.handleNotFound("SessionManager handle not found: \(id)")
        }
        result(Int64(manager.getTotalSessions()))
    }

    private func handleSessionManagerDispose(call: FlutterMethodCall, result: FlutterResult) throws {
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String else {
            throw PluginError.invalidArguments("Missing id")
        }
        sessionManagerHandles.removeValue(forKey: id)
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
