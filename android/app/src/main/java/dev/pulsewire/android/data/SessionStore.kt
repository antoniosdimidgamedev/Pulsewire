package dev.pulsewire.android.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * Stores the server address in plain preferences and encrypts the session token
 * and cached user profile with an AES/GCM key held by the Android Keystore.
 */
class SessionStore(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun serverUrl(): String? = prefs.getString(KEY_SERVER, null)?.takeIf { it.isNotBlank() }

    fun token(): String? = readEncrypted(KEY_TOKEN)

    fun user(): User? = readEncrypted(KEY_USER)?.let { value ->
        runCatching { json.decodeFromString<User>(value) }.getOrNull()
    }

    fun saveSession(serverUrl: String, token: String, user: User) {
        prefs.edit()
            .putString(KEY_SERVER, serverUrl)
            .putString(KEY_TOKEN, encrypt(token))
            .putString(KEY_USER, encrypt(json.encodeToString(user)))
            .apply()
        saveHandle(user.handle)
    }

    fun saveServerUrl(serverUrl: String) {
        prefs.edit().putString(KEY_SERVER, serverUrl).apply()
    }

    fun savedHandles(): List<String> {
        return prefs.getString(KEY_SAVED_HANDLES, "")
            .split(",")
            .map { it.trim() }
            .filter { it.isNotBlank() }
            .distinct()
    }

    fun saveHandle(handle: String) {
        if (handle.isBlank()) return
        val current = savedHandles()
        val updated = (current + handle).distinct().take(10)
        prefs.edit().putString(KEY_SAVED_HANDLES, updated.joinToString(",")).apply()
    }

    fun removeHandle(handle: String) {
        val current = savedHandles()
        val updated = current.filter { it != handle }
        prefs.edit().putString(KEY_SAVED_HANDLES, updated.joinToString(",")).apply()
    }

    fun saveUser(user: User) {
        prefs.edit().putString(KEY_USER, encrypt(json.encodeToString(user))).apply()
    }

    fun clearSession() {
        prefs.edit().remove(KEY_TOKEN).remove(KEY_USER).apply()
    }

    private fun readEncrypted(key: String): String? {
        val stored = prefs.getString(key, null)?.takeIf { it.isNotBlank() } ?: return null
        return runCatching { decrypt(stored) }.getOrElse {
            prefs.edit().remove(key).apply()
            null
        }
    }

    private fun encrypt(plainText: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val encrypted = cipher.doFinal(plainText.toByteArray(StandardCharsets.UTF_8))
        val combined = cipher.iv + encrypted
        return Base64.encodeToString(combined, Base64.NO_WRAP)
    }

    private fun decrypt(stored: String): String {
        val combined = Base64.decode(stored, Base64.NO_WRAP)
        require(combined.size > IV_BYTES) { "Stored session is incomplete." }
        val iv = combined.copyOfRange(0, IV_BYTES)
        val encrypted = combined.copyOfRange(IV_BYTES, combined.size)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, iv))
        return String(cipher.doFinal(encrypted), StandardCharsets.UTF_8)
    }

    private fun secretKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val existing = keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry
        if (existing != null) return existing.secretKey

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    companion object {
        private const val PREFS_NAME = "pulsewire_session"
        private const val KEY_SERVER = "server_url"
        private const val KEY_TOKEN = "session_token"
        private const val KEY_USER = "session_user"
        private const val KEY_SAVED_HANDLES = "saved_handles"
        private const val KEY_ALIAS = "pulsewire.session.v1"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val IV_BYTES = 12
        private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
    }
}
