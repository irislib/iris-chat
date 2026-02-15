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
                "createSignedAppKeysEvent" -> handleCreateSignedAppKeysEvent(call, result)
                "parseAppKeysEvent" -> handleParseAppKeysEvent(call, result)
                "createInvite" -> handleCreateInvite(call, result)
                "inviteFromUrl" -> handleInviteFromUrl(call, result)
                "inviteFromEventJson" -> handleInviteFromEventJson(call, result)
                "inviteDeserialize" -> handleInviteDeserialize(call, result)
                "inviteToUrl" -> handleInviteToUrl(call, result)
                "inviteToEventJson" -> handleInviteToEventJson(call, result)
                "inviteSerialize" -> handleInviteSerialize(call, result)
                "inviteAccept" -> handleInviteAccept(call, result)
                "inviteAcceptWithOwner" -> handleInviteAcceptWithOwner(call, result)
                "inviteSetPurpose" -> handleInviteSetPurpose(call, result)
                "inviteSetOwnerPubkeyHex" -> handleInviteSetOwnerPubkeyHex(call, result)
                "inviteGetInviterPubkeyHex" -> handleInviteGetInviterPubkeyHex(call, result)
                "inviteGetSharedSecretHex" -> handleInviteGetSharedSecretHex(call, result)
                "inviteProcessResponse" -> handleInviteProcessResponse(call, result)
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
                "sessionManagerAcceptInviteFromUrl" -> handleSessionManagerAcceptInviteFromUrl(call, result)
                "sessionManagerAcceptInviteFromEventJson" -> handleSessionManagerAcceptInviteFromEventJson(call, result)
                "sessionManagerSendText" -> handleSessionManagerSendText(call, result)
                "sessionManagerSendTextWithInnerId" -> handleSessionManagerSendTextWithInnerId(call, result)
                "sessionManagerSendEventWithInnerId" -> handleSessionManagerSendEventWithInnerId(call, result)
                "sessionManagerSendReceipt" -> handleSessionManagerSendReceipt(call, result)
                "sessionManagerSendTyping" -> handleSessionManagerSendTyping(call, result)
                "sessionManagerSendReaction" -> handleSessionManagerSendReaction(call, result)
                "sessionManagerImportSessionState" -> handleSessionManagerImportSessionState(call, result)
                "sessionManagerGetActiveSessionState" -> handleSessionManagerGetActiveSessionState(call, result)
                "sessionManagerProcessEvent" -> handleSessionManagerProcessEvent(call, result)
                "sessionManagerDrainEvents" -> handleSessionManagerDrainEvents(call, result)
                "sessionManagerGetDeviceId" -> handleSessionManagerGetDeviceId(call, result)
                "sessionManagerGetOurPubkeyHex" -> handleSessionManagerGetOurPubkeyHex(call, result)
                "sessionManagerGetOwnerPubkeyHex" -> handleSessionManagerGetOwnerPubkeyHex(call, result)
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

        result.success(derivePublicKey(privkeyHex))
    }

    // MARK: - AppKeys

    private fun handleCreateSignedAppKeysEvent(call: MethodCall, result: Result) {
        val ownerPubkeyHex = call.argument<String>("ownerPubkeyHex")
            ?: throw IllegalArgumentException("Missing ownerPubkeyHex")
        val ownerPrivkeyHex = call.argument<String>("ownerPrivkeyHex")
            ?: throw IllegalArgumentException("Missing ownerPrivkeyHex")

        val devicesArg = call.argument<List<Any>>("devices") ?: emptyList()
        val devices = devicesArg.mapNotNull { entry ->
            @Suppress("UNCHECKED_CAST")
            val map = entry as? Map<String, Any?> ?: return@mapNotNull null
            val identity = map["identityPubkeyHex"] as? String ?: return@mapNotNull null
            val createdAt = (map["createdAt"] as? Number)?.toLong() ?: 0L
            FfiDeviceEntry(identity, createdAt.toULong())
        }

        val eventJson = createSignedAppKeysEvent(ownerPubkeyHex, ownerPrivkeyHex, devices)
        result.success(eventJson)
    }

    private fun handleParseAppKeysEvent(call: MethodCall, result: Result) {
        val eventJson = call.argument<String>("eventJson")
            ?: throw IllegalArgumentException("Missing eventJson")

        val devices = parseAppKeysEvent(eventJson).map { d ->
            mapOf(
                "identityPubkeyHex" to d.identityPubkeyHex,
                "createdAt" to d.createdAt.toLong(),
            )
        }
        result.success(devices)
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

    private fun handleInviteAcceptWithOwner(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")
        val inviteePubkeyHex = call.argument<String>("inviteePubkeyHex")
            ?: throw IllegalArgumentException("Missing inviteePubkeyHex")
        val inviteePrivkeyHex = call.argument<String>("inviteePrivkeyHex")
            ?: throw IllegalArgumentException("Missing inviteePrivkeyHex")
        val deviceId = call.argument<String>("deviceId")
        val ownerPubkeyHex = call.argument<String>("ownerPubkeyHex")

        val invite = inviteHandles[id]
            ?: throw IllegalArgumentException("Invite handle not found: $id")
        val acceptResult = invite.acceptWithOwner(inviteePubkeyHex, inviteePrivkeyHex, deviceId, ownerPubkeyHex)
        val sessionId = generateHandleId()
        sessionHandles[sessionId] = acceptResult.session
        result.success(mapOf(
            "session" to mapOf("id" to sessionId),
            "responseEventJson" to acceptResult.responseEventJson
        ))
    }

    private fun handleInviteSetPurpose(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")
        val purpose = call.argument<String>("purpose")

        val invite = inviteHandles[id]
            ?: throw IllegalArgumentException("Invite handle not found: $id")
        invite.setPurpose(purpose)
        result.success(null)
    }

    private fun handleInviteSetOwnerPubkeyHex(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")
        val ownerPubkeyHex = call.argument<String>("ownerPubkeyHex")

        val invite = inviteHandles[id]
            ?: throw IllegalArgumentException("Invite handle not found: $id")
        invite.setOwnerPubkeyHex(ownerPubkeyHex)
        result.success(null)
    }

    private fun handleInviteProcessResponse(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")
        val eventJson = call.argument<String>("eventJson")
            ?: throw IllegalArgumentException("Missing eventJson")
        val inviterPrivkeyHex = call.argument<String>("inviterPrivkeyHex")
            ?: throw IllegalArgumentException("Missing inviterPrivkeyHex")

        val invite = inviteHandles[id]
            ?: throw IllegalArgumentException("Invite handle not found: $id")

        val processResult = invite.processResponse(eventJson, inviterPrivkeyHex)
        if (processResult == null) {
            result.success(null)
            return
        }

        val sessionId = generateHandleId()
        sessionHandles[sessionId] = processResult.session
        result.success(mapOf(
            "session" to mapOf("id" to sessionId),
            "inviteePubkeyHex" to processResult.inviteePubkeyHex,
            "deviceId" to processResult.deviceId,
            "ownerPubkeyHex" to processResult.ownerPubkeyHex,
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
        val ownerPubkeyHex = call.argument<String>("ownerPubkeyHex")

        val manager = SessionManagerHandle(ourPubkeyHex, ourIdentityPrivkeyHex, deviceId, ownerPubkeyHex)
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
        val ownerPubkeyHex = call.argument<String>("ownerPubkeyHex")

        val manager = SessionManagerHandle.newWithStoragePath(
            ourPubkeyHex,
            ourIdentityPrivkeyHex,
            deviceId,
            storagePath,
            ownerPubkeyHex,
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

    private fun handleSessionManagerAcceptInviteFromUrl(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")
        val inviteUrl = call.argument<String>("inviteUrl")
            ?: throw IllegalArgumentException("Missing inviteUrl")
        val ownerPubkeyHintHex = call.argument<String>("ownerPubkeyHintHex")

        val manager = sessionManagerHandles[id]
            ?: throw IllegalArgumentException("SessionManager handle not found: $id")
        val acceptResult = manager.acceptInviteFromUrl(inviteUrl, ownerPubkeyHintHex)
        result.success(
            mapOf(
                "ownerPubkeyHex" to acceptResult.ownerPubkeyHex,
                "inviterDevicePubkeyHex" to acceptResult.inviterDevicePubkeyHex,
                "deviceId" to acceptResult.deviceId,
                "createdNewSession" to acceptResult.createdNewSession,
            ),
        )
    }

    private fun handleSessionManagerAcceptInviteFromEventJson(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")
        val eventJson = call.argument<String>("eventJson")
            ?: throw IllegalArgumentException("Missing eventJson")
        val ownerPubkeyHintHex = call.argument<String>("ownerPubkeyHintHex")

        val manager = sessionManagerHandles[id]
            ?: throw IllegalArgumentException("SessionManager handle not found: $id")
        val acceptResult = manager.acceptInviteFromEventJson(eventJson, ownerPubkeyHintHex)
        result.success(
            mapOf(
                "ownerPubkeyHex" to acceptResult.ownerPubkeyHex,
                "inviterDevicePubkeyHex" to acceptResult.inviterDevicePubkeyHex,
                "deviceId" to acceptResult.deviceId,
                "createdNewSession" to acceptResult.createdNewSession,
            ),
        )
    }

    private fun handleSessionManagerSendText(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")
        val recipientPubkeyHex = call.argument<String>("recipientPubkeyHex")
            ?: throw IllegalArgumentException("Missing recipientPubkeyHex")
        val text = call.argument<String>("text")
            ?: throw IllegalArgumentException("Missing text")
        val expiresAtSeconds = (call.argument<Number>("expiresAtSeconds"))?.toLong()?.toULong()

        val manager = sessionManagerHandles[id]
            ?: throw IllegalArgumentException("SessionManager handle not found: $id")
        val eventIds = manager.sendText(recipientPubkeyHex, text, expiresAtSeconds)
        result.success(eventIds)
    }

    private fun handleSessionManagerSendTextWithInnerId(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")
        val recipientPubkeyHex = call.argument<String>("recipientPubkeyHex")
            ?: throw IllegalArgumentException("Missing recipientPubkeyHex")
        val text = call.argument<String>("text")
            ?: throw IllegalArgumentException("Missing text")
        val expiresAtSeconds = (call.argument<Number>("expiresAtSeconds"))?.toLong()?.toULong()

        val manager = sessionManagerHandles[id]
            ?: throw IllegalArgumentException("SessionManager handle not found: $id")
        val sendResult = manager.sendTextWithInnerId(recipientPubkeyHex, text, expiresAtSeconds)
        result.success(mapOf(
            "innerId" to sendResult.innerId,
            "outerEventIds" to sendResult.outerEventIds,
        ))
    }

    private fun handleSessionManagerSendEventWithInnerId(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")
        val recipientPubkeyHex = call.argument<String>("recipientPubkeyHex")
            ?: throw IllegalArgumentException("Missing recipientPubkeyHex")
        val kind = call.argument<Int>("kind")
            ?: throw IllegalArgumentException("Missing kind")
        val content = call.argument<String>("content")
            ?: throw IllegalArgumentException("Missing content")
        val tagsJson = call.argument<String>("tagsJson")
            ?: throw IllegalArgumentException("Missing tagsJson")
        val createdAtSeconds = (call.argument<Number>("createdAtSeconds"))?.toLong()?.toULong()

        val manager = sessionManagerHandles[id]
            ?: throw IllegalArgumentException("SessionManager handle not found: $id")
        val sendResult = manager.sendEventWithInnerId(
            recipientPubkeyHex,
            kind.toUInt(),
            content,
            tagsJson,
            createdAtSeconds,
        )
        result.success(
            mapOf(
                "innerId" to sendResult.innerId,
                "outerEventIds" to sendResult.outerEventIds,
            ),
        )
    }

    private fun handleSessionManagerSendReceipt(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")
        val recipientPubkeyHex = call.argument<String>("recipientPubkeyHex")
            ?: throw IllegalArgumentException("Missing recipientPubkeyHex")
        val receiptType = call.argument<String>("receiptType")
            ?: throw IllegalArgumentException("Missing receiptType")
        val messageIds = call.argument<List<String>>("messageIds")
            ?: throw IllegalArgumentException("Missing messageIds")
        val expiresAtSeconds = (call.argument<Number>("expiresAtSeconds"))?.toLong()?.toULong()

        val manager = sessionManagerHandles[id]
            ?: throw IllegalArgumentException("SessionManager handle not found: $id")
        val eventIds = manager.sendReceipt(recipientPubkeyHex, receiptType, messageIds, expiresAtSeconds)
        result.success(eventIds)
    }

    private fun handleSessionManagerSendTyping(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")
        val recipientPubkeyHex = call.argument<String>("recipientPubkeyHex")
            ?: throw IllegalArgumentException("Missing recipientPubkeyHex")
        val expiresAtSeconds = (call.argument<Number>("expiresAtSeconds"))?.toLong()?.toULong()

        val manager = sessionManagerHandles[id]
            ?: throw IllegalArgumentException("SessionManager handle not found: $id")
        val eventIds = manager.sendTyping(recipientPubkeyHex, expiresAtSeconds)
        result.success(eventIds)
    }

    private fun handleSessionManagerSendReaction(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")
        val recipientPubkeyHex = call.argument<String>("recipientPubkeyHex")
            ?: throw IllegalArgumentException("Missing recipientPubkeyHex")
        val messageId = call.argument<String>("messageId")
            ?: throw IllegalArgumentException("Missing messageId")
        val emoji = call.argument<String>("emoji")
            ?: throw IllegalArgumentException("Missing emoji")
        val expiresAtSeconds = (call.argument<Number>("expiresAtSeconds"))?.toLong()?.toULong()

        val manager = sessionManagerHandles[id]
            ?: throw IllegalArgumentException("SessionManager handle not found: $id")
        val eventIds = manager.sendReaction(recipientPubkeyHex, messageId, emoji, expiresAtSeconds)
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

    private fun handleSessionManagerGetOwnerPubkeyHex(call: MethodCall, result: Result) {
        val id = call.argument<String>("id")
            ?: throw IllegalArgumentException("Missing id")

        val manager = sessionManagerHandles[id]
            ?: throw IllegalArgumentException("SessionManager handle not found: $id")
        result.success(manager.getOwnerPubkeyHex())
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
