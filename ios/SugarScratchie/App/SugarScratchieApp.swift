import SwiftUI

@main
struct SugarScratchieApp: App {
    @State private var vm = SmokeViewModel()

    var body: some Scene {
        WindowGroup {
            ContentView(vm: vm)
                .preferredColorScheme(.light)
        }
    }
}
