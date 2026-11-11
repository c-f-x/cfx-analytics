// The compatibility suite's posthog-ios client (docs/engineering.md, "Real
// SDKs"). Arguments: <api host> <token>.
//
// An iOS app cannot run on this machine, so the SDK is linked into a macOS
// command-line target with no bundle id (spike S2). Setup takes the token and
// the host and nothing else, as a consumer's app does. Then, in this order:
// screen(PLAN.ios.screen), capture(PLAN.ios.event), identify(PLAN.ios.user),
// alias(PLAN.ios.alias), flush(). The names match apps/compat/plan.mjs.
//
// It prints "CompatMac: sent" after the calls, then keeps the main run loop
// turning so the SDK's queue can send, until clients/ios.mjs stops it.
import Foundation
import PostHog

let arguments = CommandLine.arguments

guard arguments.count == 3 else {
    FileHandle.standardError.write(Data("usage: CompatMac <api host> <token>\n".utf8))
    exit(2)
}

let apiHost = arguments[1]
let projectToken = arguments[2]

// posthog-ios 3.92.0 names the project token `projectToken`; the old `apiKey`
// still builds but warns.
let config = PostHogConfig(projectToken: projectToken, host: apiHost)
PostHogSDK.shared.setup(config)

PostHogSDK.shared.screen("compat_ios_screen")
PostHogSDK.shared.capture("compat_ios_event", properties: ["plan": "compat"])
PostHogSDK.shared.identify("compat-ios-user", userProperties: ["email": "ios@example.test"])
PostHogSDK.shared.alias("compat-ios-alias")
PostHogSDK.shared.flush()

print("CompatMac: sent")
fflush(stdout)

// The SDK sends on the main queue, so the run loop has to keep turning until
// the run script stops us with SIGTERM.
RunLoop.main.run()
