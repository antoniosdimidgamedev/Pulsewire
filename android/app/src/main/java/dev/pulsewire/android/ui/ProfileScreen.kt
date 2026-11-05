package dev.pulsewire.android.ui

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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
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
import dev.pulsewire.android.BuildConfig
import dev.pulsewire.android.PulsewireUiState

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProfileScreen(
    state: PulsewireUiState,
    onBack: () -> Unit,
    onSave: (displayName: String, handle: String) -> Unit,
    onSignOut: () -> Unit,
) {
    val user = state.user
    var displayName by rememberSaveable(user?.id) {
        mutableStateOf(user?.displayName.orEmpty())
    }
    var handle by rememberSaveable(user?.id) {
        mutableStateOf(user?.handle.orEmpty())
    }
    var confirmSignOut by remember { mutableStateOf(false) }

    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            navigationIcon = {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                }
            },
            title = { ScreenTitle("Profile") },
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
            Row(verticalAlignment = Alignment.CenterVertically) {
                InitialsAvatar(name = user?.displayName.orEmpty(), size = 64)
                Spacer(Modifier.width(16.dp))
                Column(Modifier.weight(1f)) {
                    Text(
                        text = user?.displayName.orEmpty(),
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        text = user?.let { "@${it.handle}" }.orEmpty(),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (user?.isAdmin == true) {
                        Spacer(Modifier.height(6.dp))
                        Surface(
                            shape = RoundedCornerShape(50),
                            color = MaterialTheme.colorScheme.secondaryContainer,
                        ) {
                            Text(
                                text = "Administrator",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSecondaryContainer,
                                modifier = Modifier.padding(horizontal = 10.dp, vertical = 3.dp),
                            )
                        }
                    }
                }
            }

            Spacer(Modifier.height(28.dp))
            Text(
                text = "Edit profile",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = displayName,
                onValueChange = { displayName = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Display name") },
                singleLine = true,
            )
            Spacer(Modifier.height(12.dp))
            OutlinedTextField(
                value = handle,
                onValueChange = { handle = it.removePrefix("@") },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Handle") },
                prefix = { Text("@") },
                singleLine = true,
            )
            Spacer(Modifier.height(14.dp))
            Button(
                onClick = { onSave(displayName, handle) },
                modifier = Modifier.fillMaxWidth(),
                enabled = !state.working &&
                    displayName.isNotBlank() &&
                    (displayName.trim() != user?.displayName || handle.trim() != user?.handle),
            ) {
                Text("Save changes")
            }

            Spacer(Modifier.height(28.dp))
            Text(
                text = "Connection",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(8.dp))
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(16.dp),
                color = MaterialTheme.colorScheme.surfaceVariant,
            ) {
                Column(Modifier.padding(14.dp)) {
                    MetaRow("Server", state.serverUrl.ifBlank { "Not connected" })
                    Spacer(Modifier.height(10.dp))
                    HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.25f))
                    Spacer(Modifier.height(10.dp))
                    MetaRow("Session", "Android Keystore encrypted")
                    Spacer(Modifier.height(10.dp))
                    HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.25f))
                    Spacer(Modifier.height(10.dp))
                    MetaRow("App version", BuildConfig.VERSION_NAME)
                }
            }

            Spacer(Modifier.height(28.dp))
            OutlinedButton(
                onClick = { confirmSignOut = true },
                modifier = Modifier.fillMaxWidth(),
                enabled = !state.working,
            ) {
                Text("Sign out", color = MaterialTheme.colorScheme.error)
            }
            Spacer(Modifier.height(12.dp))
            Text(
                text = "Signing out removes the encrypted session token from this device. " +
                    "Plain HTTP is allowed only for trusted LAN servers; use HTTPS elsewhere.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }

    if (confirmSignOut) {
        AlertDialog(
            onDismissRequest = { confirmSignOut = false },
            title = { Text("Sign out?") },
            text = { Text("You will need your password to sign in again.") },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmSignOut = false
                        onSignOut()
                    },
                ) {
                    Text("Sign out", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmSignOut = false }) { Text("Cancel") }
            },
        )
    }
}
