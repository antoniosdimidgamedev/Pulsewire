package dev.pulsewire.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
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
import androidx.compose.ui.unit.dp
import dev.pulsewire.android.PulsewireUiState
import dev.pulsewire.android.data.User

enum class NewConversationKind(val apiValue: String, val label: String) {
    Direct("dm", "Direct"),
    Group("group", "Group"),
    Space("space", "Space"),
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewConversationScreen(
    state: PulsewireUiState,
    onBack: () -> Unit,
    onSearchUsers: (String) -> Unit,
    onCreate: (
        kind: String,
        name: String,
        topic: String,
        memberHandles: List<String>,
    ) -> Unit,
    initialKind: NewConversationKind = NewConversationKind.Direct,
) {
    var kind by rememberSaveable { mutableStateOf(initialKind) }
    var name by rememberSaveable { mutableStateOf("") }
    var topic by rememberSaveable { mutableStateOf("") }
    var query by rememberSaveable { mutableStateOf("") }
    var selected by remember { mutableStateOf<Map<String, User>>(emptyMap()) }

    fun toggle(user: User) {
        selected = when {
            kind == NewConversationKind.Direct && selected.containsKey(user.handle) -> emptyMap()
            kind == NewConversationKind.Direct -> mapOf(user.handle to user)
            selected.containsKey(user.handle) -> selected - user.handle
            else -> selected + (user.handle to user)
        }
    }

    val isDirect = kind == NewConversationKind.Direct
    val canCreate = !state.working && when {
        isDirect -> selected.size == 1
        else -> name.isNotBlank() && selected.isNotEmpty()
    }

    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            navigationIcon = {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                }
            },
            title = { ScreenTitle("New conversation") },
            colors = TopAppBarDefaults.topAppBarColors(
                containerColor = MaterialTheme.colorScheme.surface,
            ),
        )

        Column(
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .navigationBarsPadding()
                .padding(16.dp),
        ) {
            Text(
                text = "Conversation type",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                NewConversationKind.entries.forEach { option ->
                    FilterChip(
                        selected = kind == option,
                        onClick = {
                            kind = option
                            if (option == NewConversationKind.Direct && selected.size > 1) {
                                selected = selected.entries.take(1).associate { it.key to it.value }
                            }
                        },
                        label = { Text(option.label) },
                    )
                }
            }
            Spacer(Modifier.height(16.dp))

            if (!isDirect) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text(if (kind == NewConversationKind.Space) "Space name" else "Group name") },
                    singleLine = true,
                )
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = topic,
                    onValueChange = { topic = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Topic (optional)") },
                    singleLine = true,
                )
                Spacer(Modifier.height(16.dp))
            }

            Text(
                text = if (isDirect) "Choose one person" else "Add people",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = query,
                onValueChange = {
                    query = it
                    onSearchUsers(it)
                },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Find people") },
                singleLine = true,
            )

            if (selected.isNotEmpty()) {
                Spacer(Modifier.height(10.dp))
                Row(
                    modifier = Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    selected.values.forEach { user ->
                        FilterChip(
                            selected = true,
                            onClick = { selected = selected - user.handle },
                            label = { Text("@${user.handle}") },
                        )
                    }
                }
            }

            Spacer(Modifier.height(8.dp))
            if (state.userResults.isEmpty() && query.isNotBlank()) {
                Text(
                    text = "No matching people.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(vertical = 12.dp),
                )
            } else {
                state.userResults.forEach { user ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { toggle(user) }
                            .padding(vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        InitialsAvatar(name = user.displayName, size = 38)
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(
                                text = user.displayName,
                                style = MaterialTheme.typography.bodyLarge,
                            )
                            Text(
                                text = "@${user.handle}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Checkbox(
                            checked = selected.containsKey(user.handle),
                            onCheckedChange = null,
                        )
                    }
                    HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant)
                }
            }

            Spacer(Modifier.height(12.dp))
            Text(
                text = if (isDirect) {
                    "A direct message needs exactly one other person."
                } else {
                    "Groups and spaces need at least one other person. " +
                        "You become the owner."
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Button(
            onClick = {
                onCreate(
                    kind.apiValue,
                    if (isDirect) "" else name,
                    if (isDirect) "" else topic,
                    selected.keys.toList(),
                )
            },
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(16.dp)
                .height(52.dp),
            enabled = canCreate,
        ) {
            if (state.working) {
                CircularProgressIndicator(
                    modifier = Modifier.height(22.dp),
                    strokeWidth = 2.dp,
                    color = MaterialTheme.colorScheme.onPrimary,
                )
            } else {
                Text("Create conversation")
            }
        }
    }
}
