package dev.pulsewire.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material.icons.outlined.Group
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Public
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.pulsewire.android.PulsewireUiState
import dev.pulsewire.android.data.Conversation

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConversationsScreen(
    state: PulsewireUiState,
    onOpenConversation: (String) -> Unit,
    onNewConversation: () -> Unit,
    onNewGroup: () -> Unit,
    onSearch: () -> Unit,
    onProfile: () -> Unit,
    onRefresh: () -> Unit,
    onSettings: () -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            title = {
                ScreenTitle(
                    title = "Pulsewire",
                    subtitle = state.user?.let { "@${it.handle}" },
                )
            },
            actions = {
                IconButton(onClick = onSearch, enabled = !state.loading) {
                    Icon(Icons.Filled.Search, contentDescription = "Search messages")
                }
                IconButton(onClick = onNewConversation) {
                    Icon(Icons.Filled.Add, contentDescription = "New conversation")
                }
                IconButton(onClick = onNewGroup) {
                    Icon(Icons.Filled.Group, contentDescription = "New group")
                }
                IconButton(onClick = onProfile) {
                    Icon(Icons.Filled.Person, contentDescription = "Profile")
                }
                IconButton(onClick = onRefresh, enabled = !state.loading) {
                    Icon(Icons.Filled.Refresh, contentDescription = "Refresh conversations")
                }
                IconButton(onClick = onSettings, enabled = !state.loading) {
                    Icon(Icons.Filled.Settings, contentDescription = "Settings")
                }
            },
            colors = TopAppBarDefaults.topAppBarColors(
                containerColor = MaterialTheme.colorScheme.surface,
            ),
        )
        if (state.loading && state.conversations.isNotEmpty()) {
            LinearProgressIndicator(Modifier.fillMaxWidth())
        }

        when {
            state.loading && state.conversations.isEmpty() -> LoadingPane()
            state.conversations.isEmpty() -> EmptyState(
                icon = Icons.Outlined.Forum,
                title = "No conversations yet",
                message = "Start a direct message or create a group to say hello.",
                actionLabel = "New conversation",
                onAction = onNewConversation,
                modifier = Modifier.fillMaxSize(),
            )
            else -> LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .navigationBarsPadding(),
                contentPadding = PaddingValues(bottom = 16.dp),
            ) {
                items(state.conversations, key = { it.id }) { conversation ->
                    ConversationRow(
                        conversation = conversation,
                        onClick = { onOpenConversation(conversation.id) },
                    )
                    HorizontalDivider(
                        modifier = Modifier.padding(start = 76.dp),
                        color = MaterialTheme.colorScheme.surfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun ConversationRow(
    conversation: Conversation,
    onClick: () -> Unit,
) {
    val icon = when (conversation.kind) {
        "dm" -> Icons.Outlined.Person
        "space" -> Icons.Outlined.Public
        else -> Icons.Outlined.Group
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        InitialsAvatar(name = conversation.name.ifBlank { "Conversation" })
        Spacer(Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    imageVector = icon,
                    contentDescription = kindLabel(conversation.kind),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.width(18.dp),
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    text = conversation.name.ifBlank { kindLabel(conversation.kind) },
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    text = formatRelativeTime(conversation.lastMessageAt ?: conversation.lastActivityAt),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.height(3.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = conversation.lastMessagePreview.ifBlank { "No messages yet" },
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (conversation.unreadCount > 0) {
                    Spacer(Modifier.width(8.dp))
                    Surface(
                        shape = CircleShape,
                        color = MaterialTheme.colorScheme.primary,
                    ) {
                        Text(
                            text = conversation.unreadCount.toString(),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onPrimary,
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                        )
                    }
                }
            }
        }
    }
}
