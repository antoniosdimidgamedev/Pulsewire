package dev.pulsewire.android.ui

import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.ManageSearch
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.pulsewire.android.PulsewireUiState

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SearchScreen(
    state: PulsewireUiState,
    onBack: () -> Unit,
    onSearch: (String) -> Unit,
    onOpenConversation: (String) -> Unit,
) {
    var query by rememberSaveable { mutableStateOf("") }

    fun submit() {
        if (query.isNotBlank()) onSearch(query)
    }

    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            navigationIcon = {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                }
            },
            title = { ScreenTitle("Search messages") },
            colors = TopAppBarDefaults.topAppBarColors(
                containerColor = MaterialTheme.colorScheme.surface,
            ),
        )

        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 8.dp),
            label = { Text("Search") },
            placeholder = { Text("Message text or conversation name") },
            singleLine = true,
            trailingIcon = {
                IconButton(onClick = { submit() }, enabled = query.isNotBlank()) {
                    Icon(Icons.Filled.Search, contentDescription = "Search")
                }
            },
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { submit() }),
        )

        when {
            state.loading -> LoadingPane(Modifier.weight(1f))
            query.isBlank() -> EmptyState(
                icon = Icons.AutoMirrored.Outlined.ManageSearch,
                title = "Find a message",
                message = "Search message text and conversation names across the conversations " +
                    "you belong to.",
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth(),
            )
            state.searchResults.isEmpty() -> EmptyState(
                icon = Icons.AutoMirrored.Outlined.ManageSearch,
                title = "No messages found",
                message = "Try a different word or a shorter query.",
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth(),
            )
            else -> LazyColumn(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .navigationBarsPadding(),
            ) {
                items(state.searchResults, key = { it.message.id }) { result ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onOpenConversation(result.conversation.id) }
                            .padding(horizontal = 16.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.Top,
                    ) {
                        InitialsAvatar(name = result.conversation.name, size = 40)
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(
                                    text = result.conversation.name,
                                    style = MaterialTheme.typography.titleSmall,
                                    fontWeight = FontWeight.SemiBold,
                                    modifier = Modifier.weight(1f),
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                Text(
                                    text = formatRelativeTime(result.message.createdAt),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            Spacer(Modifier.height(2.dp))
                            Text(
                                text = result.snippet.ifBlank { result.message.body },
                                style = MaterialTheme.typography.bodyMedium,
                                maxLines = 3,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Spacer(Modifier.height(3.dp))
                            Text(
                                text = "${result.message.author.displayName} · " +
                                    kindLabel(result.conversation.kind),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    HorizontalDivider(
                        modifier = Modifier.padding(start = 68.dp),
                        color = MaterialTheme.colorScheme.surfaceVariant,
                    )
                }
            }
        }
    }
}
