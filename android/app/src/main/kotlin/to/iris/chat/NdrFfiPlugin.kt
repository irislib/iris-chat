package to.iris.chat

import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.MethodChannel.MethodCallHandler
import io.flutter.plugin.common.MethodChannel.Result
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

import uniffi.ndr_ffi.*

/**
 * Flutter plugin for ndr-ffi bindings.
 *
 * This plugin bridges Flutter's platform channels to the UniFFI-generated
 * Kotlin bindings for the Rust ndr-ffi library.
 */
class NdrFfiPlugin : FlutterPlugin, MethodCallHandler {
    private lateinit var channel: MethodChannel

    // Handle storage
    private val inviteHandles = ConcurrentHashMap<String, InviteHandle>()
    private val sessionHandles = ConcurrentHashMap<String, SessionHandle>()
    private val sessionManagerHandles = ConcurrentHashMap<String, SessionManagerHandle>()
    private val nextHandleId = AtomicLong(1)

    private fun generateHandleId(): String = nextHandleId.getAndIncrement().toString()

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel = MethodChannel(binding.binaryMessenger, "to.iris.chat/ndr_ffi")
        channel.setMethodCallHandler(this)
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel.setMethodCallHandler(null)
        // Clean up all handles
        inviteHandles.values.forEach { it.close() }
        sessionHandles.values.forEach { it.close() }
        inviteHandles.clear()
        sessionHandles.clear()
        sessionManagerHandles.values.forEach { it.close() }
        sessionManagerHandles.clear()
    }

    override fun onMethodCall(call: MethodCall, result: Result) {
        try {
            when (call.method) {
                "version" -> handleVersion(result)
                "generateKeypair" -> handleGenerateKeypair(result)
                "derivePublicKey" -> handleDerivePublicKey(call, result)
                "createInvite" -> handleCreateInvite(call, result)
                "inviteFromUrl" -> handleInviteFromUrl(call, result)
                "inviteFromEventJson" -> handleInviteFromEventJson(call, result)
                "inviteDeserialize" -> handleInviteDeserialize(call, result)
                "inviteToUrl" -> handleInviteToUrl(call, result)
                "inviteToEventJson" -> handleInviteToEventJson(call, result)
                "inviteSerialize" -> handleInviteSerialize(call, result)
                "inviteAccept" -> handleInviteAccept(call, result)
                "inviteGetInviterPubkeyHex" -> handleInviteGetInviterPubkeyHex(call, result)
                "inviteGetSharedSecretHex" -> handleInviteGetSharedSecretHex(call, result)
                "inviteDispose" -> handleInviteDispose(call, result)
                "sessionFromStateJson" -> handleSessionFromStateJson(call, result)
                "sessionInit" -> handleSessionInit(call, result)
                "sessionCanSend" -> handleSessionCanSend(call, result)
                "sessionSendText" -> handleSessionSendText(call, result)
                "sessionDecryptEvent" -> handleSessionDecryptEvent(call, result)
                "sessionStateJson" -> handleSessionStateJson(call, result)
                "sessionIsDrMessage" -> handleSessionIsDrMessage(call, result)
                "sessionDispose" -> handleSessionDispose(call, result)
                "sessionManagerNew" -> handleSessionManagerNew(call, result)
                "sessionManagerNewWithStoragePath" -> handleSessionManagerNewWithStoragePath(call, result)
                "sessionManagerInit" -> handleSessionManagerInit(call, result)
                "sessionManagerSendText" -> handleSessionManagerSendText(call, result)
                "sessionManagerImportSessionState" -> handleSessionManagerImportSessionState(call, result)
                "sessionManagerGetActiveSessionState" -> handleSessionManagerGetActiveSessionState(call, result)
                "sessionManagerProcessEvent" -> handleSessionManagerProcessEvent(call, result)
                "sessionManagerDrainEvents" -> handleSessionManagerDrainEvents(call, result)
                "sessionManagerGetDeviceId" -> handleSessionManagerGetDeviceId(call, result)
                "sessionManagerGetOurPubkeyHex" -> handleSessionManagerGetOurPubkeyHex(call, result)
                "sessionManagerGetTotalSessions" -> handleSessionManagerGetTotalSessions(call, result)
                "sessionManagerDispose" -> handleSessionManagerDispose(call, result)
                else -> result.notImplemented()
            }
        } catch (e: IllegalArgumentException) {
            result.error("InvalidArguments", e.message, null)
        } catch (e: NdrException) {
            result.error("NdrError", e.message, null)
        } catch (e: Exception) {
            result.error("NdrError", e.message, e.stackTraceToString())
        }
    }

    // MARK: - Version

    private fun handleVersion(result: Result) {
        result.success(version())
    }

    // MARK: - Keypair

    private fun handleGenerateKeypair(result: Result) {
        val keypair = generateKeypair()
        result.success(mapOf(
            "publicKeyHex" to keypair.publicKeyHex,
            "privateKeyHex" to keypair.privateKeyHex
        ))
    }

    private fun handleDerivePublicKey(call: MethodCall, result: Result) {
        val privkeyHex = call.argument<String>("privkeyHex")
            ?: throw IllegalArgumentException("Missing privkeyHex")

        // Generate a keypair and use secp256k1 to derive public key
        // For now, we'll generate a new keypair and return its public key
        // TODO: Add derivePublicKey to ndr-ffi Rust library
        result.error("NotImplemented", "derivePublicKey not yet in ndr-ffi library", null)
    }

    // MARK: - Invite Creation

    private fun handleCreateInvite(call: MethodCall, result: Result) {
        val inviterPubkeyHex = call.argument<String>("inviterPubkeyHex")
            ?: throw IllegalArgumentException("Missing inviterPubkeyHex")
        val deviceId = call.argument<String>("deviceId")
        val maxUses = call.argument<Int>("maxUses")?.toUInt()

        val invite = InviteHandle.createNew(inviterPubkeyHex, deviceId, maxUses)
        val id = generateHandleId()
        inviteHandles[id] = invite
        result.success(mapOf("id" to id))
    }

    private fun handleInviteFromUrl(call: MethodCall, result: Result) {
        val url = call.argument<String>("url")
            ?: throw IllegalArgumentException("Missing url")

        val invite = InviteHandle.fromUrl(url)
        val id = generateHandleId()
        inviteHandles[id] = invite
        result.success(mapOf("id" to id))
    }

    private fun handleInviteFromEventJson(call: MethodCall, result: Result) {
        val eventJson = call.argument<String>("eventJson")
            ?: throw IllegalArgumentException("Missing eventJson")

        val invite = InviteHandle.fromEventJson(eventJson)
        val id = generateHandleId()
        inviteHandles[id] = invite
        result.success(mapOf("id" to id))
    }

    private fun handleInviteDeserialize(call: MethodCall, result: Result) {
        val json = call.argument<String>("json")
            ?: throw IllegalArgumentException("Missing json")

        val invite = InviteHandle.deserialize(json)
        val id = generateHandleId()
        inviteHandles[id] = invite
        result.success(mapOf("id" to id))
    }

    // MARK: - Invite Methods

    private fun handleInviteToUrl(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")
        val root = call.argument<String>("root")
            ?: throw IllegalArgumentException("Missing root")

        val invite = inviteHandles[id]
            ?: throw IllegalArgumentException("Invite handle not found: $id")
        val url = invite.toUrl(root)
        result.success(url)
    }

    private fun handleInviteToEventJson(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")

        val invite = inviteHandles[id]
            ?: throw IllegalArgumentException("Invite handle not found: $id")
        val eventJson = invite.toEventJson()
        result.success(eventJson)
    }

    private fun handleInviteSerialize(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")

        val invite = inviteHandles[id]
            ?: throw IllegalArgumentException("Invite handle not found: $id")
        val json = invite.serialize()
        result.success(json)
    }

    private fun handleInviteAccept(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")
        val inviteePubkeyHex = call.argument<String>("inviteePubkeyHex")
            ?: throw IllegalArgumentException("Missing inviteePubkeyHex")
        val inviteePrivkeyHex = call.argument<String>("inviteePrivkeyHex")
            ?: throw IllegalArgumentException("Missing inviteePrivkeyHex")
        val deviceId = call.argument<String>("deviceId")

        val invite = inviteHandles[id]
            ?: throw IllegalArgumentException("Invite handle not found: $id")
        val acceptResult = invite.accept(inviteePubkeyHex, inviteePrivkeyHex, deviceId)
        val sessionId = generateHandleId()
        sessionHandles[sessionId] = acceptResult.session
        result.success(mapOf(
            "session" to mapOf("id" to sessionId),
            "responseEventJson" to acceptResult.responseEventJson
        ))
    }

    private fun handleInviteGetInviterPubkeyHex(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")

        val invite = inviteHandles[id]
            ?: throw IllegalArgumentException("Invite handle not found: $id")
        result.success(invite.getInviterPubkeyHex())
    }

    private fun handleInviteGetSharedSecretHex(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")

        val invite = inviteHandles[id]
            ?: throw IllegalArgumentException("Invite handle not found: $id")
        result.success(invite.getSharedSecretHex())
    }

    private fun handleInviteDispose(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")
        inviteHandles.remove(id)?.close()
        result.success(null)
    }

    // MARK: - Session Creation

    private fun handleSessionFromStateJson(call: MethodCall, result: Result) {
        val stateJson = call.argument<String>("stateJson")
            ?: throw IllegalArgumentException("Missing stateJson")

        val session = SessionHandle.fromStateJson(stateJson)
        val id = generateHandleId()
        sessionHandles[id] = session
        result.success(mapOf("id" to id))
    }

    private fun handleSessionInit(call: MethodCall, result: Result) {
        val theirEphemeralPubkeyHex = call.argument<String>("theirEphemeralPubkeyHex")
            ?: throw IllegalArgumentException("Missing theirEphemeralPubkeyHex")
        val ourEphemeralPrivkeyHex = call.argument<String>("ourEphemeralPrivkeyHex")
            ?: throw IllegalArgumentException("Missing ourEphemeralPrivkeyHex")
        val isInitiator = call.argument<Boolean>("isInitiator")
            ?: throw IllegalArgumentException("Missing isInitiator")
        val sharedSecretHex = call.argument<String>("sharedSecretHex")
            ?: throw IllegalArgumentException("Missing sharedSecretHex")
        val name = call.argument<String>("name")

        val session = SessionHandle.init(
            theirEphemeralPubkeyHex,
            ourEphemeralPrivkeyHex,
            isInitiator,
            sharedSecretHex,
            name
        )
        val id = generateHandleId()
        sessionHandles[id] = session
        result.success(mapOf("id" to id))
    }

    // MARK: - Session Methods

    private fun handleSessionCanSend(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")

        val session = sessionHandles[id]
            ?: throw IllegalArgumentException("Session handle not found: $id")
        result.success(session.canSend())
    }

    private fun handleSessionSendText(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")
        val text = call.argument<String>("text")
            ?: throw IllegalArgumentException("Missing text")

        val session = sessionHandles[id]
            ?: throw IllegalArgumentException("Session handle not found: $id")
        val sendResult = session.sendText(text)
        result.success(mapOf(
            "outerEventJson" to sendResult.outerEventJson,
            "innerEventJson" to sendResult.innerEventJson
        ))
    }

    private fun handleSessionDecryptEvent(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")
        val outerEventJson = call.argument<String>("outerEventJson")
            ?: throw IllegalArgumentException("Missing outerEventJson")

        val session = sessionHandles[id]
            ?: throw IllegalArgumentException("Session handle not found: $id")
        val decryptResult = session.decryptEvent(outerEventJson)
        result.success(mapOf(
            "plaintext" to decryptResult.plaintext,
            "innerEventJson" to decryptResult.innerEventJson
        ))
    }

    private fun handleSessionStateJson(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")

        val session = sessionHandles[id]
            ?: throw IllegalArgumentException("Session handle not found: $id")
        val stateJson = session.stateJson()
        result.success(stateJson)
    }

    private fun handleSessionIsDrMessage(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")
        val eventJson = call.argument<String>("eventJson")
            ?: throw IllegalArgumentException("Missing eventJson")

        val session = sessionHandles[id]
            ?: throw IllegalArgumentException("Session handle not found: $id")
        result.success(session.isDrMessage(eventJson))
    }

    private fun handleSessionDispose(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")
        sessionHandles.remove(id)?.close()
        result.success(null)
    }

    // MARK: - Session Manager

    private fun handleSessionManagerNew(call: MethodCall, result: Result) {
        val ourPubkeyHex = call.argument<String>("ourPubkeyHex")
            ?: throw IllegalArgumentException("Missing ourPubkeyHex")
        val ourIdentityPrivkeyHex = call.argument<String>("ourIdentityPrivkeyHex")
            ?: throw IllegalArgumentException("Missing ourIdentityPrivkeyHex")
        val deviceId = call.argument<String>("deviceId")
            ?: throw IllegalArgumentException("Missing deviceId")

        val manager = SessionManagerHandle(ourPubkeyHex, ourIdentityPrivkeyHex, deviceId)
        val id = generateHandleId()
        sessionManagerHandles[id] = manager
        result.success(mapOf("id" to id))
    }

    private fun handleSessionManagerNewWithStoragePath(call: MethodCall, result: Result) {
        val ourPubkeyHex = call.argument<String>("ourPubkeyHex")
            ?: throw IllegalArgumentException("Missing ourPubkeyHex")
        val ourIdentityPrivkeyHex = call.argument<String>("ourIdentityPrivkeyHex")
            ?: throw IllegalArgumentException("Missing ourIdentityPrivkeyHex")
        val deviceId = call.argument<String>("deviceId")
            ?: throw IllegalArgumentException("Missing deviceId")
        val storagePath = call.argument<String>("storagePath")
            ?: throw IllegalArgumentException("Missing storagePath")

        val manager = SessionManagerHandle.newWithStoragePath(
            ourPubkeyHex,
            ourIdentityPrivkeyHex,
            deviceId,
            storagePath,
        )
        val id = generateHandleId()
        sessionManagerHandles[id] = manager
        result.success(mapOf("id" to id))
    }

    private fun handleSessionManagerInit(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")

        val manager = sessionManagerHandles[id]
            ?: throw IllegalArgumentException("SessionManager handle not found: $id")
        manager.init()
        result.success(null)
    }

    private fun handleSessionManagerSendText(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")
        val recipientPubkeyHex = call.argument<String>("recipientPubkeyHex")
            ?: throw IllegalArgumentException("Missing recipientPubkeyHex")
        val text = call.argument<String>("text")
            ?: throw IllegalArgumentException("Missing text")

        val manager = sessionManagerHandles[id]
            ?: throw IllegalArgumentException("SessionManager handle not found: $id")
        val eventIds = manager.sendText(recipientPubkeyHex, text)
        result.success(eventIds)
    }

    private fun handleSessionManagerImportSessionState(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")
        val peerPubkeyHex = call.argument<String>("peerPubkeyHex")
            ?: throw IllegalArgumentException("Missing peerPubkeyHex")
        val stateJson = call.argument<String>("stateJson")
            ?: throw IllegalArgumentException("Missing stateJson")
        val deviceId = call.argument<String>("deviceId")

        val manager = sessionManagerHandles[id]
            ?: throw IllegalArgumentException("SessionManager handle not found: $id")
        manager.importSessionState(peerPubkeyHex, stateJson, deviceId)
        result.success(null)
    }

    private fun handleSessionManagerGetActiveSessionState(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")
        val peerPubkeyHex = call.argument<String>("peerPubkeyHex")
            ?: throw IllegalArgumentException("Missing peerPubkeyHex")

        val manager = sessionManagerHandles[id]
            ?: throw IllegalArgumentException("SessionManager handle not found: $id")
        val stateJson = manager.getActiveSessionState(peerPubkeyHex)
        result.success(stateJson)
    }

    private fun handleSessionManagerProcessEvent(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")
        val eventJson = call.argument<String>("eventJson")
            ?: throw IllegalArgumentException("Missing eventJson")

        val manager = sessionManagerHandles[id]
            ?: throw IllegalArgumentException("SessionManager handle not found: $id")
        manager.processEvent(eventJson)
        result.success(null)
    }

    private fun handleSessionManagerDrainEvents(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")

        val manager = sessionManagerHandles[id]
            ?: throw IllegalArgumentException("SessionManager handle not found: $id")
        val events = manager.drainEvents().map { event ->
            mapOf(
                "kind" to event.kind,
                "subid" to event.subid,
                "filterJson" to event.filterJson,
                "eventJson" to event.eventJson,
                "senderPubkeyHex" to event.senderPubkeyHex,
                "content" to event.content,
                "eventId" to event.eventId,
            )
        }
        result.success(events)
    }

    private fun handleSessionManagerGetDeviceId(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")

        val manager = sessionManagerHandles[id]
            ?: throw IllegalArgumentException("SessionManager handle not found: $id")
        result.success(manager.getDeviceId())
    }

    private fun handleSessionManagerGetOurPubkeyHex(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")

        val manager = sessionManagerHandles[id]
            ?: throw IllegalArgumentException("SessionManager handle not found: $id")
        result.success(manager.getOurPubkeyHex())
    }

    private fun handleSessionManagerGetTotalSessions(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")

        val manager = sessionManagerHandles[id]
            ?: throw IllegalArgumentException("SessionManager handle not found: $id")
        result.success(manager.getTotalSessions().toLong())
    }

    private fun handleSessionManagerDispose(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")
        sessionManagerHandles.remove(id)?.close()
        result.success(null)
    }
}
