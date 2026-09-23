import SwiftUI

struct ContentView: View {
    @Bindable var vm: SmokeViewModel

    var body: some View {
        Group {
            switch vm.screen {
            case .boot, .login:
                LoginView(vm: vm)
                    .ignoresSafeArea(.keyboard)
            case .session(let user):
                SessionView(vm: vm, user: user)
            }
        }
        .task {
            vm.bootstrap()
        }
    }
}
