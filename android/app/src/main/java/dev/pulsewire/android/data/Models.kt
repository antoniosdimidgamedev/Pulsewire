package dev.pulsewire.android.data

import kotlinx.serialization.Serializable

@Serializable
data class User(
    val id: String,
    val displayName: String,
    val handle: String,
    val isAdmin: Boolean = false,
)

@Serializable
data class Conversation(
    val id: String,
    val kind: String,
    val name: String,
    val topic: String? = null,
    val members: List<User> = emptyList(),
    val unreadCount: Int = 0,
    val lastActivityAt: String = "",
    val lastMessagePreview: String = "",
    val lastMessageAt: String? = null,
    val lastReadAt: String? = null,
)

@Serializable
data class MessageDelivery(
    val status: String = "sent",
    val readBy: List<String> = emptyList(),
    val error: String? = null,
)

@Serializable
data class Message(
    val id: String,
    val conversationId: String,
    val author: User,
    val body: String,
    val createdAt: String,
    val editedAt: String? = null,
    val deletedAt: String? = null,
    val replyToId: String? = null,
    val delivery: MessageDelivery? = null,
)

@Serializable
data class SearchResult(
    val message: Message,
    val conversation: Conversation,
    val snippet: String = "",
)

@Serializable
data class MemberRecord(
    val user: User,
    val role: String = "member",
    val lastReadSeq: Long = 0,
)

@Serializable
data class AuthResponse(
    val user: User,
    val token: String,
    val expiresAt: String = "",
)

@Serializable
data class UserResponse(val user: User)

@Serializable
data class UserListResponse(val users: List<User> = emptyList())

@Serializable
data class ConversationResponse(val conversation: Conversation)

@Serializable
data class ConversationListResponse(val conversations: List<Conversation> = emptyList())

@Serializable
data class MessageResponse(val message: Message)

@Serializable
data class MessagePageResponse(
    val messages: List<Message> = emptyList(),
    val hasMore: Boolean = false,
    val nextBefore: Long? = null,
)

@Serializable
data class MessageListResponse(val messages: List<Message> = emptyList())

@Serializable
data class SearchResponse(val results: List<SearchResult> = emptyList())

@Serializable
data class MemberListResponse(val members: List<MemberRecord> = emptyList())

@Serializable
data class ApiEvent(
    val seq: Long = 0,
    val type: String = "",
    val conversationId: String = "",
    val messageId: String? = null,
    val message: Message? = null,
    val actorId: String? = null,
    val createdAt: String = "",
)

@Serializable
data class EventListResponse(
    val events: List<ApiEvent> = emptyList(),
    val nextSeq: Long = 0,
)

@Serializable
data class HeadEventResponse(val seq: Long = 0)

@Serializable
data class ErrorBody(val code: String = "", val message: String = "")

@Serializable
data class ErrorEnvelope(val error: ErrorBody = ErrorBody())

@Serializable
data class LoginRequest(val handle: String, val password: String)

@Serializable
data class RegisterRequest(val handle: String, val displayName: String, val password: String)

@Serializable
data class UpdateProfileRequest(val displayName: String? = null, val handle: String? = null)

@Serializable
data class CreateConversationRequest(
    val kind: String,
    val name: String? = null,
    val topic: String? = null,
    val memberHandles: List<String> = emptyList(),
)

@Serializable
data class SendMessageRequest(val body: String, val replyToId: String? = null)

@Serializable
data class EditMessageRequest(val body: String)

@Serializable
data class AddMemberRequest(val handle: String)

/** A user-facing API failure with no secrets or request bodies attached. */
class ApiException(
    override val message: String,
    val code: String = "",
    val status: Int = 0,
) : Exception(message)
