package dev.pulsewire.android.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val LightColors = lightColorScheme(
    primary = Color(0xFF0F766E),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFCCFBF1),
    onPrimaryContainer = Color(0xFF134E4A),
    secondary = Color(0xFF9A3412),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFFFEDD5),
    onSecondaryContainer = Color(0xFF7C2D12),
    background = Color(0xFFF8FAF9),
    onBackground = Color(0xFF17201F),
    surface = Color(0xFFF8FAF9),
    onSurface = Color(0xFF17201F),
    surfaceVariant = Color(0xFFE6EFED),
    onSurfaceVariant = Color(0xFF44514F),
    outline = Color(0xFF74827F),
    error = Color(0xFFB91C1C),
    onError = Color.White,
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF5EEAD4),
    onPrimary = Color(0xFF003731),
    primaryContainer = Color(0xFF115E59),
    onPrimaryContainer = Color(0xFFCCFBF1),
    secondary = Color(0xFFFDBA74),
    onSecondary = Color(0xFF4A2100),
    secondaryContainer = Color(0xFF6B330B),
    onSecondaryContainer = Color(0xFFFFEDD5),
    background = Color(0xFF0D1514),
    onBackground = Color(0xFFE3ECEA),
    surface = Color(0xFF0D1514),
    onSurface = Color(0xFFE3ECEA),
    surfaceVariant = Color(0xFF243230),
    onSurfaceVariant = Color(0xFFB9C7C4),
    outline = Color(0xFF849390),
    error = Color(0xFFFCA5A5),
    onError = Color(0xFF450A0A),
)

@Composable
fun PulsewireTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors,
        typography = Typography(),
        content = content,
    )
}
