package dev.pulsewire.android.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Info
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.pulsewire.android.BuildConfig
import dev.pulsewire.android.PulsewireUiState

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AboutScreen(
    state: PulsewireUiState,
    onBack: () -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            navigationIcon = {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                }
            },
            title = { ScreenTitle("About") },
            colors = TopAppBarDefaults.topAppBarColors(
                containerColor = MaterialTheme.colorScheme.surface,
            ),
        )

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(16.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = androidx.compose.foundation.layout.Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Surface(
                    modifier = Modifier.size(64.dp),
                    shape = CircleShape,
                    color = MaterialTheme.colorScheme.primary,
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Text(
                            text = "P",
                            style = MaterialTheme.typography.headlineLarge,
                            color = MaterialTheme.colorScheme.onPrimary,
                            fontWeight = FontWeight.Bold,
                        )
                    }
                }
                Spacer(Modifier.width(16.dp))
                Column {
                    Text(
                        text = "Pulsewire",
                        style = MaterialTheme.typography.headlineMedium,
                        fontWeight = FontWeight.Bold,
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(
                        text = "Build ${BuildConfig.VERSION_NAME}",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Spacer(Modifier.height(24.dp))

            Text(
                text = "About",
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
                    MetaRow("App version", BuildConfig.VERSION_NAME)
                    Spacer(Modifier.height(10.dp))
                    androidx.compose.material3.HorizontalDivider(
                        color = MaterialTheme.colorScheme.outline.copy(alpha = 0.25f),
                    )
                    Spacer(Modifier.height(10.dp))
                    MetaRow("Package", "dev.pulsewire.android")
                    Spacer(Modifier.height(10.dp))
                    androidx.compose.material3.HorizontalDivider(
                        color = MaterialTheme.colorScheme.outline.copy(alpha = 0.25f),
                    )
                    Spacer(Modifier.height(10.dp))
                    MetaRow("Server", state.serverUrl.ifBlank { "Not connected" })
                    Spacer(Modifier.height(10.dp))
                    androidx.compose.material3.HorizontalDivider(
                        color = MaterialTheme.colorScheme.outline.copy(alpha = 0.25f),
                    )
                    Spacer(Modifier.height(10.dp))
                    MetaRow("Min SDK", "Android 8.0 (API 26)")
                    Spacer(Modifier.height(10.dp))
                    androidx.compose.material3.HorizontalDivider(
                        color = MaterialTheme.colorScheme.outline.copy(alpha = 0.25f),
                    )
                    Spacer(Modifier.height(10.dp))
                    MetaRow("Target SDK", "Android 15 (API 35)")
                }
            }
            Spacer(Modifier.height(20.dp))

            Text(
                text = "Security",
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
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.Top,
                    ) {
                        Icon(
                            Icons.Filled.Info,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                            tint = MaterialTheme.colorScheme.primary,
                        )
                        Spacer(Modifier.width(8.dp))
                        Column(Modifier.weight(1f)) {
                            Text(
                                text = "Session token encrypted with Android Keystore.",
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            Text(
                                text = "Passwords, tokens, and message contents are never logged.",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    Spacer(Modifier.height(10.dp))
                    androidx.compose.material3.HorizontalDivider(
                        color = MaterialTheme.colorScheme.outline.copy(alpha = 0.25f),
                    )
                    Spacer(Modifier.height(10.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.Top,
                    ) {
                        Icon(
                            Icons.Filled.Info,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                            tint = MaterialTheme.colorScheme.primary,
                        )
                        Spacer(Modifier.width(8.dp))
                        Column(Modifier.weight(1f)) {
                            Text(
                                text = "Cleartext HTTP allowed for trusted LANs only.",
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            Text(
                                text = "Use HTTPS for any network you do not control.",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    Spacer(Modifier.height(10.dp))
                    androidx.compose.material3.HorizontalDivider(
                        color = MaterialTheme.colorScheme.outline.copy(alpha = 0.25f),
                    )
                    Spacer(Modifier.height(10.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.Top,
                    ) {
                        Icon(
                            Icons.Filled.Info,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                            tint = MaterialTheme.colorScheme.primary,
                        )
                        Spacer(Modifier.width(8.dp))
                        Column(Modifier.weight(1f)) {
                            Text(
                                text = "No local message cache.",
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            Text(
                                text = "All data lives on the server; this app is only a client.",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
            Spacer(Modifier.height(20.dp))

            Text(
                text = "Version ${BuildConfig.VERSION_NAME}",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
