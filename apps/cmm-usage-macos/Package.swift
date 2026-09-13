// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "CMMUsageMacOS",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "CMMUsageCore", targets: ["CMMUsageCore"]),
        .executable(name: "CMMUsage", targets: ["CMMUsageApp"]),
        .executable(name: "CMMUsageContractTests", targets: ["CMMUsageContractTests"]),
    ],
    targets: [
        .target(name: "CMMUsageCore"),
        .executableTarget(name: "CMMUsageApp", dependencies: ["CMMUsageCore"]),
        .executableTarget(name: "CMMUsageContractTests", dependencies: ["CMMUsageCore"]),
        .testTarget(name: "CMMUsageCoreTests", dependencies: ["CMMUsageCore"]),
    ]
)
