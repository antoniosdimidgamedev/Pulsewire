package dev.pulsewire.android.ui

import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

fun initials(name: String): String {
    val parts = name.trim().split(Regex("\\s+")).filter { it.isNotBlank() }
    val letters = parts.take(2).mapNotNull { it.firstOrNull()?.uppercaseChar() }
    return if (letters.isEmpty()) "?" else letters.joinToString("")
}

fun kindLabel(kind: String): String = when (kind) {
    "dm" -> "Direct"
    "group" -> "Group"
    "space" -> "Space"
    else -> "Conversation"
}

fun formatRelativeTime(iso: String?): String {
    if (iso.isNullOrBlank()) return ""
    val instant = runCatching { Instant.parse(iso) }.getOrNull() ?: return ""
    val seconds = Duration.between(instant, Instant.now()).seconds
    return when {
        seconds < 60 -> "now"
        seconds < 3_600 -> "${seconds / 60}m"
        seconds < 86_400 -> "${seconds / 3_600}h"
        seconds < 604_800 -> "${seconds / 86_400}d"
        else -> DateTimeFormatter.ofPattern("MMM d", Locale.getDefault())
            .withZone(ZoneId.systemDefault())
            .format(instant)
    }
}

fun formatMessageTime(iso: String?): String {
    if (iso.isNullOrBlank()) return ""
    val instant = runCatching { Instant.parse(iso) }.getOrNull() ?: return ""
    return DateTimeFormatter.ofPattern("MMM d, HH:mm", Locale.getDefault())
        .withZone(ZoneId.systemDefault())
        .format(instant)
}
