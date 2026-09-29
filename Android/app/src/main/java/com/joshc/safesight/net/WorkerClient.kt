package com.joshc.safesight.net

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Thin client for the SafeSight Cloudflare Worker (worker/worker.js).
 * Mirrors the fetch calls in chrome/popup.js so the account, device limit and
 * PIN semantics stay identical across platforms.
 */
object WorkerClient {
    // TODO: same deployed worker the extensions use.
    const val WORKER_URL = "https://safesight.funbyte.net"

    // Keep in step with MAX_DEVICES in worker.js / popup.js.
    const val MAX_DEVICES = 2

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    sealed class RegisterResult {
        data class Success(
            val clientId: String,
            val email: String,
            val accountName: String,
            val pin: String?,
            val rejoined: Boolean,
            val newAccount: Boolean,
            /** "pending" until the admin approves — the device stays locked. */
            val status: String,
        ) : RegisterResult()

        data class Failure(val error: String, val deviceLimit: Int) : RegisterResult()
        data class Network(val message: String) : RegisterResult()
    }

    sealed class VerifyResult {
        data object Ok : VerifyResult()
        data class WrongPin(val locked: Boolean, val retrySeconds: Int) : VerifyResult()
        data object UnknownClient : VerifyResult()

        /** Account registered but not yet approved: no PIN, nothing to verify. */
        data object AccountPending : VerifyResult()

        data class Network(val message: String) : VerifyResult()
    }

    sealed class DeviceRequestResult {
        /** alreadyAvailable: space freed up before we asked — just register. */
        data class Ok(val ticket: Long, val alreadyAvailable: Boolean) : DeviceRequestResult()
        data class Failure(val error: String) : DeviceRequestResult()
        data class Network(val message: String) : DeviceRequestResult()
    }

    /**
     * POST /api/device-request — files a pending device slot request the admin
     * can approve in the console (worker.js bumps deviceLimit on approve).
     */
    suspend fun deviceRequest(
        email: String,
        deviceId: String,
        device: String,
        version: String,
    ): DeviceRequestResult = withContext(Dispatchers.IO) {
        val body = JSONObject()
            .put("email", email)
            .put("deviceId", deviceId)
            .put("device", device)
            .put("version", version)
        post("/api/device-request", body).fold(
            onSuccess = { j ->
                when {
                    j.optBoolean("alreadyAvailable") ->
                        DeviceRequestResult.Ok(ticket = 0, alreadyAvailable = true)

                    j.optBoolean("ok") ->
                        DeviceRequestResult.Ok(
                            ticket = j.optLong("ticket"),
                            alreadyAvailable = false,
                        )

                    else -> DeviceRequestResult.Failure(j.optString("error", "unknown"))
                }
            },
            onFailure = { DeviceRequestResult.Network(it.message ?: "network error") },
        )
    }

    suspend fun register(
        email: String,
        accountName: String,
        invite: String,
        deviceId: String,
        device: String,
        version: String,
        ua: String,
    ): RegisterResult = withContext(Dispatchers.IO) {
        val body = JSONObject()
            .put("email", email)
            .put("accountName", accountName)
            .put("invite", invite)
            .put("deviceId", deviceId)
            .put("device", device)
            .put("version", version)
            .put("ua", ua)
        post("/api/register", body).fold(
            onSuccess = { j ->
                if (j.optBoolean("ok")) {
                    RegisterResult.Success(
                        clientId = j.getString("id"),
                        email = j.optString("email", email),
                        accountName = j.optString("accountName", accountName),
                        pin = if (j.isNull("pin")) null else j.optString("pin"),
                        rejoined = j.optBoolean("rejoined"),
                        newAccount = j.optBoolean("newAccount"),
                        status = j.optString("status", "approved"),
                    )
                } else {
                    RegisterResult.Failure(
                        error = j.optString("error", "unknown"),
                        deviceLimit = j.optInt("deviceLimit", MAX_DEVICES),
                    )
                }
            },
            onFailure = { RegisterResult.Network(it.message ?: "network error") },
        )
    }

    /** GET /api/account-status?id= — polls approval; pin only once approved. */
    suspend fun accountStatus(clientId: String): Pair<String, String?>? =
        withContext(Dispatchers.IO) {
            runCatching {
                val url = "$WORKER_URL/api/account-status?id=" +
                    java.net.URLEncoder.encode(clientId, "UTF-8")
                http.newCall(Request.Builder().url(url).build()).execute().use { resp ->
                    val j = JSONObject(resp.body?.string() ?: "{}")
                    if (!j.optBoolean("ok")) return@use null
                    val pin = if (j.isNull("pin")) null else j.optString("pin")
                    (j.optString("status", "approved") to pin)
                }
            }.getOrNull()
        }

    suspend fun verify(clientId: String, pin: String, action: String): VerifyResult =
        withContext(Dispatchers.IO) {
            val body = JSONObject()
                .put("id", clientId)
                .put("pin", pin)
                .put("action", action)
            post("/api/verify", body).fold(
                onSuccess = { j ->
                    when {
                        j.optBoolean("ok") -> VerifyResult.Ok
                        j.optString("error") == "unknown client" -> VerifyResult.UnknownClient
                        j.optString("error") == "account_pending" -> VerifyResult.AccountPending
                        else -> VerifyResult.WrongPin(
                            locked = j.optBoolean("locked"),
                            retrySeconds = j.optInt("retry", 0),
                        )
                    }
                },
                onFailure = { VerifyResult.Network(it.message ?: "network error") },
            )
        }

    suspend fun unlockRequest(clientId: String, action: String, detail: String): Boolean =
        withContext(Dispatchers.IO) {
            val body = JSONObject()
                .put("id", clientId)
                .put("action", action)
                .put("detail", detail)
            post("/api/unlock-request", body)
                .fold(onSuccess = { it.optBoolean("ok") }, onFailure = { false })
        }

    suspend fun unlockStatus(clientId: String, ticket: Long): String =
        withContext(Dispatchers.IO) {
            val url = "$WORKER_URL/api/unlock-status?id=$clientId&ticket=$ticket"
            runCatching {
                val resp = http.newCall(Request.Builder().url(url).build()).execute()
                resp.use { JSONObject(it.body?.string() ?: "{}").optString("status", "unknown") }
            }.getOrDefault("unknown")
        }

    private fun post(path: String, body: JSONObject): Result<JSONObject> = runCatching {
        val request = Request.Builder()
            .url(WORKER_URL + path)
            .post(body.toString().toRequestBody(jsonMedia))
            .build()
        http.newCall(request).execute().use { resp ->
            val text = resp.body?.string() ?: "{}"
            JSONObject(text)
        }
    }
}
