package dev.pulsewire.android

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.pulsewire.android.data.ApiException
import dev.pulsewire.android.data.Conversation
import dev.pulsewire.android.data.MemberRecord
import dev.pulsewire.android.data.Message
import dev.pulsewire.android.data.PulsewireApi
import dev.pulsewire.android.data.SearchResult
import dev.pulsewire.android.data.SessionStore
import dev.pulsewire.android.data.User
import java.time.Instant
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

sealed interface Screen {
    data object Conversations : Screen
    data class Chat(val conversationId: String) : Screen
    data object NewConversation : Screen
    data class Members(val conversationId: String) : Screen
    data object Profile : Screen
    data object Search : Screen
    data object Settings : Screen
    data object About : Screen
}

data class PulsewireUiState(
    val serverUrl: String = "",
    val user: User? = null,
    val conversations: List<Conversation> = emptyList(),
    val activeConversation: Conversation? = null,
    val messages: List<Message> = emptyList(),
    val hasMore: Boolean = false,
    val nextBefore: Long? = null,
    val members: List<MemberRecord> = emptyList(),
    val searchResults: List<SearchResult> = emptyList(),
    val userResults: List<User> = emptyList(),
    val loading: Boolean = false,
    val loadingMore: Boolean = false,
    val working: Boolean = false,
    val notice: String? = null,
)

class PulsewireViewModel(application: Application) : AndroidViewModel(application) {
    private val session = SessionStore(application)
    private var apiInstance: PulsewireApi? = null
    private var pollJob: Job? = null
    private var userSearchJob: Job? = null
    private var lastEventSeq = 0L
    private var pollReady = false

    var authenticated by mutableStateOf(session.token() != null)
        private set

    var screen by mutableStateOf<Screen>(Screen.Conversations)
        private set

    var state by mutableStateOf(
        PulsewireUiState(
            serverUrl = session.serverUrl().orEmpty(),
            user = session.user(),
        ),
    )
        private set

    init {
        if (authenticated) {
            refreshConversations()
            startPolling()
        }
    }

    fun signIn(server: String, handle: String, password: String) {
        if (handle.isBlank() || password.isEmpty()) {
            state = state.copy(notice = "Enter your handle and password.")
            return
        }
        viewModelScope.launch {
            state = state.copy(loading = true, notice = null)
            try {
                val baseUrl = PulsewireApi.normalizeBaseUrl(server)
                val auth = PulsewireApi(baseUrl).login(handle.trim(), password)
                completeSignIn(baseUrl, auth.token, auth.user)
                state = state.copy(
                    loading = false,
                    notice = "Signed in as @${auth.user.handle}.",
                )
                loadConversations(showSpinner = true)
            } catch (error: Throwable) {
                state = state.copy(loading = false)
                fail(error)
            }
        }
    }

    fun register(server: String, handle: String, displayName: String, password: String) {
        if (handle.isBlank() || displayName.isBlank() || password.isEmpty()) {
            state = state.copy(notice = "Enter a handle, display name, and password.")
            return
        }
        if (password.length < 10) {
            state = state.copy(notice = "Passwords must be at least 10 characters.")
            return
        }
        viewModelScope.launch {
            state = state.copy(loading = true, notice = null)
            try {
                val baseUrl = PulsewireApi.normalizeBaseUrl(server)
                val auth = PulsewireApi(baseUrl).register(handle.trim(), displayName.trim(), password)
                completeSignIn(baseUrl, auth.token, auth.user)
                state = state.copy(
                    loading = false,
                    notice = "Account created. Welcome, @${auth.user.handle}.",
                )
                loadConversations(showSpinner = true)
            } catch (error: Throwable) {
                state = state.copy(loading = false)
                fail(error)
            }
        }
    }

    fun signOut() {
        viewModelScope.launch {
            runCatching { client().logout() }
            clearSignedIn("Signed out.")
        }
    }

    fun refreshConversations() {
        viewModelScope.launch {
            try {
                loadConversations(showSpinner = state.conversations.isEmpty())
            } catch (error: Throwable) {
                fail(error)
            }
        }
    }

