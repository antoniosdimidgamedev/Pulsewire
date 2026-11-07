package dev.pulsewire.android.data

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** Minimal Android client for the Pulsewire `/v1` JSON API. */
class PulsewireApi(
    baseUrl: String,
    private val token: String? = null,
) {
    val baseUrl: String = normalizeBaseUrl(baseUrl)

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .build()

    suspend fun register(handle: String, displayName: String, password: String): AuthResponse =
        decode(
            execute(
                method = "POST",
                path = "v1/auth/register",
                body = json.encodeToString(RegisterRequest(handle, displayName, password)),
                authenticated = false,
            ),
        )

    suspend fun login(handle: String, password: String): AuthResponse =
        decode(
            execute(
                method = "POST",
                path = "v1/auth/login",
                body = json.encodeToString(LoginRequest(handle, password)),
                authenticated = false,
            ),
        )

    suspend fun logout() {
        execute("POST", "v1/auth/logout")
    }

    suspend fun me(): User = decode<UserResponse>(execute("GET", "v1/me")).user

    suspend fun updateProfile(displayName: String? = null, handle: String? = null): User =
        decode<UserResponse>(
            execute(
                "PATCH",
                "v1/me",
                body = json.encodeToString(
                    UpdateProfileRequest(
                        displayName = displayName?.takeIf { it.isNotBlank() },
                        handle = handle?.takeIf { it.isNotBlank() },
                    ),
                ),
            ),
        ).user

    suspend fun searchUsers(query: String): List<User> =
        decode<UserListResponse>(
            execute("GET", "v1/users", query = mapOf("query" to query)),
        ).users

    suspend fun listConversations(): List<Conversation> =
        decode<ConversationListResponse>(execute("GET", "v1/conversations")).conversations

    suspend fun getConversation(conversationId: String): Conversation =
        decode<ConversationResponse>(
            execute("GET", "v1/conversations/$conversationId"),
        ).conversation

    suspend fun createConversation(
        kind: String,
        name: String?,
        topic: String?,
        memberHandles: List<String>,
    ): Conversation =
        decode<ConversationResponse>(
            execute(
                "POST",
                "v1/conversations",
                body = json.encodeToString(
                    CreateConversationRequest(
                        kind = kind,
                        name = name?.takeIf { it.isNotBlank() },
                        topic = topic?.takeIf { it.isNotBlank() },
                        memberHandles = memberHandles,
                    ),
                ),
            ),
        ).conversation

    suspend fun getMessages(
        conversationId: String,
        limit: Int = 50,
        before: Long? = null,
    ): MessagePageResponse =
        decode(
            execute(
                "GET",
                "v1/conversations/$conversationId/messages",
                query = buildMap {
                    put("limit", limit.toString())
                    if (before != null) put("before", before.toString())
                },
            ),
        )

    suspend fun sendMessage(conversationId: String, body: String): Message =
        decode<MessageResponse>(
            execute(
                "POST",
                "v1/conversations/$conversationId/messages",
                body = json.encodeToString(SendMessageRequest(body)),
            ),
        ).message

    suspend fun editMessage(messageId: String, body: String): Message =
        decode<MessageResponse>(
            execute(
                "PATCH",
                "v1/messages/$messageId",
                body = json.encodeToString(EditMessageRequest(body)),
            ),
        ).message

    suspend fun deleteMessage(messageId: String) {
        execute("DELETE", "v1/messages/$messageId")
    }

    suspend fun search(query: String): List<SearchResult> =
        decode<SearchResponse>(
            execute("GET", "v1/search", query = mapOf("query" to query)),
        ).results

    suspend fun markRead(conversationId: String): Conversation =
        decode<ConversationResponse>(
            execute("POST", "v1/conversations/$conversationId/read"),
        ).conversation

    suspend fun listMembers(conversationId: String): List<MemberRecord> =
        decode<MemberListResponse>(
            execute("GET", "v1/conversations/$conversationId/members"),
        ).members

    suspend fun addMember(conversationId: String, handle: String): Conversation =
        decode<ConversationResponse>(
            execute(
                "POST",
                "v1/conversations/$conversationId/members",
                body = json.encodeToString(AddMemberRequest(handle)),
            ),
        ).conversation

    suspend fun removeMember(conversationId: String, userId: String) {
        execute("DELETE", "v1/conversations/$conversationId/members/$userId")
    }

    suspend fun leaveConversation(conversationId: String) {
        execute("POST", "v1/conversations/$conversationId/leave")
    }

    suspend fun headEvents(): Long =
        decode<HeadEventResponse>(execute("GET", "v1/events/head")).seq

    suspend fun getEvents(after: Long, limit: Int = 100): EventListResponse =
        decode(
            execute(
                "GET",
                "v1/events",
                query = mapOf("after" to after.toString(), "limit" to limit.toString()),
            ),
        )

    private suspend fun execute(
        method: String,
        path: String,
        body: String? = null,
        query: Map<String, String?> = emptyMap(),
        authenticated: Boolean = true,
    ): String? = withContext(Dispatchers.IO) {
        val builder = Request.Builder()
            .url(buildUrl(path, query))
            .header("Accept", "application/json")
        if (authenticated) {
            token?.let { builder.header("Authorization", "Bearer $it") }
        }

        val requestBody = when {
            body != null -> body.toRequestBody(JSON_MEDIA_TYPE)
            method == "POST" || method == "PATCH" -> ByteArray(0).toRequestBody(null)
            else -> null
        }
        builder.method(method, requestBody)

        try {
            client.newCall(builder.build()).execute().use { response ->
                val text = response.body?.string()
                if (!response.isSuccessful) {
                    val parsed = runCatching {
                        json.decodeFromString<ErrorEnvelope>(text.orEmpty())
                    }.getOrNull()
                    val message = parsed?.error?.message
                        ?.takeIf { it.isNotBlank() }
                        ?: "The server returned HTTP ${response.code}."
                    throw ApiException(message, parsed?.error?.code.orEmpty(), response.code)
                }
                text
            }
        } catch (error: ApiException) {
            throw error
        } catch (error: IOException) {
            throw ApiException(
                "Could not reach Pulsewire at $baseUrl. Check the address, Wi-Fi, and that the server is running.",
                code = "network_error",
            )
        }
    }

    private fun buildUrl(path: String, query: Map<String, String?>): HttpUrl {
        val builder = baseUrl.toHttpUrl().newBuilder()
        path.trim('/').split('/').filter { it.isNotEmpty() }.forEach(builder::addPathSegment)
        query.forEach { (key, value) ->
            if (value != null) builder.addQueryParameter(key, value)
        }
        return builder.build()
    }

    private inline fun <reified T> decode(text: String?): T {
        if (text.isNullOrBlank()) {
            throw ApiException("The server returned an empty response.", code = "invalid_response")
        }
        return try {
            json.decodeFromString<T>(text)
        } catch (error: Exception) {
            throw ApiException("The server returned an invalid response.", code = "invalid_response")
        }
    }

    companion object {
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        private val json = Json {
            ignoreUnknownKeys = true
            explicitNulls = false
            coerceInputValues = true
        }

        fun normalizeBaseUrl(input: String): String {
            var value = input.trim()
            if (value.isEmpty()) throw ApiException("Enter the Pulsewire server address.")
            if (!value.startsWith("http://", ignoreCase = true) &&
                !value.startsWith("https://", ignoreCase = true)
            ) {
                value = "http://$value"
            }
            value = value.trimEnd('/')
            val parsed = value.toHttpUrlOrNull()
                ?: throw ApiException("That server address is not a valid URL.")
            if (parsed.host.isBlank()) throw ApiException("That server address is not a valid URL.")
            return parsed.toString().trimEnd('/')
        }
    }
}
