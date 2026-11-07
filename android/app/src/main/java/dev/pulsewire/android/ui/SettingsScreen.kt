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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material.icons.filled.Save
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
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
import androidx.compose.ui.unit.dp
import dev.pulsewire.android.PulsewireUiState

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    state: PulsewireUiState,
    onBack: () -> Unit,
    onSaveServerUrl: (String) -> Unit,
    onSignOut: () -> Unit,
    onAbout: () -> Unit,
) {
    var server by rememberSaveable { mutableStateOf(state.serverUrl.ifBlank { "" }) }

    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            navigationIcon = {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                }
            },
            title = { ScreenTitle("Settings") },
            colors = TopAppBarDefaults.topAppBarColors(
                containerColor = MaterialTheme.colorScheme.surface,
            ),
        )

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(16.dp),
        ) {
            Text(
                text = "Server",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = server,
                onValueChange = { server = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Server address") },
                supportingText = {
                    Text(
                        "Emulator: 10.0.2.2 · Phone: your computer's LAN IP. " +
                            "Use HTTPS outside a trusted LAN.",
                    )
                },
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Uri,
                    imeAction = ImeAction.Done,
                ),
                singleLine = true,
            )
            Spacer(Modifier.height(20.dp))

            Text(
                text = "Connection",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(8.dp))
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = androidx.compose.foundation.shape.RoundedCornerShape(16.dp),
                color = MaterialTheme.colorScheme.surfaceVariant,
            ) {
                Column(Modifier.padding(14.dp)) {
                    MetaRow("Server", state.serverUrl.ifBlank { "Not connected" })
                    Spacer(Modifier.height(10.dp))
                    androidx.compose.material3.HorizontalDivider(
                        color = MaterialTheme.colorScheme.outline.copy(alpha = 0.25f),
                    )
                    Spacer(Modifier.height(10.dp))
                    MetaRow("Session", "Android Keystore encrypted")
                    Spacer(Modifier.height(10.dp))
                    androidx.compose.material3.HorizontalDivider(
                        color = MaterialTheme.colorScheme.outline.copy(alpha = 0.25f),
                    )
                    Spacer(Modifier.height(10.dp))
                    MetaRow("Cleartext HTTP", "Trusted LAN only")
                }
            }
            Spacer(Modifier.height(20.dp))

            Button(
                onClick = { onSaveServerUrl(server) },
                modifier = Modifier.fillMaxWidth().height(52.dp),
                enabled = server.isNotBlank() && !state.working,
            ) {
                Text("Save server address")
            }
            Spacer(Modifier.height(12.dp))

            Button(
                onClick = { onSignOut() },
                modifier = Modifier.fillMaxWidth().height(52.dp),
                enabled = !state.working,
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        Icons.Filled.Logout,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp),
                        tint = MaterialTheme.colorScheme.error,
                    )
                    Spacer(Modifier.width(8.dp))
                    Text("Sign out", color = MaterialTheme.colorScheme.error)
                }
            }
            Spacer(Modifier.height(20.dp))

            Button(
                onClick = { onAbout() },
                modifier = Modifier.fillMaxWidth().height(52.dp),
                enabled = !state.working,
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        Icons.Filled.Info,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp),
                        tint = MaterialTheme.colorScheme.primary,
                    )
                    Spacer(Modifier.width(8.dp))
                    Text("About Pulsewire")
                }
            }
        }
    }
}
