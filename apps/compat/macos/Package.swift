// swift-tools-version:5.9
// The compatibility suite's posthog-ios client (docs/engineering.md, "Real
// SDKs"): a macOS command-line target, since an iOS app cannot run on this
// machine. The SDK is pinned to the version docs/spec/posthog-protocol.md was
// read from.
import PackageDescription

let package = Package(
  name: "CompatMac",
  platforms: [.macOS(.v13)],
  dependencies: [
    .package(url: "https://github.com/PostHog/posthog-ios", exact: "3.92.0")
  ],
  targets: [
    .executableTarget(
      name: "CompatMac",
      dependencies: [.product(name: "PostHog", package: "posthog-ios")]
    )
  ]
)
