package dev.pulsewire.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.outlined.PersonRemove
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.pulsewire.android.PulsewireUiState

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MembersScreen(
    state: PulsewireUiState,
    conversationId: String,
    onBack: () -> Unit,
    onAddMember: (String) -> Unit,
    onRemoveMember: (String) -> Unit,
    onLeave: () -> Unit,
) {
    val conversation = state.activeConversation?.takeIf { it.id == conversationId }
        ?: state.conversations.firstOrNull { it.id == conversationId }
    val isDirect = conversation?.kind == "dm"
    val me = state.user
    val myRole = state.members.firstOrNull { it.user.id == me?.id }?.role
    val isOwner = myRole == "owner"
    var handle by rememberSaveable { mutableStateOf("") }
    var confirmLeave by remember { mutableStateOf(false) }

    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            navigationIcon = {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                }
            },
            title = {
                ScreenTitle(
                    title = "Members",
                    subtitle = conversation?.name ?: "Conversation",
                )
            },
            colors = TopAppBarDefaults.topAppBarColors(
                containerColor = MaterialTheme.colorScheme.surface,
            ),
        )

        if (!isDirect) {
            Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                Text(
                    text = "Invite someone",
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(6.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = handle,
                        onValueChange = { handle = it },
                        modifier = Modifier.weight(1f),
                        label = { Text("Handle") },
                        prefix = { Text("@") },
                        singleLine = true,
                    )
                    Spacer(Modifier.width(8.dp))
                    Button(
                        onClick = {
                            onAddMember(handle)
                            handle = ""
                        },
                        enabled = handle.isNotBlank() && !state.working,
                    ) {
                        Text("Add")
                    }
                }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant)
        }

        if (state.loading && state.members.isEmpty()) {
            LoadingPane(Modifier.weight(1f))
        } else {
            LazyColumn(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 8.dp),
            ) {
                items(state.members, key = { it.user.id }) { member ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        InitialsAvatar(name = member.user.displayName, size = 42)
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                Text(
                                    text = member.user.displayName,
                                    style = MaterialTheme.typography.bodyLarge,
                                    fontWeight = FontWeight.SemiBold,
                                )
                                if (member.role == "owner") {
                                    Surface(
                                        shape = RoundedCornerShape(50),
                                        color = MaterialTheme.colorScheme.secondaryContainer,
                                    ) {
                                        Text(
                                            text = "Owner",
                                            style = MaterialTheme.typography.labelSmall,
                                            color = MaterialTheme.colorScheme.onSecondaryContainer,
                                            modifier = Modifier.padding(
                                                horizontal = 8.dp,
                                                vertical = 2.dp,
                                            ),
                                        )
                                    }
                                }
                                if (member.user.id == me?.id) {
                                    Text(
                                        text = "You",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                            Text(
                                text = "@${member.user.handle}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        if (isOwner && member.user.id != me?.id && !isDirect) {
                            IconButton(
                                onClick = { onRemoveMember(member.user.id) },
                                enabled = !state.working,
                            ) {
                                Icon(
                                    Icons.Outlined.PersonRemove,
                                    contentDescription = "Remove @${member.user.handle}",
                                    tint = MaterialTheme.colorScheme.error,
                                )
                            }
                        }
                    }
                    HorizontalDivider(
                        modifier = Modifier.padding(start = 70.dp),
                        color = MaterialTheme.colorScheme.surfaceVariant,
                    )
                }
            }
        }

        if (!isDirect) {
            OutlinedButton(
                onClick = { confirmLeave = true },
                modifier = Modifier
                    .fillMaxWidth()
                    .navigationBarsPadding()
                    .padding(horizontal = 16.dp, vertical = 10.dp),
                enabled = !state.working,
            ) {
                Icon(
                    Icons.AutoMirrored.Filled.Logout,
                    contentDescription = null,
                    modifier = Modifier.width(18.dp),
                    tint = MaterialTheme.colorScheme.error,
                )
                Spacer(Modifier.width(8.dp))
                Text("Leave conversation", color = MaterialTheme.colorScheme.error)
            }
        } else {
            Text(
                text = "Direct messages last as long as both accounts exist.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier
                    .navigationBarsPadding()
                    .padding(horizontal = 16.dp, vertical = 16.dp),
            )
        }
    }

    if (confirmLeave) {
        AlertDialog(
            onDismissRequest = { confirmLeave = false },
            title = { Text("Leave conversation?") },
            text = {
                Text(
                    "You will stop receiving messages from this conversation. " +
                        "If you are the owner, ownership is transferred to another member.",
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmLeave = false
                        onLeave()
                    },
                ) {
                    Text("Leave", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmLeave = false }) { Text("Cancel") }
            },
        )
    }
}
