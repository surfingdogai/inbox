package ai.surfingdog.inbox;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

/** The app's one screen: the bundled screens in a WebView, and the app's own native plugin (ADR-026). */
public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(InboxNativePlugin.class);
    super.onCreate(savedInstanceState);
    Notifier.channels(this);
  }
}
