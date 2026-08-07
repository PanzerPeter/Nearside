# R8 keep rules for the Nearside release build.
#
# Plan 1 Task 5 shipped closed testing with `minifyEnabled false` on purpose:
# a class R8 strips does not fail the build, it fails at runtime, months later,
# on somebody's phone. These are the rules that make it safe to turn on, and
# every one of them exists because the thing it protects is reached by
# reflection or by name from JavaScript rather than by a Java call R8 can see.

# Line numbers survive minification, so a Crashlytics stack trace still points
# at a line. Without this, every crash report is a list of `a.a.a(Unknown
# Source)` and the whole reason Crashlytics is in the build evaporates.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# Capacitor plugins are resolved by class name from a registry, and every
# @PluginMethod is invoked reflectively from the WebView bridge. R8 sees no
# caller for any of them.
-keep class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin public class * {
    @com.getcapacitor.PluginMethod public <methods>;
}
-keep public class * extends com.getcapacitor.Plugin { *; }

# Cordova plugins reach the same bridge by a different route — OneSignal ships
# as one, so this is not hypothetical.
-keep class org.apache.cordova.** { *; }
-keep public class * extends org.apache.cordova.CordovaPlugin { *; }

# The community and capawesome plugins this app uses: SQLite (the local
# decrypted mirror), secure storage (the identity key), the barcode scanner,
# the media library and the filesystem.
-keep class com.getcapacitor.community.** { *; }
-keep class io.capawesome.** { *; }
-keep class com.getcapacitor.plugin.** { *; }

# ML Kit resolves its barcode models dynamically. Without this the scanner
# reports "unavailable" on a release build and works fine on a debug one,
# which is the worst possible way to find out.
-keep class com.google.mlkit.** { *; }
-keep class com.google.android.gms.internal.mlkit_** { *; }
-dontwarn com.google.mlkit.**

# OneSignal registers receivers and services by name in the manifest and
# deserialises its payloads reflectively.
-keep class com.onesignal.** { *; }
-dontwarn com.onesignal.**

# RevenueCat deserialises the Play Billing responses into Kotlin data classes.
-keep class com.revenuecat.purchases.** { *; }
-keep class com.android.billingclient.** { *; }
-dontwarn com.revenuecat.purchases.**

# Firebase Crashlytics.
-keep class com.google.firebase.** { *; }
-dontwarn com.google.firebase.**

# Anything exposed to the WebView with @JavascriptInterface is called by name
# from JavaScript and has no Java caller at all.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Enum values() / valueOf() are used reflectively across most of the above.
-keepclassmembers enum * {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}

# Parcelable CREATOR fields are found by name by the framework.
-keepclassmembers class * implements android.os.Parcelable {
    public static final ** CREATOR;
}