    fun openConversation(conversationId: String) {
        screen = Screen.Chat(conversationId)
        viewModelScope.launch {
            state = state.copy(
                loading = true,
                activeConversation = state.conversations.firstOrNull {
                    it.id == conversationId
                },
                messages = emptyList(),
                hasMore = false,
                nextBefore = null,
                members = emptyList(),
                notice = null,
            )
            try {
                val client = client()
                val conversation = client.getConversation(conversationId)
                val page = client.getMessages(conversationId, limit = 50)
                state = state.copy(
                    activeConversation = conversation,
                    messages = page.messages,
                    hasMore = page.hasMore,
                    nextBefore = page.nextBefore,
                    loading = false,
                )
                markConversationRead(conversationId)
            } catch (error: Throwable) {
                state = state.copy(loading = false)
                fail(error)
            }
        }
    }

    fun loadOlderMessages() {
        val conversationId = (screen as? Screen.Chat)?.conversationId ?: return
        val before = state.nextBefore ?: return
        if (state.loadingMore || state.loading) return
        viewModelScope.launch {
            state = state.copy(loadingMore = true, notice = null)
            try {
                val page = client().getMessages(conversationId, limit = 50, before = before)
                state = state.copy(
                    messages = (page.messages + state.messages).distinctBy { it.id },
                    hasMore = page.hasMore,
                    nextBefore = page.nextBefore,
                    loadingMore = false,
                )
            } catch (error: Throwable) {
                state = state.copy(loadingMore = false)
                fail(error)
            }
        }
    }

    fun sendMessage(body: String) {
        val conversationId = (screen as? Screen.Chat)?.conversationId ?: return
        val text = body.trim()
        if (text.isEmpty() || state.working) return
        viewModelScope.launch {
            state = state.copy(working = true, notice = null)
            try {
                val client = client()
                val message = client.sendMessage(conversationId, text)
                state = state.copy(
                    messages = (state.messages + message).distinctBy { it.id },
                    working = false,
                )
                markConversationRead(conversationId)
                loadConversations(showSpinner = false)
            } catch (error: Throwable) {
                state = state.copy(working = false)
                fail(error)
            }
        }
    }

    fun editMessage(messageId: String, body: String) {
        val text = body.trim()
        if (text.isEmpty()) return
        viewModelScope.launch {
            state = state.copy(working = true, notice = null)
            try {
                val updated = client().editMessage(messageId, text)
                state = state.copy(
                    messages = state.messages.map { if (it.id == updated.id) updated else it },
                    working = false,
                )
                loadConversations(showSpinner = false)
            } catch (error: Throwable) {
                state = state.copy(working = false)
                fail(error)
            }
        }
    }

    fun deleteMessage(messageId: String) {
        viewModelScope.launch {
            state = state.copy(working = true, notice = null)
            try {
                client().deleteMessage(messageId)
                val deletedAt = Instant.now().toString()
                state = state.copy(
                    messages = state.messages.map {
                        if (it.id == messageId) {
                            it.copy(body = "", deletedAt = deletedAt)
                        } else {
                            it
                        }
                    },
                    working = false,
                )
                loadConversations(showSpinner = false)
            } catch (error: Throwable) {
                state = state.copy(working = false)
                fail(error)
            }
        }
    }

    fun search(query: String) {
        val text = query.trim()
        if (text.isEmpty()) {
            state = state.copy(searchResults = emptyList())
            return
        }
        viewModelScope.launch {
            state = state.copy(loading = true, notice = null)
            try {
                val results = client().search(text)
                state = state.copy(searchResults = results, loading = false)
            } catch (error: Throwable) {
                state = state.copy(loading = false)
                fail(error)
            }
        }
    }

    fun searchUsers(query: String) {
        userSearchJob?.cancel()
        if (query.isBlank()) {
            state = state.copy(userResults = emptyList())
            return
        }
        userSearchJob = viewModelScope.launch {
            delay(250)
            try {
                val users = client().searchUsers(query.trim())
                state = state.copy(userResults = users)
            } catch (error: Throwable) {
                if (error is ApiException && error.status == 401) fail(error)
            }
        }
    }

