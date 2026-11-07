package dev.pulsewire.android.data

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class PulsewireApiTest {
    @Test
    fun normalizeBaseUrlAddsSchemeAndRemovesTrailingSlash() {
        assertEquals(
            "http://192.168.1.10:8787",
            PulsewireApi.normalizeBaseUrl(" 192.168.1.10:8787/ "),
        )
        assertEquals(
            "https://chat.example.test",
            PulsewireApi.normalizeBaseUrl("https://chat.example.test/"),
        )
    }

    @Test
    fun normalizeBaseUrlRejectsEmptyInput() {
        try {
            PulsewireApi.normalizeBaseUrl("   ")
            fail("Expected an ApiException")
        } catch (error: ApiException) {
            assertEquals("Enter the Pulsewire server address.", error.message)
        }
    }

    @Test
    fun loginParsesSessionAndSendsCredentialsAsJson() = runBlocking {
        val server = MockWebServer()
        server.enqueue(
            MockResponse()
                .setHeader("content-type", "application/json")
                .setBody(
                    """{"user":{"id":"u1","displayName":"Alice","handle":"alice"},""" +
                        """"token":"secret-token","expiresAt":"2026-12-01T00:00:00.000Z"}""",
                ),
        )
        server.start()
        try {
            val api = PulsewireApi(server.url("/").toString())
            val auth = api.login("alice", "password123")

            assertEquals("alice", auth.user.handle)
            assertEquals("secret-token", auth.token)

            val request = server.takeRequest()
            assertEquals("POST", request.method)
            assertEquals("/v1/auth/login", request.path)
            assertTrue(request.body.readUtf8().contains("\"handle\":\"alice\""))
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun messageRequestUsesBearerTokenAndPaginationQuery() = runBlocking {
        val server = MockWebServer()
        server.enqueue(
            MockResponse()
                .setHeader("content-type", "application/json")
                .setBody("""{"messages":[],"hasMore":false}"""),
        )
        server.start()
        try {
            val api = PulsewireApi(server.url("/").toString(), token = "secret-token")
            val page = api.getMessages("c_1", limit = 25, before = 40)

            assertEquals(0, page.messages.size)
            val request = server.takeRequest()
            assertEquals("/v1/conversations/c_1/messages?limit=25&before=40", request.path)
            assertEquals("Bearer secret-token", request.getHeader("authorization"))
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun serverErrorsBecomeUserFacingApiExceptions() = runBlocking {
        val server = MockWebServer()
        server.enqueue(
            MockResponse()
                .setResponseCode(400)
                .setHeader("content-type", "application/json")
                .setBody("""{"error":{"code":"invalid_input","message":"That message is empty."}}"""),
        )
        server.start()
        try {
            val api = PulsewireApi(server.url("/").toString(), token = "secret-token")
            try {
                api.sendMessage("c_1", "hello")
                fail("Expected an ApiException")
            } catch (error: ApiException) {
                assertEquals(400, error.status)
                assertEquals("invalid_input", error.code)
                assertEquals("That message is empty.", error.message)
            }
        } finally {
            server.shutdown()
        }
    }
}
