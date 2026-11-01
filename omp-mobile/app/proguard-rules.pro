# WebView 的 JS 接口不能被混淆/裁剪
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class dev.ot.app.MainActivity { *; }
-keep class dev.ot.app.NotifyService { *; }
-keep class dev.ot.app.OtWsClient { *; }
-keep class dev.ot.app.LanScan { *; }
-dontwarn org.json.**
