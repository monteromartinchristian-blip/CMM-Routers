import SwiftUI
import CMMUsageCore

@main
struct CMMUsageDesktopApp: App {
    @StateObject private var model = UsageAppModel()

    var body: some Scene {
        MenuBarExtra {
            MenuBarUsageView()
                .environmentObject(model)
        } label: {
            Label("CMM Usage", systemImage: model.dashboard?.overallStatus.symbolName ?? "gauge.with.dots.needle.0percent")
        }
        .menuBarExtraStyle(.window)

        WindowGroup("CMM Usage", id: "main") {
            MainWindowView()
                .environmentObject(model)
                .frame(minWidth: 980, minHeight: 640)
                .task { await model.loadIfNeeded() }
        }
        .defaultSize(width: 1180, height: 760)
    }
}
