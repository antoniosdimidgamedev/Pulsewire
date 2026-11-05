package dev.pulsewire.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material.icons.outlined.Group
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.pulsewire.android.PulsewireUiState
import dev.pulsewire.android.data.Message

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    state: PulsewireUiState,
    onBack: () -> Unit,
    onMembers: () -> Unit,
    onLoadOlder: () -> Unit,
    onSend: (String) -> Unit,
    onEdit: (messageId: String, body: String) -> Unit,
    onDelete: (messageId: String) -> Unit,
) {
    val conversation = state.activeConversation
    var editingMessage by remember { mutableStateOf<Message?>(null) }
    var deletingMessage by remember { mutableStateOf<Message?>(null) }

    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            navigationIcon = {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                }
            },
            title = {
                ScreenTitle(
                    title = conversation?.name?.ifBlank { "Conversation" } ?: "Conversation",
                    subtitle = when {
                        !conversation?.topic.isNullOrBlank() -> conversation?.topic
                        conversation != null -> {
                            "${conversation.members.size} members · ${kindLabel(conversation.kind)}"
                        }
                        else -> null
                    },
                )
            },
            actions = {
                IconButton(onClick = onMembers, enabled = conversation != null) {
                    Icon(Icons.Outlined.Group, contentDescription = "Members")
                }
            },
            colors = TopAppBarDefaults.topAppBarColors(
                containerColor = MaterialTheme.colorScheme.surface,
            ),
        )

        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
        ) {
            when {
                state.loading && state.messages.isEmpty() -> LoadingPane()
                state.messages.isEmpty() -> EmptyState(
                    icon = Icons.Outlined.Forum,
                    title = "No messages yet",
                    message = "Send the first message in this conversation.",
                    modifier = Modifier.fillMaxSize(),
                )
                else -> MessageList(
                    state = state,
                    onLoadOlder = onLoadOlder,
                    onEditRequest = { editingMessage = it },
                    onDeleteRequest = { deletingMessage = it },
                )
            }
        }

        MessageComposer(
            enabled = !state.loading,
            sending = state.working,
            onSend = onSend,
        )
    }

    editingMessage?.let { message ->
        var draft by remember(message.id) { mutableStateOf(message.body) }
        AlertDialog(
            onDismissRequest = { editingMessage = null },
            title = { Text("Edit message") },
            text = {
                OutlinedTextField(
                    value = draft,
                    onValueChange = { draft = it },
                    modifier = Modifier.fillMaxWidth(),
                    maxLines = 6,
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        onEdit(message.id, draft)
                        editingMessage = null
                    },
                    enabled = draft.isNotBlank() && !state.working,
                ) {
                    Text("Save")
                }
            },
            dismissButton = {
                TextButton(onClick = { editingMessage = null }) { Text("Cancel") }
            },
        )
    }

    deletingMessage?.let { message ->
        AlertDialog(
            onDismissRequest = { deletingMessage = null },
            title = { Text("Delete message?") },
            text = { Text("The message will be replaced with a deletion notice.") },
            confirmButton = {
                TextButton(
                    onClick = {
                        onDelete(message.id)
                        deletingMessage = null
                    },
                    enabled = !state.working,
                ) {
                    Text("Delete", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = { deletingMessage = null }) { Text("Cancel") }
            },
        )
    }
}

@Composable
private fun MessageList(
    state: PulsewireUiState,
    onLoadOlder: () -> Unit,
    onEditRequest: (Message) -> Unit,
    onDeleteRequest: (Message) -> Unit,
) {
    val listState = rememberLazyListState()
    val lastId = state.messages.lastOrNull()?.id
    var previousLastId by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(lastId, state.messages.size) {
        if (lastId != null && lastId != previousLastId && state.messages.isNotEmpty()) {
            val target = if (state.hasMore) state.messages.size else state.messages.lastIndex
            runCatching { listState.scrollToItem(target) }
        }
        previousLastId = lastId
    }

    LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (state.hasMore) {
            item(key = "load-older") {
                Box(
                    modifier = Modifier.fillMaxWidth(),
                    contentAlignment = Alignment.Center,
                ) {
                    if (state.loadingMore) {
                        CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                    } else {
                        TextButton(onClick = onLoadOlder) {
                            Text("Load older messages")
                        }
                    }
                }
            }
        }
        items(state.messages, key = { it.id }) { message ->
            MessageBubble(
                message = message,
                mine = message.author.id == state.user?.id,
                onEditRequest = { onEditRequest(message) },
                onDeleteRequest = { onDeleteRequest(message) },
            )
        }
    }
}