    fun createConversation(
        kind: String,
        name: String,
        topic: String,
        memberHandles: List<String>,
    ) {
        viewModelScope.launch {
            state = state.copy(working = true, notice = null)
            try {
                val conversation = client().createConversation(kind, name, topic, memberHandles)
                state = state.copy(working = false, userResults = emptyList())
                loadConversations(showSpinner = false)
                openConversation(conversation.id)
            } catch (error: Throwable) {
                state = state.copy(working = false)
                fail(error)
            }
        }
    }

    fun openMembers(conversationId: String) {
        screen = Screen.Members(conversationId)
        viewModelScope.launch {
            state = state.copy(loading = true, members = emptyList(), notice = null)
            try {
                val members = client().listMembers(conversationId)
                state = state.copy(members = members, loading = false)
            } catch (error: Throwable) {
                state = state.copy(loading = false)
                fail(error)
            }
        }
    }

    fun addMember(conversationId: String, handle: String) {
        if (handle.isBlank()) return
        viewModelScope.launch {
            state = state.copy(working = true, notice = null)
            try {
                val client = client()
                val conversation = client.addMember(conversationId, handle.trim())
                val members = client.listMembers(conversationId)
                state = state.copy(
                    activeConversation = conversation,
                    conversations = state.conversations.replace(conversation),
                    members = members,
                    working = false,
                    notice = "Added @${handle.trim().removePrefix("@")}.",
                )
            } catch (error: Throwable) {
                state = state.copy(working = false)
                fail(error)
            }
        }
    }

    fun removeMember(conversationId: String, userId: String) {
        viewModelScope.launch {
            state = state.copy(working = true, notice = null)
            try {
                val client = client()
                client.removeMember(conversationId, userId)
                val members = client.listMembers(conversationId)
                state = state.copy(members = members, working = false, notice = "Member removed.")
                loadConversations(showSpinner = false)
            } catch (error: Throwable) {
                state = state.copy(working = false)
                fail(error)
            }
        }
    }

    fun leaveConversation(conversationId: String) {
        viewModelScope.launch {
            state = state.copy(working = true, notice = null)
            try {
                client().leaveConversation(conversationId)
                state = state.copy(
                    conversations = state.conversations.filterNot { it.id == conversationId },
                    working = false,
                    notice = "You left the conversation.",
                )
                screen = Screen.Conversations
                loadConversations(showSpinner = false)
            } catch (error: Throwable) {
                state = state.copy(working = false)
                fail(error)
            }
        }
    }

    fun openProfile() {
        screen = Screen.Profile
        viewModelScope.launch {
            try {
                val user = client().me()
                session.saveUser(user)
                state = state.copy(user = user)
            } catch (_: Throwable) {
                // Keep the cached profile visible when a refresh fails.
            }
        }
    }

    fun updateProfile(displayName: String, handle: String) {
        if (displayName.isBlank()) {
            state = state.copy(notice = "Display name cannot be empty.")
            return
        }
        viewModelScope.launch {
            state = state.copy(working = true, notice = null)
            try {
                val user = client().updateProfile(
                    displayName = displayName.trim(),
                    handle = handle.trim().removePrefix("@"),
                )
                session.saveUser(user)
                state = state.copy(user = user, working = false, notice = "Profile updated.")
            } catch (error: Throwable) {
                state = state.copy(working = false)
                fail(error)
            }
        }
    }

    fun navigate(target: Screen) {
        screen = target
    }

    fun openSettings() {
        screen = Screen.Settings
    }

    fun openAbout() {
        screen = Screen.About
    }

    fun saveServerUrl(url: String) {
        val trimmed = url.trim()
        if (trimmed.isEmpty()) {
            state = state.copy(notice = "Enter the Pulsewire server address.")
            return
        }
        val baseUrl = runCatching { PulsewireApi.normalizeBaseUrl(trimmed) }.getOrNull()
        if (baseUrl == null) {
            state = state.copy(notice = "That server address is not a valid URL.")
            return
        }
        session.saveServerUrl(baseUrl)
        state = state.copy(serverUrl = baseUrl, notice = "Server address saved.")
    }

