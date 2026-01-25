import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    GeneratedPluginRegistrant.register(with: self)

    // Register the NDR FFI plugin for native Rust bindings
    NdrFfiPlugin.register(with: self.registrar(forPlugin: "NdrFfiPlugin")!)

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