@Composable
private fun MessageBubble(
    message: Message,
    mine: Boolean,
    onEditRequest: () -> Unit,
    onDeleteRequest: () -> Unit,
) {
    var menuExpanded by remember { mutableStateOf(false) }
    val deleted = message.deletedAt != null
    val bubbleColor = if (mine) {
        MaterialTheme.colorScheme.primary
    } else {
        MaterialTheme.colorScheme.surfaceVariant
    }
    val contentColor = if (mine) {
        MaterialTheme.colorScheme.onPrimary
    } else {
        MaterialTheme.colorScheme.onSurface
    }

    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = if (mine) Alignment.End else Alignment.Start,
    ) {
        if (!mine) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(start = 4.dp, bottom = 3.dp),
            ) {
                InitialsAvatar(name = message.author.displayName, size = 26)
                Spacer(Modifier.width(6.dp))
                Text(
                    text = message.author.displayName,
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Row(
            verticalAlignment = Alignment.Top,
            horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start,
        ) {
            Box {
                Surface(
                    shape = RoundedCornerShape(
                        topStart = if (mine) 18.dp else 4.dp,
                        topEnd = if (mine) 4.dp else 18.dp,
                        bottomStart = 18.dp,
                        bottomEnd = 18.dp,
                    ),
                    color = bubbleColor,
                    modifier = Modifier.widthIn(max = 320.dp),
                ) {
                    Column(Modifier.padding(start = 12.dp, top = 8.dp, end = 8.dp, bottom = 8.dp)) {
                        Row(verticalAlignment = Alignment.Top) {
                            Text(
                                text = if (deleted) "Message deleted" else message.body,
                                style = MaterialTheme.typography.bodyMedium,
                                color = if (deleted) contentColor.copy(alpha = 0.7f) else contentColor,
                                fontStyle = if (deleted) FontStyle.Italic else FontStyle.Normal,
                                modifier = Modifier.weight(1f, fill = false),
                            )
                            if (mine && !deleted) {
                                Box {
                                    IconButton(
                                        onClick = { menuExpanded = true },
                                        modifier = Modifier.size(26.dp),
                                    ) {
                                        Icon(
                                            Icons.Filled.MoreVert,
                                            contentDescription = "Message actions",
                                            tint = contentColor,
                                            modifier = Modifier.size(18.dp),
                                        )
                                    }
                                    DropdownMenu(
                                        expanded = menuExpanded,
                                        onDismissRequest = { menuExpanded = false },
                                    ) {
                                        DropdownMenuItem(
                                            text = { Text("Edit") },
                                            onClick = {
                                                menuExpanded = false
                                                onEditRequest()
                                            },
                                        )
                                        DropdownMenuItem(
                                            text = {
                                                Text(
                                                    "Delete",
                                                    color = MaterialTheme.colorScheme.error,
                                                )
                                            },
                                            onClick = {
                                                menuExpanded = false
                                                onDeleteRequest()
                                            },
                                        )
                                    }
                                }
                            }
                        }
                        Spacer(Modifier.height(2.dp))
                        Text(
                            text = buildString {
                                append(formatMessageTime(message.createdAt))
                                if (message.editedAt != null && !deleted) append(" · edited")
                                if (mine && !deleted && message.delivery != null) {
                                    append(" · ")
                                    append(deliveryLabel(message.delivery.status))
                                }
                            },
                            style = MaterialTheme.typography.labelSmall,
                            color = contentColor.copy(alpha = 0.72f),
                        )
                    }
                }
            }
        }
    }
}

private fun deliveryLabel(status: String): String = when (status) {
    "read" -> "Read"
    "delivered" -> "Delivered"
    "pending" -> "Sending"
    "failed" -> "Failed"
    else -> "Sent"
}

@Composable
private fun MessageComposer(
    enabled: Boolean,
    sending: Boolean,
    onSend: (String) -> Unit,
) {
    var text by rememberSaveable { mutableStateOf("") }

    fun send() {
        val value = text.trim()
        if (value.isEmpty() || sending) return
        onSend(value)
        text = ""
    }

    Surface(tonalElevation = 3.dp) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .imePadding()
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text("Message") },
                maxLines = 4,
                shape = RoundedCornerShape(20.dp),
                enabled = enabled,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { send() }),
            )
            Spacer(Modifier.width(8.dp))
            FilledIconButton(
                onClick = { send() },
                enabled = enabled && text.isNotBlank() && !sending,
                modifier = Modifier.size(48.dp),
            ) {
                if (sending) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(20.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onPrimary,
                    )
                } else {
                    Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send message")
                }
            }
        }
    }
}
