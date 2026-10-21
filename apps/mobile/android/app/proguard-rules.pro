# The internal build (ADR-028) is shrunk as a release would be. Capacitor's own rules come with its
# library (consumerProguardFiles); these keep what is reached by reflection or from the WebView.

# The bridge between the screens and the native side: Capacitor's classes, reached by name.
-keep class com.getcapacitor.** { *; }
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes *Annotation*,JavascriptInterface,Signature,InnerClasses,EnclosingMethod

# The app's own plugin, push service and keys: small, and named in the manifest and by Capacitor.
-keep class ai.surfingdog.inbox.** { *; }

# Stack traces in a crash report still say where.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
