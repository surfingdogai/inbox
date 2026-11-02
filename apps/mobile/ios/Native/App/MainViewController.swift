import Capacitor
import UIKit

/// The app's one screen (ADR-028), the twin of MainActivity.java: the bundled screens in the web view, the
/// app's own native plugin, and a cover over them whenever they could be seen elsewhere.
///
/// Android's FLAG_SECURE keeps customers' names and words out of Recents, screenshots and recordings.
/// iOS has no such switch: here the app covers its screens before iOS takes the app switcher's picture
/// and while the screen is recorded or mirrored. A screenshot itself cannot be prevented on iPhone.
class MainViewController: CAPBridgeViewController {
  private let cover = UIView()

  override open func capacitorDidLoad() {
    bridge?.registerPluginInstance(InboxNativePlugin())
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    cover.backgroundColor = UIColor(red: 0xf6 / 255, green: 0xf5 / 255, blue: 0xff / 255, alpha: 1)
    cover.frame = view.bounds
    cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    cover.isHidden = true
    view.addSubview(cover)
    let center = NotificationCenter.default
    center.addObserver(self, selector: #selector(leaving), name: UIApplication.willResignActiveNotification, object: nil)
    center.addObserver(self, selector: #selector(back), name: UIApplication.didBecomeActiveNotification, object: nil)
    center.addObserver(self, selector: #selector(back), name: UIScreen.capturedDidChangeNotification, object: nil)
  }

  private var captured: Bool { view.window?.windowScene?.screen.isCaptured ?? false }

  /// Before iOS takes the app switcher's picture (the app is still "active" while this runs).
  @objc private func leaving() { show(true) }

  @objc private func back() { show(captured || UIApplication.shared.applicationState != .active) }

  private func show(_ covered: Bool) {
    view.bringSubviewToFront(cover)
    cover.isHidden = !covered
  }
}
