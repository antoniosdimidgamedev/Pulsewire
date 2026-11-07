package dev.pulsewire.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.pulsewire.android.ui.AuthScreen
import dev.pulsewire.android.ui.AboutScreen
import dev.pulsewire.android.ui.ChatScreen
import dev.pulsewire.android.ui.ConversationsScreen
import dev.pulsewire.android.ui.MembersScreen
import dev.pulsewire.android.ui.NewConversationKind
import dev.pulsewire.android.ui.NewConversationScreen
import dev.pulsewire.android.ui.ProfileScreen
import dev.pulsewire.android.ui.PulsewireTheme
import dev.pulsewire.android.ui.SearchScreen
import dev.pulsewire.android.ui.SettingsScreen

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            PulsewireTheme {
                PulsewireApp()
            }
        }
    }
}

@Composable
fun PulsewireApp(vm: PulsewireViewModel = viewModel()) {
    val state = vm.state
    val snackbarHostState = remember { SnackbarHostState() }

    LaunchedEffect(state.notice) {
        val notice = state.notice ?: return@LaunchedEffect
        snackbarHostState.showSnackbar(notice)
        vm.consumeNotice()
    }

    BackHandler(enabled = vm.authenticated && vm.screen !is Screen.Conversations) {
        vm.goBack()
    }

    Scaffold(
        modifier = Modifier.fillMaxSize(),
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        snackbarHost = {
            SnackbarHost(
                hostState = snackbarHostState,
                modifier = Modifier.navigationBarsPadding(),
            )
        },
    ) { padding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            if (!vm.authenticated) {
                AuthScreen(
                    state = state,
                    savedHandles = vm.savedHandles,
                    onSignIn = vm::signIn,
                    onRegister = vm::register,
                    onHandleSelected = { handle -> },
                    onRemoveSavedHandle = vm::removeSavedHandle,
                )
            } else {
                when (val screen = vm.screen) {
                    Screen.Conversations -> ConversationsScreen(
                        state = state,
                        onOpenConversation = vm::openConversation,
                        onNewConversation = { vm.navigate(Screen.NewConversation(NewConversationKind.Direct)) },
                        onNewGroup = { vm.navigate(Screen.NewConversation(NewConversationKind.Group)) },
                        onSearch = { vm.navigate(Screen.Search) },
                        onProfile = vm::openProfile,
                        onRefresh = vm::refreshConversations,
                        onSettings = vm::openSettings,
                    )
                    is Screen.Chat -> ChatScreen(
                        state = state,
                        onBack = vm::goBack,
                        onMembers = { vm.openMembers(screen.conversationId) },
                        onLoadOlder = vm::loadOlderMessages,
                        onSend = vm::sendMessage,
                        onEdit = vm::editMessage,
                        onDelete = vm::deleteMessage,
                    )
                    is Screen.NewConversation -> NewConversationScreen(
                        state = state,
                        onBack = vm::goBack,
                        onSearchUsers = vm::searchUsers,
                        onCreate = vm::createConversation,
                        initialKind = screen.initialKind,
                    )
                    is Screen.Members -> MembersScreen(
                        state = state,
                        conversationId = screen.conversationId,
                        onBack = vm::goBack,
                        onAddMember = { vm.addMember(screen.conversationId, it) },
                        onRemoveMember = { vm.removeMember(screen.conversationId, it) },
                        onLeave = { vm.leaveConversation(screen.conversationId) },
                    )
                    Screen.Profile -> ProfileScreen(
                        state = state,
                        onBack = vm::goBack,
                        onSave = vm::updateProfile,
                        onSignOut = vm::signOut,
                    )
                    Screen.Search -> SearchScreen(
                        state = state,
                        onBack = vm::goBack,
                        onSearch = vm::search,
                        onOpenConversation = vm::openConversation,
                    )
                    Screen.Settings -> SettingsScreen(
                        state = state,
                        onBack = vm::goBack,
                        onSaveServerUrl = vm::saveServerUrl,
                        onSignOut = vm::signOut,
                        onAbout = vm::openAbout,
                    )
                    Screen.About -> AboutScreen(
                        state = state,
                        onBack = vm::goBack,
                    )
                }
            }
        }
    }
}
