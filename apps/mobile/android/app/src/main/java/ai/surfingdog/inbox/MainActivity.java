package ai.surfingdog.inbox;

import android.os.Bundle;
import android.view.WindowManager;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;

/** The app's one screen: the bundled screens in a WebView, and the app's own native plugin (ADR-028). */
public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    // The owner app's ground and mark while the app opens (values/styles.xml).
    SplashScreen.installSplashScreen(this);
    registerPlugin(InboxNativePlugin.class);
    super.onCreate(savedInstanceState);
    // Customers' names and words never land in the Recents thumbnail, a screenshot or a recording.
    getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
    Notifier.channels(this);
  }
}