    fun goBack() {
        screen = when (val current = screen) {
            is Screen.Members -> Screen.Chat(current.conversationId)
            is Screen.Chat -> Screen.Conversations
            else -> Screen.Conversations
        }
    }

    fun consumeNotice() {
        if (state.notice != null) state = state.copy(notice = null)
    }

    private fun completeSignIn(baseUrl: String, token: String, user: User) {
        session.saveSession(baseUrl, token, user)
        apiInstance = PulsewireApi(baseUrl, token)
        authenticated = true
        screen = Screen.Conversations
        lastEventSeq = 0
        pollReady = false
        state = PulsewireUiState(serverUrl = baseUrl, user = user)
        startPolling()
    }

    private fun clearSignedIn(notice: String?) {
        pollJob?.cancel()
        pollJob = null
        userSearchJob?.cancel()
        userSearchJob = null
        apiInstance = null
        val previousServer = state.serverUrl.ifBlank { session.serverUrl().orEmpty() }
        session.clearSession()
        authenticated = false
        screen = Screen.Conversations
        lastEventSeq = 0
        pollReady = false
        state = PulsewireUiState(serverUrl = previousServer, notice = notice)
    }

    private fun client(): PulsewireApi {
        apiInstance?.let { return it }
        val baseUrl = session.serverUrl() ?: throw ApiException("Sign in again.")
        val token = session.token() ?: throw ApiException("Your session expired. Sign in again.")
        return PulsewireApi(baseUrl, token).also { apiInstance = it }
    }

    private suspend fun loadConversations(showSpinner: Boolean) {
        if (showSpinner && state.conversations.isEmpty()) {
            state = state.copy(loading = true)
        }
        val conversations = client().listConversations()
        state = state.copy(conversations = conversations, loading = false)
    }

    private suspend fun markConversationRead(conversationId: String) {
        val conversation = client().markRead(conversationId)
        state = state.copy(
            activeConversation = conversation,
            conversations = state.conversations.replace(conversation),
        )
    }

    private fun startPolling() {
        pollJob?.cancel()
        pollJob = viewModelScope.launch {
            while (isActive) {
                val client = runCatching { client() }.getOrNull()
                if (client == null) {
                    delay(POLL_INTERVAL_MS)
                    continue
                }
                try {
                    if (!pollReady) {
                        lastEventSeq = client.headEvents()
                        pollReady = true
                    }
                    val page = client.getEvents(lastEventSeq, limit = 100)
                    if (page.events.isNotEmpty()) {
                        lastEventSeq = page.nextSeq
                        loadConversations(showSpinner = false)
                        val activeId = (screen as? Screen.Chat)?.conversationId
                        if (activeId != null &&
                            page.events.any {
                                it.conversationId == activeId || it.conversationId.isBlank()
                            }
                        ) {
                            val fresh = client.getMessages(activeId, limit = 50)
                            state = state.copy(
                                messages = fresh.messages,
                                hasMore = fresh.hasMore,
                                nextBefore = fresh.nextBefore,
                            )
                            markConversationRead(activeId)
                        }
                    }
                } catch (error: ApiException) {
                    if (error.status == 401) {
                        clearSignedIn("Your session expired. Sign in again.")
                        return@launch
                    }
                } catch (_: Throwable) {
                    // Polling is best effort; the next tick retries.
                }
                delay(POLL_INTERVAL_MS)
            }
        }
    }

    private fun fail(error: Throwable) {
        if (error is ApiException && error.status == 401) {
            clearSignedIn("Your session expired. Sign in again.")
            return
        }
        val message = when (error) {
            is ApiException -> error.message
            is IllegalArgumentException -> error.message ?: "That value is not valid."
            else -> "Something went wrong. Check your connection and try again."
        }
        state = state.copy(
            loading = false,
            loadingMore = false,
            working = false,
            notice = message,
        )
    }

    private fun List<Conversation>.replace(conversation: Conversation): List<Conversation> {
        val found = any { it.id == conversation.id }
        if (!found) return this
        return map { if (it.id == conversation.id) conversation else it }
    }

    private companion object {
        const val POLL_INTERVAL_MS = 3_000L
    }
}
